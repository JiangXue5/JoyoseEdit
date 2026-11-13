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
  ) {
    super(message);
    this.name = 'RootBridgeError';
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
  try {
    result = await Promise.race([
      exec(cmd),
      new Promise<ExecResults>((_, reject) =>
        setTimeout(
          () => reject(new Error(`ksu.exec 超时（${KSU_TIMEOUT_MS}ms）`)),
          KSU_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    throw new RootBridgeError(
      `ksu.exec threw: ${(err as Error)?.message ?? String(err)}`,
      -1,
      '',
    );
  }
  if (result.errno !== 0) {
    throw new RootBridgeError(
      `shell exit ${result.errno}: ${result.stderr || result.stdout}`,
      result.errno,
      result.stderr ?? '',
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
}

export interface StatEntry {
  exists: boolean;
  path: string;
  mtime?: number;
  size?: number;
  uid?: number;
  gid?: number;
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
export async function resetCloud(): Promise<void> {
  await runKsu(`sh ${HELPER} reset-cloud`);
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
  /** Whether Joyose was confirmed dead before the file was replaced.
   * Absent on an older installed helper. */
  stopped?: boolean;
}

/** SHA-256 as lowercase hex, or null when the WebView has no crypto.subtle
 *  (KernelSU's WebUI is not always a secure context). The size check below is
 *  the mandatory guard; the digest is an extra one when it is available. */
async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

export async function push(which: DbSelector, bytes: Uint8Array): Promise<WriteResult> {
  assertSelector(which);
  const b64 = bytesToBase64(bytes);
  const stage = `push-${which}-${Date.now().toString(36)}`;
  await stageUpload(stage, b64);
  const sha = await sha256Hex(bytes);
  // The helper verifies the decoded length (and digest when provided) before
  // it touches the live database, so a truncated upload can never be swapped in.
  const args = [`push-from-stage`, which, stage, String(bytes.length)];
  if (sha) args.push(sha);
  return JSON.parse(await runKsu(`sh ${HELPER} ${args.join(' ')}`));
}

export async function backup(label?: string): Promise<{
  ok: true;
  dir: string;
  name: string;
  stopped?: boolean;
}> {
  const safe = label ? sanitizeLabel(label) : '';
  const cmd = safe ? `sh ${HELPER} backup ${safe}` : `sh ${HELPER} backup`;
  const out = await runKsu(cmd);
  return JSON.parse(out);
}

export interface RevertResult {
  ok: true;
  from: string;
  stopped?: boolean;
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
}

export async function tegStatus(): Promise<TegStatus> {
  return JSON.parse(await runKsu(`sh ${HELPER} teg-status`));
}

/** Pin `pref_local_max_version` to `Long.MAX_VALUE`, stopping teg SDK
 * from ever accepting a cloud update. Force-stops Joyose first so the
 * in-process SharedPreferences cache is dropped. */
export async function tegFreeze(): Promise<{ ok: true; path: string; pref_local_max_version: string }> {
  return JSON.parse(await runKsu(`sh ${HELPER} teg-freeze`));
}

/** Reset `pref_local_max_version` to 0, re-enabling teg cloud updates. */
export async function tegUnfreeze(): Promise<{ ok: true; path: string; pref_local_max_version: string }> {
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
