// Root bridge: every call the WebUI makes to shell-level Joyose operations
// funnels through here. The module ships bin/joyose-edit.sh with a hard-coded
// subcommand whitelist; this TS layer mirrors that whitelist so wrong-named
// calls fail at build time, not at runtime.
//
// We use the official `kernelsu` npm package (v3.0.2+) for the `exec` bridge.
// Its ExecOptions deliberately does NOT expose stdin — so any subcommand that
// used to take data via stdin (push / history-save) now takes a base64
// argument instead. Modern Android (Android 11+, where KernelSU runs) has
// ARG_MAX >= 2 MB, comfortably above our largest payloads (~1 MB for the
// teg_config.db mirror on a K90 Pro Max sample).

import { exec } from 'kernelsu';
import type { DbSelector } from '@/db/constants';
import { base64ToBytes, bytesToBase64 } from '@/db/dbio';

// The kernelsu package declares `ExecResults` internally but doesn't export
// it. Derive the type from the function signature instead.
type ExecResults = Awaited<ReturnType<typeof exec>>;

export class RootBridgeUnavailable extends Error {
  constructor() {
    super('ksu.exec is not available — open this WebUI inside the KernelSU manager.');
    this.name = 'RootBridgeUnavailable';
  }
}

export class RootBridgeError extends Error {
  constructor(
    message: string,
    public readonly errno: number,
    public readonly stderr: string,
    /** Machine-readable reason from the helper (`incomplete-backup`,
     *  `recovery-required`, …). Matching on the message text instead would
     *  break the moment a message is reworded. */
    public readonly code?: string,
    /** `true` / `false` / `not-needed`: what happened to Joyose on the way out.
     *  Absent on an older installed helper. */
    public readonly serviceRestore?: string,
  ) {
    super(message);
    this.name = 'RootBridgeError';
  }
}

/** The helper prints a JSON object on stderr for every fatal error. Showing
 *  that object verbatim ("shell exit 1: {"ok":false,...}") is unreadable and
 *  throws away the fields the UI needs. */
function parseHelperError(stderr: string): { message?: string; code?: string; serviceRestore?: string } {
  const text = stderr.trim();
  if (!text.startsWith('{')) return {};
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    return {
      message: typeof obj.error === 'string' ? obj.error : undefined,
      code: typeof obj.code === 'string' ? obj.code : undefined,
      serviceRestore: typeof obj.serviceRestore === 'string' ? obj.serviceRestore : undefined,
    };
  } catch {
    return {};
  }
}

const HELPER = '/data/adb/modules/joyose-edit/bin/joyose-edit.sh';

export function isKsuAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).ksu?.exec === 'function'
  );
}

/** Thin wrapper around `exec` from `kernelsu`: surfaces shell non-zero as a
 * typed rejection, maps the missing-bridge case to RootBridgeUnavailable,
 * and enforces a hard timeout so a hung bridge can't lock the UI. */
const KSU_TIMEOUT_MS = 30000;

async function runKsu(cmd: string): Promise<string> {
  if (!isKsuAvailable()) throw new RootBridgeUnavailable();
  let result: ExecResults;
  // Cleared in `finally`. Without it every successful call left a live 30 s
  // timer behind; a chunked upload fires ~30 calls per MB, so a single commit
  // could leave hundreds of pending timers in the WebView.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      exec(cmd),
      new Promise<ExecResults>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ksu.exec 超时（${KSU_TIMEOUT_MS}ms）`)),
          KSU_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // A timeout is our own guard, not a bridge crash. Wrapping it produced
    // "ksu.exec threw: ksu.exec 超时（30000ms）" — the same thing twice, in the
    // one message the user is most likely to read.
    throw new RootBridgeError(
      msg.startsWith('ksu.exec 超时') ? msg : `ksu.exec threw: ${msg}`,
      -1,
      '',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result.errno !== 0) {
    const parsed = parseHelperError(result.stderr ?? '');
    throw new RootBridgeError(
      parsed.message ?? `shell exit ${result.errno}: ${result.stderr || result.stdout}`,
      result.errno,
      result.stderr ?? '',
      parsed.code,
      parsed.serviceRestore,
    );
  }
  return result.stdout ?? '';
}

/* -------------------------------------------------------------------------
 * Typed subcommands. Arguments are validated up-front so we never pass
 * arbitrary user text to the shell.
 * ------------------------------------------------------------------------- */

export interface StatResult {
  ok: true;
  pkg: string;
  data_root: string;
  smartp: StatEntry;
  teg: StatEntry;
  backup_count: number;
  history_count: number;
  /** A pair write was interrupted and nothing has resolved it yet. Every
   *  mutating command repairs or refuses before it runs, so this should only be
   *  seen between the crash and the next write. */
  pending?: boolean;
  /** Last automatic resolution of an interrupted pair write. */
  recovery?: { kind: string; at: number } | null;
  /** A write stopped Joyose and never started it again (front-end timeout,
   *  WebView closed, shell killed). The UI owes the user a start; this is not
   *  "is Joyose running", which would need a probe of its own. Absent on an
   *  older installed helper. */
  service_stopped?: boolean;
}

export interface StatEntry {
  exists: boolean;
  path: string;
  mtime?: number;
  size?: number;
  uid?: number;
  gid?: number;
  /** `rollback` | `wal` | '' — read from the file header, so it needs neither
   *  sqlite3 nor a running process. Absent on an older installed helper. */
  journal?: string;
  /** A non-empty `-wal` is present: committed rows that a file copy would miss.
   *  Every mutating path refuses while this is true. */
  wal_pending?: boolean;
}

export async function stat(): Promise<StatResult> {
  const out = await runKsu(`sh ${HELPER} stat`);
  return JSON.parse(out);
}

/** Timestamp stamped by customize.sh on a fresh install / reinstall. The WebUI
 *  compares it against its own localStorage copy to decide whether to drop the
 *  per-device preferences. Returns "0" when the helper is too old to know the
 *  subcommand. */
export async function moduleInstallTs(): Promise<string> {
  try {
    return (await runKsu(`sh ${HELPER} install-ts`)).trim();
  } catch {
    return '0';
  }
}

/** Read the WebUI settings file the helper keeps under /data/adb. Returns '{}'
 *  when the module was installed before the subcommand existed. Unlike
 *  localStorage this survives a WebView data reset or a manager switch. */
export async function readPrefs(): Promise<string> {
  try {
    return (await runKsu(`sh ${HELPER} prefs-read`)).trim() || '{}';
  } catch {
    return '{}';
  }
}

/** Replace the settings file atomically. The payload is a small JSON object, so
 *  it travels as an argv-safe base64 string like every other write. */
export async function writePrefs(json: string): Promise<void> {
  const b64 = bytesToBase64(new TextEncoder().encode(json));
  await runKsu(`sh ${HELPER} prefs-write ${b64}`);
}

/** Wipe Joyose's app data and wake its cloud services so the config is
 *  re-downloaded. Destructive: every local Joyose setting goes with it, so the
 *  caller must confirm first. */
export interface ResetCloudResult {
  ok: boolean;
  /** True only when `pm clear` itself succeeded — the data is really gone. */
  cleared: boolean;
  /** Steps that returned non-zero, by helper-side name. */
  failed: string[];
}

export async function resetCloud(): Promise<ResetCloudResult> {
  const out = (await runKsu(`sh ${HELPER} reset-cloud`)).trim();
  try {
    const parsed = JSON.parse(out) as ResetCloudResult;
    return {
      ok: parsed.ok === true,
      cleared: parsed.cleared === true,
      failed: Array.isArray(parsed.failed) ? parsed.failed : [],
    };
  } catch {
    // An older helper printed a bare `ok`; treat that as success with no detail.
    if (out === 'ok') return { ok: true, cleared: true, failed: [] };
    throw new RootBridgeError(`reset-cloud 输出无法解析：${out.slice(0, 120)}`, 0, '');
  }
}

export interface DigestResult {
  ok: true;
  /** sha256 of the DB file, or null when it does not exist. */
  smartp: string | null;
  teg: string | null;
}

/** Content digest of both DBs, used as the conflict-detection baseline.
 * mtime has one-second resolution and size rarely moves for an in-place JSON
 * edit, so a stat-based fingerprint misses same-second rewrites. */
export async function digest(): Promise<DigestResult> {
  return JSON.parse(await runKsu(`sh ${HELPER} digest`));
}

export async function pull(which: DbSelector): Promise<Uint8Array> {
  assertSelector(which);
  const out = await runKsu(`sh ${HELPER} pull ${which}`);
  return base64ToBytes(out.trim());
}

export interface WriteResult {
  ok: true;
  path: string;
  uid?: number;
  gid?: number;
  /** Whether the helper confirmed the consumer was gone before the swap.
   *  Says nothing about the final process state — see `wasRunning` and the
   *  result of `restart()`. Absent on an older installed helper. */
  stopConfirmed?: boolean;
  /** Whether Joyose was up before the helper quiesced it. Absent on an older
   *  installed helper. */
  wasRunning?: boolean;
  /** Legacy field name used by helpers that predate `stopConfirmed`. Read it
   *  as a fallback, never as the final process state. */
  stopped?: boolean;
  /** SHA-256 of the file after the swap. Empty when the ROM ships no
   *  sha256sum — that means "not verified", never "matches". */
  sha256?: string;
  /** How the post-write integrity check ran: `sqlite3` is a full
   *  `PRAGMA quick_check`, `geometry` is the header + page-count fallback used
   *  when the ROM has no sqlite3 binary. */
  verified?: 'sqlite3' | 'geometry';
  /** How the pre-swap rollback copy was verified. `size` means the ROM has no
   *  digest tool, so only the length was compared. */
  rollback?: 'sha256' | 'size';
  /** What the uploaded bytes were checked against before the swap: `sha256`
   *  when the WebView could compute a digest, `length` when it could not.
   *  A `length` write is not wrong, it is just weaker — and it used to be
   *  indistinguishable from a digest-verified one. */
  verifiedBy?: 'sha256' | 'length' | 'none';
  /** Whether the live file was re-hashed immediately before the swap. False
   *  when no digest was available, which is exactly when a concurrent cloud
   *  push would slip through. */
  liveChecked?: boolean;
  /** Result of re-applying the SELinux label: `applied` / `unsupported` /
   *  `failed` / `unverified`. Empty on an older installed helper. */
  labelRestored?: string;
}

/** SHA-256 as lowercase hex, or null when the WebView has no crypto.subtle
 *  (KernelSU's WebUI is not always a secure context). The size check below is
 *  the mandatory guard; the digest is an extra one when it is available. */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

export async function push(
  which: DbSelector,
  bytes: Uint8Array,
  opts: { expectCurrent?: string | null } = {},
): Promise<WriteResult> {
  assertSelector(which);
  const b64 = bytesToBase64(bytes);
  const stage = `push-${which}-${Date.now().toString(36)}`;
  await stageUpload(stage, b64);
  const sha = await sha256Hex(bytes);
  // The helper verifies the decoded length (and digest when provided) before
  // it touches the live database, so a truncated upload can never be swapped in.
  const args = [`push-from-stage`, which, stage, String(bytes.length), sha ?? 'none'];
  // Digest of the file as we read it. The helper re-hashes the live file right
  // before the swap and refuses if it moved — closes the window between our
  // conflict check and the actual write.
  if (opts.expectCurrent) args.push(opts.expectCurrent);
  return JSON.parse(await runKsu(`sh ${HELPER} ${args.join(' ')}`));
}

export interface LockStatus {
  locked: boolean;
  /** A lock directory exists but its owner is gone (or the pid was recycled). */
  stale?: boolean;
  pid?: number;
  ageSeconds?: number;
  op?: string;
  /** Held longer than the TTL but still owned by a live process. Informational:
   *  the lock is NOT free, it is only slow. */
  overdue?: boolean;
}

/** Whether a write is currently running on the device. Used after a front-end
 *  timeout: the Promise may have been rejected while the shell command is
 *  still going, and letting the user retry into that would interleave writes. */
export async function lockStatus(): Promise<LockStatus> {
  return JSON.parse(await runKsu(`sh ${HELPER} lock-status`));
}

/** Replace SmartP and teg in one device-side transaction.
 *
 *  Two separate `push()` calls are not a transaction: if the second one fails,
 *  the first database stays changed while the UI reports the commit as failed.
 *  The helper's `push-pair-from-stage` stages and verifies both candidates,
 *  stops Joyose once, keeps a rollback copy of each live file, swaps both, and
 *  puts both back on any failure. */
export interface PairWriteResult {
  ok: true;
  stopConfirmed?: boolean;
  wasRunning?: boolean;
  verified?: string;
  atomic?: boolean;
  verifiedBy?: 'sha256' | 'length';
  label?: { smartp: string; teg: string };
}

export async function pushPair(
  smartp: Uint8Array,
  teg: Uint8Array,
  opts: { smartpExpect?: string | null; tegExpect?: string | null } = {},
): Promise<PairWriteResult> {
  const stamp = Date.now().toString(36);
  const spStage = `pair-sp-${stamp}`;
  const tegStage = `pair-teg-${stamp}`;
  await stageUpload(spStage, bytesToBase64(smartp));
  await stageUpload(tegStage, bytesToBase64(teg));
  const spSha = await sha256Hex(smartp);
  const tegSha = await sha256Hex(teg);
  const args = [
    'push-pair-from-stage',
    spStage,
    tegStage,
    String(smartp.length),
    spSha ?? 'none',
    opts.smartpExpect || 'none',
    String(teg.length),
    tegSha ?? 'none',
    opts.tegExpect || 'none',
  ];
  return JSON.parse(await runKsu(`sh ${HELPER} ${args.join(' ')}`));
}

export interface BackupResult {
  ok: true;
  dir: string;
  name: string;
  /** Whether Joyose was confirmed stopped before the snapshot. */
  stopped?: boolean;
  /** Whether it was running before we quiesced it. */
  wasRunning?: boolean;
  /** Whether it was brought back afterwards (manual backups only). */
  restarted?: boolean;
}

export async function backup(
  label?: string,
  opts: { restore?: boolean } = {},
): Promise<BackupResult> {
  const safe = label ? sanitizeLabel(label) : '';
  const parts = [`sh ${HELPER} backup`];
  if (safe) parts.push(safe);
  // A commit takes its backup right before writing, and the write path
  // restarts Joyose itself — asking the helper to start it here would add a
  // cold start to every commit.
  if (opts.restore === false) parts.push('--no-restore');
  return JSON.parse(await runKsu(parts.join(' ')));
}

export interface RevertResult {
  ok: true;
  from: string;
  stopped?: boolean;
  /** Whether Joyose was running before the restore. */
  wasRunning?: boolean;
  /** Whether it was started again afterwards. */
  restarted?: boolean;
  /** Databases present in the backup but absent on the device, so they were
   *  not restored. Non-empty means the result is a partial restore and the
   *  user should be told which side was skipped. */
  skipped?: string;
  /** True when the backup predates the completeness marker, so its contents
   *  could not be checked against what was recorded at snapshot time. */
  legacy?: boolean;
  /** Per-database SELinux relabel outcome. */
  label?: { smartp: string; teg: string };
}

export async function revert(name: string): Promise<RevertResult> {
  return JSON.parse(await runKsu(`sh ${HELPER} revert ${sanitizeLabel(name, true)}`));
}

export async function revertLatest(): Promise<RevertResult> {
  return JSON.parse(await runKsu(`sh ${HELPER} revert-latest`));
}

export interface RestartResult {
  ok: true;
  pkg: string;
  /** Whether the process was confirmed gone, not just "am did not throw". */
  stopped?: boolean;
  /** Whether Joyose came back up and therefore re-read the DBs. */
  started?: boolean;
  /** Set when nothing was started on purpose: `not-running` means the user had
   *  Joyose off before this operation, so it was left off. */
  skipped?: string;
}

export async function restart(): Promise<RestartResult> {
  return JSON.parse(await runKsu(`sh ${HELPER} restart`));
}

export async function historyList(): Promise<string[]> {
  const out = await runKsu(`sh ${HELPER} history-list`);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function historyGet(name: string): Promise<string> {
  return runKsu(`sh ${HELPER} history-get ${sanitizeLabel(name, true)}`);
}

export async function historySave(name: string, body: string): Promise<{ ok: true; path: string }> {
  const safeName = sanitizeLabel(name, true);
  const b64 = utf8ToBase64(body);
  const stage = `hist-${Date.now().toString(36)}`;
  await stageUpload(stage, b64);
  return JSON.parse(await runKsu(`sh ${HELPER} history-save-from-stage ${safeName} ${stage}`));
}

/** Write a text payload to the fixed export folder
 *  `/sdcard/Download/joyose-edit/<name>` and return the exact path. Goes
 *  through the root helper instead of a Blob download, because KernelSU's
 *  WebView does not reliably honour `a.download`. */
export async function exportFile(
  name: string,
  body: string,
): Promise<{ ok: true; path: string }> {
  const safeName = sanitizeLabel(name, true);
  const b64 = utf8ToBase64(body);
  const stage = `dl-${Date.now().toString(36)}`;
  await stageUpload(stage, b64);
  return JSON.parse(await runKsu(`sh ${HELPER} save-dl-from-stage ${safeName} ${stage}`));
}

/**
 * Upload a base64 blob to the module's staging area in bounded-size chunks.
 * A single shell `argv` is capped by the kernel's ARG_MAX (as little as
 * ~128 KB on some Android builds — Xiaomi 17 Pro Max ships a shell that
 * rejects ~100 KB+ args with "Argument list too long"), so we split the
 * payload and append piece-by-piece.
 *
 * 48 KB per chunk keeps a fat safety margin under any realistic ARG_MAX,
 * and a 320 KB DB → 14 chunks → ~1s total is fine for a write operation.
 */
const STAGE_CHUNK_BYTES = 48 * 1024;

async function stageUpload(stage: string, b64: string): Promise<void> {
  const safe = sanitizeLabel(stage, true);
  await runKsu(`sh ${HELPER} stage-clear ${safe}`);
  for (let offset = 0; offset < b64.length; offset += STAGE_CHUNK_BYTES) {
    const chunk = b64.slice(offset, offset + STAGE_CHUNK_BYTES);
    await runKsu(`sh ${HELPER} stage-append ${safe} ${chunk}`);
  }
}

export async function historyClear(keep: number): Promise<{ ok: true; kept: number }> {
  if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer');
  return JSON.parse(await runKsu(`sh ${HELPER} history-clear ${keep}`));
}

/** Read sql-wasm.wasm bytes from the installed module's webroot via the root
 * bridge. Used as a fallback when the WebView's own asset handler rejects
 * .wasm fetches (some KernelSU Manager builds serve them with the wrong
 * MIME type, which sql.js sees as "both async and sync fetching failed"). */
export async function readWasm(): Promise<Uint8Array> {
  const out = await runKsu(`sh ${HELPER} cat-wasm`);
  return base64ToBytes(out.trim());
}

export interface VisionStatus {
  ok: true;
  /** Value of `ro.vendor.gpp.frc.support`. Empty string = prop not set. */
  frc_support: string;
  /** Value of `ro.vendor.xiaomi.sr.support`. Empty string = prop not set. */
  sr_support: string;
}

/** Read the two vendor props that gate com.miui.securitycenter's
 * `GameBoxVisionEnhanceUtils.needInitService()` checks. If either is not
 * `"true"`, the HyperOS game assistant refuses to render the FI / SR controls
 * regardless of what's in Joyose's cloud DB. MifisrView surfaces this state
 * as a banner so the user knows the real blocker is at the vendor-flag layer,
 * not the cloud config. */
export async function visionStatus(): Promise<VisionStatus> {
  return JSON.parse(await runKsu(`sh ${HELPER} vision-status`));
}

export interface SystemInfo {
  ok: true;
  /** `ro.build.version.release`; empty when the ROM does not expose it. */
  android: string;
  /** `ro.mi.os.version.name`, falling back to `ro.miui.ui.version.name`. */
  hyperos: string;
  /** Installed Joyose versionName; empty when dumpsys is unavailable. */
  joyose: string;
  /** `version=` from the module's own module.prop. */
  module: string;
}

/** Version facts for the diagnosis page. Absent values come back as empty
 *  strings, never as an error: a report that says "unknown" for one field is
 *  more useful than one that fails entirely. */
export async function systemInfo(): Promise<SystemInfo> {
  return JSON.parse(await runKsu(`sh ${HELPER} system-info`));
}

/* ---- teg SDK cloud-fetch freeze ------------------------------------------
 * Joyose's runtime config is driven by the MIUI teg cloud-config SDK
 * (com.xiaomi.teg.config). teg tracks its own `pref_local_max_version` in
 * a SharedPreferences XML; every ~13 min (or on broadcast) it POSTs that
 * version to the server and rewrites teg_config.db from the server delta
 * WITHOUT any per-rule version check. Locking the in-DB version columns
 * therefore does NOT stop cloud overwrites. The real escape hatch is to
 * pin the SDK's local max to Long.MAX_VALUE so the server can never
 * out-version it. These bridge calls expose that escape hatch via the
 * helper shell.
 * ------------------------------------------------------------------------ */

export interface TegStatus {
  ok: true;
  /** Whether Joyose has ever initialised the teg SDK SP file. */
  exists: boolean;
  /** Absolute path to `teg_config_pref.xml`. */
  path: string;
  /** Current pref_local_max_version as a string (JSON can't hold long precisely). */
  pref_local_max_version?: string;
  /** True iff `pref_local_max_version == Long.MAX_VALUE`. */
  frozen?: boolean;
  /** Value saved before freezing; unfreeze restores this (empty when none). */
  original?: string;
}

export async function tegStatus(): Promise<TegStatus> {
  return JSON.parse(await runKsu(`sh ${HELPER} teg-status`));
}

export interface TegRewriteResult {
  ok: true;
  path: string;
  pref_local_max_version: string;
  mode: 'freeze' | 'unfreeze';
  /** Pre-freeze value that unfreeze restores. */
  original?: string;
  wasRunning?: boolean;
  stopped?: boolean;
  restarted?: boolean;
  frozen?: boolean;
}

/** Pin `pref_local_max_version` to `Long.MAX_VALUE`, stopping teg SDK
 * from ever accepting a cloud update. Stops Joyose first (the SP cache lives
 * in the process), verifies the write by reading the file back, and restarts
 * it when it was running. */
export async function tegFreeze(): Promise<TegRewriteResult> {
  return JSON.parse(await runKsu(`sh ${HELPER} teg-freeze`));
}

/** Put back the value that was saved before freezing (0 only when no saved
 * value exists), re-enabling teg cloud updates. */
export async function tegUnfreeze(): Promise<TegRewriteResult> {
  return JSON.parse(await runKsu(`sh ${HELPER} teg-unfreeze`));
}

/* -------------------------------------------------------------------------
 * Guards — reject any input that could escape the shell whitelist.
 * ------------------------------------------------------------------------- */

const SAFE = /^[A-Za-z0-9._-]+$/;

function sanitizeLabel(label: string, required = false): string {
  const trimmed = label.trim();
  if (required && !trimmed) throw new Error('label is required');
  if (!SAFE.test(trimmed)) throw new Error(`invalid label: "${label}" — only A-Z a-z 0-9 . _ - allowed`);
  return trimmed;
}

function assertSelector(x: DbSelector): void {
  if (x !== 'smartp' && x !== 'teg') throw new Error(`invalid db selector: ${x}`);
}

function utf8ToBase64(text: string): string {
  // TextEncoder → btoa keeps non-ASCII characters safe.
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}
