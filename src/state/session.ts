// Central reactive store for the WebUI. Holds the pulled DB bytes, the parsed
// working copies of cloud_config.params / teg_config.rule_content, and the
// side-band metadata (stat, path status, dirty flag). All views read / mutate
// through this module, so there is exactly one place where a `push` is
// constructed.

import { reactive, computed } from 'vue';
import type { Database } from 'sql.js';

import * as bridge from '@/root/bridge';
import {
  openDb,
  closeDb,
  exportDb,
  listCloudConfig,
  listRules,
  latestRuleIdForModule,
  updateCloudConfigParams,
  updateRuleContentById,
} from '@/db/dbio';
import {
  applyLockedOriginals,
  commitOutcome,
  mergeOntoRaw,
  pickSmartpVersion,
} from '@/db/merge';
import { isEmptyCloudParams, parseCloudConfigRows, type ParseIssue } from '@/db/parse-rows';
import {
  currentRuleRow,
  planSmartpWrites,
  applySmartpWrites,
  planTegWrites,
  applyTegWrites,
} from '@/db/commit-writes';
import {
  detectActiveBackend,
  detectPaths,
  fingerprint,
  parseParams,
  stringifyParams,
  type ActiveBackend,
  type V3PathStatus,
} from '@/db/schema';
import {
  DriverBackedStore,
  snapshotFromMaps,
  buildRecord,
  nextSeq,
  buildHistoryFilename,
  parseHistoryFilename,
  type ConfigSnapshot,
  type DbDigests,
  type HistoryFileMeta,
  type HistoryRecord,
  type HistorySource,
} from '@/history/store';
import { diff } from '@/history/diff';
import { planRebase } from '@/history/rebase-plan';
import { planRestore } from '@/history/restore-plan';
import { makeResult, commitCode, type OperationResult } from '@/state/result';
import { refreshEnvelope } from '@/history/envelope';
import {
  pickBoosterParams,
  latestEnvelopeVersion,
  getDataSourcePref,
  getBoosterSourcePref,
  getCommonSourcePref,
  getWriteTarget,
  getStoredInstallTs,
  storeInstallTs,
  resetAllPrefs,
  hydratePrefs,
  prefsFileExisted,
  whenPrefsPersisted,
  getHistoryFloor,
  setHistoryFloor,
  getLockedVersions,
  setLockedVersion,
  clearLockedVersion,
} from '@/state/source';

/** Re-exported so views can keep importing it from the store that owns the
 *  rules, while the implementation lives next to the write planner that needs
 *  the same "current revision" rule. */
export { currentRuleRow };

export interface SessionState {
  connected: boolean;
  loading: boolean;
  lastError: string | null;
  stat: bridge.StatResult | null;
  /** Last-observed DB fingerprints, to detect concurrent modification. */
  baselineSmartp: string | null;
  baselineTeg: string | null;
  /** Parsed cloud_config rows by name. Each value is the parsed `params` JSON. */
  cloudConfig: Record<string, any>;
  /** Raw deep copy of SmartP's cloud_config.params, untouched by the
   *  source-selection / teg-fallback reconciliation. The JSON editor's
   *  SmartP_* targets read and write this: the target really is SmartP. */
  smartpRaw: Record<string, any>;
  /** Parsed rule_content JSON arrays grouped by rule_module. */
  rulesByModule: Record<string, any[]>;
  /** Rows whose JSON could not be parsed. A broken row keeps its metadata and
   *  is reported to the UI instead of aborting the whole pull: one malformed
   *  cloud_config row used to blank every page. */
  parseIssues: ParseIssue[];
  /** V3 path detection result (refreshed whenever booster_config is re-parsed). */
  paths: V3PathStatus[];
  /** Which insertion backend this device actually uses. Drives which editor
   * panel the UI surfaces. `null` until a pull completes or when no backend
   * is detectable (e.g. unrelated ROM). */
  activeBackend: ActiveBackend;
  /** The on-disk base: the working copy as it was at the last successful
   *  pull/commit. This is the single `before` for history records and for the
   *  merge in pushCore. (The other copies have narrower jobs: `cloudConfig` /
   *  `rulesByModule` are the *working* copy the UI edits, `smartpRaw` is
   *  SmartP's own bytes for the JSON editor's SmartP_* targets.) It is not
   *  called "pristine" in the sense of "untouched by the user" — the name is
   *  kept for compatibility. */
  pristineSnapshot: ReturnType<typeof snapshotFromMaps> | null;
  dirty: boolean;
  /** Outcome of the last write: whether Joyose was confirmed stopped, and
   *  whether it was brought back afterwards (i.e. it has already re-read the
   *  DBs, so the next game launch picks the edit up). `null` while unknown
   *  (helper too old to report it).
   *
   *  Four separate facts, because one boolean kept being read as another:
   *  "we confirmed it stopped" is not "it is stopped now", and "we asked it to
   *  start" is not "it came back". */
  applyStatus: {
    /** Helper confirmed the consumer was gone before the swap. */
    stopConfirmed: boolean | null;
    /** Whether it was up before we quiesced it. */
    wasRunningBefore: boolean | null;
    /** Whether a restart was actually issued. */
    restartAttempted: boolean;
    /** Whether it was observed running again; null when not attempted/failed. */
    startedAfter: boolean | null;
    at: number;
  } | null;
  /** When the last commit had to rebase onto a fresher DB, the timestamp of
   *  that merge; null when the last commit applied directly. */
  rebasedAt: number | null;
}

export const state = reactive<SessionState>({
  connected: false,
  loading: false,
  lastError: null,
  stat: null,
  baselineSmartp: null,
  baselineTeg: null,
  cloudConfig: {},
  smartpRaw: {},
  rulesByModule: {},
  parseIssues: [],
  paths: [],
  activeBackend: null,
  pristineSnapshot: null,
  dirty: false,
  applyStatus: null,
  rebasedAt: null,
});

export const isReady = computed(
  () => state.connected && state.stat !== null && !state.loading,
);

export async function initialize(): Promise<void> {
  if (!bridge.isKsuAvailable()) {
    state.lastError =
      '未检测到 KernelSU 环境，请在 KernelSU 管理器中打开本模块的 WebUI。';
    state.connected = false;
    return;
  }
  state.connected = true;
  await refreshStat();
  // A write that was interrupted (app closed, shell killed, phone rebooted
  // mid-commit) may have left Joyose stopped. Opening the WebUI is often the
  // first thing that happens afterwards, so this is where it gets fixed.
  await rescueStoppedService('上一次写入没有正常结束');
  // Preferences come from the module's settings file (localStorage is only a
  // cache and a WebView data reset — or a manager switch, which changes the
  // WebUI origin — used to wipe them back to the defaults).
  await hydratePrefs();
  // A fresh flash / reinstall / upgrade stamps a marker; when it moved, drop
  // the per-device preferences (write target back to `both`, …) so a WebView
  // localStorage left over from the previous install cannot silently persist.
  try {
    const ts = await bridge.moduleInstallTs();
    if (ts && ts !== '0' && ts !== getStoredInstallTs()) {
      if (prefsFileExisted()) {
        resetAllPrefs();
      }
      // Always record the marker: on the first run of this build the file is
      // still being created, and resetting here would throw away the choices
      // the user made a minute ago in a WebView whose storage has since been
      // cleared.
      storeInstallTs(ts);
      await whenPrefsPersisted();
    }
  } catch {
    /* probe unavailable — keep the stored preferences */
  }
  // Pull whenever either database has content: a device whose SmartP is
  // missing / empty can still be driven from the teg mirror.
  if (state.stat?.smartp.exists || state.stat?.teg.exists) {
    await pullAll();
  }
}

export async function refreshStat(): Promise<void> {
  try {
    state.stat = await bridge.stat();
    state.lastError = null;
  } catch (err: any) {
    state.lastError = err?.message ?? String(err);
  }
}

/** Result of a pull. Callers must be able to tell "refreshed" from "refresh
 *  failed": silently keeping the old state made the next action work on stale
 *  data while the UI said the refresh succeeded. */
export interface PullResult {
  ok: boolean;
  error?: string;
}

export async function pullAll(): Promise<PullResult> {
  state.loading = true;
  try {
    const [smartpBytes, tegBytes] = await Promise.all([
      state.stat?.smartp?.exists ? bridge.pull('smartp') : Promise.resolve<null>(null),
      state.stat?.teg?.exists ? bridge.pull('teg') : Promise.resolve<null>(null),
    ]);

    // open + extract (a missing database becomes null, not an error)
    const dbS = smartpBytes ? await openDb(smartpBytes) : null;
    const dbT = tegBytes ? await openDb(tegBytes) : null;
    try {
      readIntoState(dbS, dbT);
    } finally {
      if (dbS) closeDb(dbS);
      if (dbT) closeDb(dbT);
    }

    // Refresh stat before snapshotting the baseline: a direct write (JSON
    // editor) has just changed mtime/size, and keeping the pre-write stat
    // would make the next commit's conflict check fail every time.
    await refreshStat();
    // set baseline digest
    await refreshBaseline();
    state.pristineSnapshot = snapshotFromMaps({
      cloudConfig: state.cloudConfig,
      rulesByModule: state.rulesByModule,
    });
    state.dirty = false;
    state.applyStatus = null;
    state.rebasedAt = null;
    state.lastError = null;
    return { ok: true };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    state.lastError = message;
    return { ok: false, error: message };
  } finally {
    state.loading = false;
  }
}

function readIntoState(dbS: Database | null, dbT: Database | null) {
  const cc: Record<string, any> = {};
  const smartpRaw: Record<string, any> = {};
  const issues: ParseIssue[] = [];
  if (dbS) {
    const parsed = parseCloudConfigRows(listCloudConfig(dbS) as Array<Record<string, any>>);
    Object.assign(cc, parsed.configs);
    issues.push(...parsed.issues);
    for (const [name, cfg] of Object.entries(parsed.configs)) {
      smartpRaw[name] = cfg.meta?.broken ? {} : JSON.parse(JSON.stringify(cfg.params));
    }
  }
  // Re-attach the pre-lock version to rows that are still locked. The DB only
  // stores the 2099* value, so without this a refresh made "unlock" restore the
  // locked number itself.
  const restoredLocks = applyLockedOriginals(cc, getLockedVersions());
  for (const name of restoredLocks.stale) clearLockedVersion(name);

  const byModule: Record<string, any[]> = {};
  if (dbT) {
    for (const row of listRules(dbT)) {
      const mod = row.rule_module ?? 'unknown';
      if (!byModule[mod]) byModule[mod] = [];
      try {
        const content = parseParams(row.rule_content);
        const envParams =
          content && typeof content === 'object' && !Array.isArray(content)
            ? (content as any).params
            : null;
        byModule[mod].push({
          meta: { ...row, _real: true, empty: isEmptyCloudParams(envParams) },
          content,
        });
      } catch (err: any) {
        // keep the raw row even if JSON is malformed, and report it: a rule
        // row that silently vanished looked like "this module has no config".
        const message = err?.message ?? String(err);
        issues.push({ db: 'teg', config: mod, message });
        byModule[mod].push({
          meta: { ...row, _real: true, empty: false, broken: true, parseError: message },
          content: row.rule_content,
        });
      }
    }
  }
  // ---- fallback: SmartP has no row (or an empty one) but teg does ----
  // Lets a device whose SmartP was never populated keep working instead of
  // showing an empty dashboard for every page.
  for (const [name, rows] of Object.entries(byModule)) {
    const cur = cc[name];
    if (cur && !cur.meta?.empty) continue;
    if (getDataSourcePref() !== 'teg-fallback') continue;
    const env = rows.find((r) => {
      const e = r.content;
      return (
        e && typeof e === 'object' && !Array.isArray(e) && !isEmptyCloudParams((e as any).params)
      );
    })?.content;
    if (env) {
      cc[name] = {
        // fromTeg: nothing of this config exists in SmartP — the content is
        // entirely from teg, so never label it "SmartP" or show SmartP's version.
        meta: {
          version: Number((env as any).version ?? 0),
          rule_version: null,
          fromTeg: true,
          _real: true,
        },
        params: parseParams(JSON.stringify((env as any).params)),
      };
    }
  }

  // ---- version source selection ----
  // booster_config exists in both DBs and the cloud may update them out of
  // sync (teg is usually fresher and keeps several historical rows). Honour the
  // user's preference; common_config defaults to SmartP because its teg mirror
  // is frequently incomplete. Comparison uses envelope.version (same
  // YYYYMMDDxx scheme as SmartP.version), never the internal rule_version.
  {
    const booster = cc['booster_config'];
    if (booster) {
      booster.meta.smartpVersion = booster.meta.fromTeg ? 0 : Number(booster.meta.version ?? 0);
      booster.meta.tegVersion = latestEnvelopeVersion(byModule['booster_config']);
      if (booster.meta.fromTeg) {
        booster.meta.source = 'teg';
        booster.meta.version =
          booster.meta.tegVersion > 0 ? booster.meta.tegVersion : undefined;
      } else {
        const picked = pickBoosterParams(
          booster,
          byModule['booster_config'],
          getBoosterSourcePref(),
        );
        if (picked) {
          booster.params = picked.params;
          booster.meta.version = picked.version;
          booster.meta.source = picked.source;
        }
      }
    }
  }

  {
    const common = cc['common_config'];
    if (common) {
      common.meta.smartpVersion = common.meta.fromTeg ? 0 : Number(common.meta.version ?? 0);
      common.meta.tegVersion = latestEnvelopeVersion(byModule['common_config']);
      if (common.meta.fromTeg) {
        common.meta.source = 'teg';
        common.meta.version = common.meta.tegVersion > 0 ? common.meta.tegVersion : undefined;
      } else {
        const picked = pickBoosterParams(
          common,
          byModule['common_config'],
          getCommonSourcePref(),
        );
        if (picked) {
          common.params = picked.params;
          common.meta.source = picked.source;
          // common_config's official version lives in SmartP's version column;
          // only an explicit teg choice follows the envelope version.
          common.meta.version = picked.version > 0 ? picked.version : undefined;
        }
      }
    }
  }

  const booster = cc.booster_config?.params ?? {};
  state.paths = detectPaths(booster);
  state.activeBackend = detectActiveBackend(booster);

  // Publish the new state in one step, after every part of it has been built
  // and validated. Assigning cloudConfig earlier meant a parse error while
  // building the teg side left the UI with new SmartP data and old teg data —
  // a combination that never existed on the phone, which the next commit would
  // then write back.
  state.cloudConfig = cc;
  state.smartpRaw = smartpRaw;
  state.rulesByModule = byModule;
  state.parseIssues = issues;
}

/** Whether a config page has usable content under the current data-source
 *  policy: SmartP always counts; teg only when the user allowed the fallback. */
export function sourceUsable(configName: string): boolean {
  if (state.smartpRaw[configName] && !isEmptyCloudParams(state.smartpRaw[configName])) return true;
  if (getDataSourcePref() === 'teg-fallback') {
    const cur = state.cloudConfig[configName];
    return !!cur && !isEmptyCloudParams(cur.params);
  }
  return false;
}

/** Mark a mutation to booster_config / common_config / rules as pending.
 * Called by the views after every in-memory edit.
 *
 * Path re-detection used to run inline on every keystroke (each `input`
 * event re-serialised the entry and rebuilt 5 status objects, invalidating
 * the sidebar badges). It is now coalesced into one animation frame and
 * skipped entirely when the result is unchanged, which removes the typing
 * jank without changing observable behaviour. */
export function markDirty(): void {
  state.dirty = true;
  schedulePathRefresh();
}

let pathRefreshQueued = false;

function schedulePathRefresh(): void {
  if (pathRefreshQueued) return;
  pathRefreshQueued = true;
  const run = () => {
    pathRefreshQueued = false;
    if (!state.cloudConfig.booster_config) return;
    const booster = state.cloudConfig.booster_config.params ?? {};
    const nextPaths = detectPaths(booster);
    if (!samePaths(nextPaths, state.paths)) state.paths = nextPaths;
    const nextBackend = detectActiveBackend(booster);
    if (nextBackend !== state.activeBackend) state.activeBackend = nextBackend;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function samePaths(a: V3PathStatus[], b: V3PathStatus[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].active !== b[i].active || a[i].count !== b[i].count) return false;
  }
  return true;
}

/** Byte-wise comparison of a freshly exported DB against the bytes we pulled.
 * sql.js re-emits the whole file, so pointer equality is useless here. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}


/** Last-resort version for a mirror row. `0` means "unknown" and is written as
 *  0, not as a plausible-looking 2024 date that Joyose might treat as real. */
export const UNKNOWN_CONFIG_VERSION = 0;

/** teg carries `rules` but has no common_config mirror at all (common on
 *  devices whose teg sync only ever delivered booster_config). Create the row
 *  so a commit keeps both sides in step — but only from real, non-empty SmartP
 *  content, so we never fabricate a config the device does not have. */
function ensureCommonConfigMirror(): void {
  const name = 'common_config';
  const cc = state.cloudConfig[name];
  if (!cc || cc.meta?._real !== true || cc.meta?.empty || cc.meta?.fromTeg) return;
  if ((state.rulesByModule[name]?.length ?? 0) > 0) return;
  if (!Object.values(state.rulesByModule).some((rows) => rows.length > 0)) return;
  // Take the version from the SmartP row this mirror is built from. The old
  // hard-coded 2024010101 was not the cloud's version for any module on any
  // sample; writing it made the mirror look like a real release.
  const rawVersion = Number(cc.meta?.version ?? 0);
  const version = Number.isFinite(rawVersion) && rawVersion > 0 ? rawVersion : undefined;
  state.rulesByModule[name] = [
    {
      meta: {
        rule_version: version ?? UNKNOWN_CONFIG_VERSION,
        _real: true,
        empty: false,
      },
      content: refreshEnvelope(null, cc.params, version, name),
    },
  ];
}

/** Synchronise teg_config.rules.rule_content for a given module from the
 * current cloud_config.params. Mirrors what Joyose itself does internally.
 *
 * Only the module's current row is touched. Rewriting every row with one blob
 * used to collapse a Xiaomi 15's five booster_config revisions into a single
 * copy and, worse, stamp the oldest row's `rule_version` onto all of them. */
export function syncRuleContent(configName: string, newVersion?: number): void {
  const cc = state.cloudConfig[configName];
  if (!cc) return;
  const row = currentRuleRow(state.rulesByModule[configName] ?? []);
  if (!row) return;
  const v = newVersion ?? Number(cc.meta.version ?? row.meta.rule_version ?? 0);
  row.content = refreshEnvelope(row.content as any, cc.params, v, configName);
  if (typeof newVersion === 'number') row.meta.rule_version = newVersion;
}

/** Lock the cloud version by rewriting the leading 4 digits to `2099`.
 * Mirrors the Coolapk trick: Joyose compares the cloud-pushed `version`
 * against `cloud_config.version` and only overwrites when the cloud value
 * is newer, so faking a far-future date pins our edits. */
export function lockCloudVersion(configName: string): number {
  const cc = state.cloudConfig[configName];
  if (!cc) throw new Error(`no config named ${configName}`);
  if (cc.meta?.empty) {
    throw new Error(`${configName}: 空配置，没有可锁定的版本号`);
  }
  const current = Number(cc.meta.version ?? cc.params?.header?.version ?? 0);
  // Lock base: booster takes the newer of "current" and the latest teg
  // envelope; common_config stays on the official SmartP version so a stale
  // teg mirror cannot drag the lock year onto the wrong digits.
  const latestTeg = latestEnvelopeVersion(state.rulesByModule[configName]);
  const base = configName === 'common_config' ? current : Math.max(current, latestTeg);
  if (!(base > 0)) {
    throw new Error(
      `${configName}: SmartP 与 teg 都没有可用版本号，无法锁定`,
    );
  }
  const locked = rewriteYear(base);
  // Remember the pre-lock version so "unlock" restores the real one instead of
  // guessing a 2024 prefix.
  if (cc.meta.originalVersion === undefined) {
    cc.meta.originalVersion = current;
  }
  // Persist it: a refresh rebuilds cloudConfig from the DB, where the version is
  // already 2099*, and the in-memory pre-lock value would be gone.
  setLockedVersion(configName, current);
  cc.meta.version = locked;
  if (cc.params.header) cc.params.header.version = String(locked);
  syncRuleContent(configName, locked);
  markDirty();
  return locked;
}

export function unlockCloudVersion(configName: string, restored: number): void {
  const cc = state.cloudConfig[configName];
  if (!cc) return;
  cc.meta.version = restored;
  if (cc.params.header) cc.params.header.version = String(restored);
  syncRuleContent(configName, restored);
  // The pre-lock value has been used; keeping it would resurrect a stale number
  // if the user locks again later from a different cloud version.
  clearLockedVersion(configName);
  markDirty();
}

function rewriteYear(version: number): number {
  const s = String(version);
  if (s.length < 4) return Number(`2099${'0'.repeat(Math.max(0, 10 - s.length))}${s}`);
  return Number(`2099${s.slice(4)}`);
}

/** The four fixed targets the JSON editor can write to. They are deliberately
 *  narrow: one database, one config. The editor is a scalpel, not the global
 *  commit — it neither mirrors to the other DB nor records history. */
export type JsonTarget = 'sp_booster' | 'sp_common' | 'teg_booster' | 'teg_common';

const JSON_TARGET_CONFIG: Record<JsonTarget, { name: string; db: 'smartp' | 'teg' }> = {
  sp_booster: { name: 'booster_config', db: 'smartp' },
  sp_common: { name: 'common_config', db: 'smartp' },
  teg_booster: { name: 'booster_config', db: 'teg' },
  teg_common: { name: 'common_config', db: 'teg' },
};

/** Write the editor's text straight into one target row.
 *
 *  SmartP_* touches only that `cloud_config` row (params; the version column is
 *  left as-is unless the editor is the only thing that ever set it), teg_*
 *  touches only the module's current `rules` row. Both refuse to write when the
 *  row does not exist: fabricating a row is how "empty config" bugs start.
 *
 *  Conflict check uses the sha256 baseline, so a cloud push that landed while
 *  the editor was open prompts instead of being silently overwritten. */
export interface JsonSaveResult {
  ok: true;
  target: string;
  /** The write landed but re-reading the DBs failed; the editor still shows
   *  pre-write values. */
  refreshError?: string;
  /** The write landed but the restart call failed. Distinct from a write
   *  failure: the config is on disk and will be read on the next launch. */
  restartError?: string;
  /** Observed running again; null when no restart was attempted. */
  startedAfter?: boolean | null;
}

export async function saveJsonTarget(
  target: JsonTarget,
  jsonText: string,
): Promise<JsonSaveResult> {
  return withWriteLock('参数树写入', () => saveJsonTargetLocked(target, jsonText));
}

async function saveJsonTargetLocked(
  target: JsonTarget,
  jsonText: string,
): Promise<JsonSaveResult> {
  const { name, db: which } = JSON_TARGET_CONFIG[target];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: any) {
    throw new Error(`JSON 解析失败：${err?.message ?? err}`);
  }

  // Soft conflict check — same baseline the commit path uses.
  const fresh = await bridge.digest().catch(() => null);
  if (fresh) {
    const baseline = which === 'smartp' ? state.baselineSmartp : state.baselineTeg;
    const current = which === 'smartp' ? fresh.smartp : fresh.teg;
    if (baseline && current && baseline !== current) {
      const ok = window.confirm(
        `${which === 'smartp' ? 'SmartP.db' : 'teg_config.db'} 在打开编辑器后被 Joyose 更新过。` +
          `继续保存会覆盖该行上的本次云端更新。仍要保存？`,
      );
      if (!ok) throw new Error('已取消保存，编辑器内容保留');
    }
  }

  // A direct write skips the commit bar, so take the restore point here — the
  // user has no "discard" path for a JSON edit. Refuse to write without it.
  const backupState = await ensureBackup('json-edit');

  // Past this line the service is stopped because of our backup, not because
  // the user closed it. Any throw has to put it back: the write path only sees
  // "not running" and would leave it down without saying so.
  try {
  if (which === 'smartp') {
    if (target === 'sp_booster') {
      if (!(name in state.smartpRaw)) {
        throw new Error('SmartP 中没有 booster_config 行，无法写入（可改用 teg 目标）');
      }
    } else if (!(name in state.smartpRaw)) {
      throw new Error('SmartP 中没有 common_config 行，无法写入（可改用 teg 目标）');
    }

    const bytes = await bridge.pull('smartp');
    const db = await openDb(bytes);
    let out: Uint8Array;
    try {
      const count = Number(
        db.exec(`SELECT COUNT(*) FROM cloud_config WHERE config_name = :n`, { ':n': name })[0]
          ?.values?.[0]?.[0] ?? 0,
      );
      if (count === 0) {
        throw new Error(`SmartP 中没有 ${name} 行，无法写入`);
      }
      // Never use meta.version unconditionally: when the working copy was
      // chosen from the teg source, it is teg's envelope version, not SmartP's
      // column. pickSmartpVersion() only trusts a locked version or SmartP's
      // own column.
      const version = pickSmartpVersion(state.cloudConfig[name]?.meta);
      updateCloudConfigParams(db, name, stringifyParams(parsed), version);
      out = exportDb(db);
    } finally {
      closeDb(db);
    }
    // The helper re-hashes the live file right before the swap. Without this
    // the JSON path only checked the baseline *before* pulling, so a cloud
    // update landing in that window was overwritten with bytes computed on the
    // old base — the same TOCTOU the commit path already guards against.
    const res = await bridge.push('smartp', out, {
      expectCurrent: await bridge.sha256Hex(bytes),
    });
    state.applyStatus = {
      stopConfirmed: res.stopConfirmed ?? res.stopped ?? null,
      wasRunningBefore: res.wasRunning ?? null,
      restartAttempted: false,
      startedAfter: null,
      at: Date.now(),
    };
  } else {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('teg 目标必须是一个信封对象（{ config_name, version, params, … }）');
    }
    const bytes = await bridge.pull('teg');
    const db = await openDb(bytes);
    let out: Uint8Array;
    try {
      const id = latestRuleIdForModule(db, name);
      if (id === null) {
        throw new Error(`teg 中没有 ${name} 行，无法写入（可改用 SmartP 目标）`);
      }
      updateRuleContentById(db, id, JSON.stringify(parsed));
      out = exportDb(db);
    } finally {
      closeDb(db);
    }
    const res = await bridge.push('teg', out, {
      expectCurrent: await bridge.sha256Hex(bytes),
    });
    state.applyStatus = {
      stopConfirmed: res.stopConfirmed ?? res.stopped ?? null,
      wasRunningBefore: res.wasRunning ?? null,
      restartAttempted: false,
      startedAfter: null,
      at: Date.now(),
    };
  }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // A timeout may still be running on the device; racing a restart against
    // it is worse than leaving the state alone.
    if (backupState.wasRunning && !TIMEOUT_RE.test(msg)) {
      await reportRestartFailure(err, await bridge.restart().catch(() => null));
    }
    throw err;
  }

  // Report the restart result instead of collapsing it to null. The UI used to
  // say "Joyose 已重启" whenever the write had landed, which was simply false
  // when the restart call failed.
  let restartError: string | undefined;
  const restarted = await bridge.restart().catch((err) => {
    restartError = err?.message ?? String(err);
    return null;
  });
  if (restarted) {
    state.applyStatus = {
      // A failed stop stays failed: the restart path cannot retroactively prove
      // the first stop worked.
      stopConfirmed:
        state.applyStatus?.stopConfirmed === false
          ? false
          : typeof restarted.stopped === 'boolean'
            ? restarted.stopped
            : state.applyStatus?.stopConfirmed ?? null,
      wasRunningBefore: state.applyStatus?.wasRunningBefore ?? null,
      restartAttempted: true,
      startedAfter: restarted.started ?? null,
      at: Date.now(),
    };
  }

  // Rebuild from the DB so the editor shows what actually landed. A failure
  // here does not invalidate the write, but it must not be swallowed: the
  // editor would keep showing pre-write values while claiming to be current.
  const pulled = await pullAll();
  return {
    ok: true,
    target,
    refreshError: pulled.ok ? undefined : pulled.error,
    restartError,
    startedAfter: restarted?.started ?? null,
  };
}

/** How many history files / backup directories to keep on the device. */
export const HISTORY_KEEP = 10;
export const BACKUP_KEEP = 10;

export interface PushOptions {
  note?: string;
  source?: HistorySource;
  /** If true, ignore the baseline digest mismatch and overwrite. */
  force?: boolean;
}

/** Take the pre-write restore point and treat its failure as fatal.
 *
 *  Both write paths used to swallow this error: the user saw a normal commit
 *  while the operation had no restore point at all. The commit chain is the
 *  only way back, so a missing backup means the write must not start.
 *
 *  Returns whether Joyose was running before the backup quiesced it. The
 *  backup leaves the service stopped so the write can proceed; if the write
 *  then fails, the caller is the only one left that knows it has to be put
 *  back. */
async function ensureBackup(label?: string): Promise<{ wasRunning: boolean }> {
  try {
    const res = await bridge.backup(label, { restore: false });
    if (!res?.ok || !res.dir) {
      throw new Error('备份命令没有返回备份目录');
    }
    return { wasRunning: res.wasRunning === true };
  } catch (err: any) {
    throw new Error(`自动备份失败，已中止写入：${err?.message ?? String(err)}`);
  }
}

/** Re-read the DB digests and store them as the conflict-detection baseline. */
export async function refreshBaseline(): Promise<void> {
  try {
    const d = await bridge.digest();
    state.baselineSmartp = d.smartp;
    state.baselineTeg = d.teg;
  } catch {
    // Helper too old for `digest` (module not updated yet) — degrade to the
    // coarse stat fingerprint rather than dropping conflict detection.
    const s = await bridge.stat().catch(() => null);
    if (!s) return;
    state.baselineSmartp = s.smartp.exists
      ? fingerprint(s.smartp.mtime ?? 0, s.smartp.size ?? 0)
      : null;
    state.baselineTeg = s.teg.exists ? fingerprint(s.teg.mtime ?? 0, s.teg.size ?? 0) : null;
  }
}

/** The DB moved underneath us. Distinct from a generic failure so the caller
 *  can rebase and retry instead of asking the user to throw their edits away. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The fresh database no longer contains the rows some of the user's edits were
 *  made against (a cloud push replaced the row, or another editor deleted it).
 *  Replaying the rest would silently drop those edits, so the rebase stops and
 *  the working copy is kept as it was. `paths` is what could not be replayed —
 *  the UI names them instead of saying "conflict". */
export class RebaseConflictError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    const shown = paths.slice(0, 5).join('、');
    const more = paths.length > 5 ? ` 等 ${paths.length} 处` : '';
    super(
      `设备上的数据库已变化，你改过的 ${shown}${more} 在新数据里已经不存在了。` +
        `为避免把这些修改悄悄丢掉，本次提交已中止，界面里的修改仍然保留，请重新确认后再提交。`,
    );
    this.name = 'RebaseConflictError';
    this.paths = paths;
  }
}

/** What a commit actually did. A commit that found no structural difference
 *  must not write a history record or restart Joyose: an empty delta plus a
 *  restart is indistinguishable from a real edit in the UI, and it also costs
 *  the user a Joyose cold start. */
export interface CommitResult {
  /** History file written, or null when nothing was written. */
  file: string | null;
  changed: boolean;
  /** `written` = at least one DB changed, `no-change` = working copy equals the
   *  base, `out-of-scope` = there are edits but they fall outside the current
   *  write target, so the DBs came back byte-identical. */
  reason: 'written' | 'no-change' | 'out-of-scope';
  wroteSmartp: boolean;
  wroteTeg: boolean;
  /** The DB write succeeded but the history record could not be saved. The
   *  device has already changed — reporting the whole commit as failed would
   *  be wrong. */
  historyError?: string;
  /** The DB write succeeded but the restart call failed. */
  restartError?: string;
  /** The same outcome in the shape every mutating operation returns. Views
   *  branch on `result.code`; the fields above stay for the details. */
  result: OperationResult;
}

/** Commit the in-memory edits: build history record, write both DBs, save
 * history, refresh state. Returns the history filename written. */
async function pushCore(opts: PushOptions = {}): Promise<CommitResult> {
  // Set once the backup has quiesced Joyose. Everything after that point has
  // to put the service back: the write path only knows "it was not running",
  // because by the time it looks, the backup has already stopped it.
  let backupWasRunning = false;
  try {
    // Which database(s) this commit may touch. Global setting, honoured by
    // every page — see the "来源与写入" panel.
    const writeTarget = getWriteTarget();
    const writeSmartp = writeTarget === 'both' || writeTarget === 'smartp';
    const writeTeg = writeTarget === 'both' || writeTarget === 'teg';

    // Digests as the databases stand right now. Used twice: to detect that
    // somebody else changed them since the pull (conflict), and as the
    // `beforeDigest` stamped into the history record so a later rollback can
    // prove it is replaying onto the base it was computed from.
    const beforeDigest = await bridge.digest().catch(() => null);

    if (!opts.force) {
      const check = (label: string, baseline: string | null, current: string | null) => {
        if (!baseline || !current || baseline === current) return;
        throw new ConflictError(
          `${label} 在拉取后被改动过（${current.slice(0, 12)} ≠ ${baseline.slice(0, 12)}）。`,
        );
      };
      // Only the database we are about to write can conflict with us; a teg
      // update must not block a SmartP-only commit.
      if (beforeDigest) {
        if (writeSmartp) check('SmartP.db', state.baselineSmartp, beforeDigest.smartp);
        if (writeTeg) check('teg_config.db', state.baselineTeg, beforeDigest.teg);
      }
    }

    // Auto-sync rules.rule_content from the matching cloud_config row, so
    // any edit made via the structured views propagates to the teg mirror
    // without the view layer needing to remember. Only meaningful when teg is
    // a write target.
    if (writeTeg) {
      ensureCommonConfigMirror();
      for (const name of Object.keys(state.cloudConfig)) {
        if (state.rulesByModule[name]?.length) syncRuleContent(name);
      }
    }

    // Structural diff first: a commit with an empty delta must not take a
    // backup, write a history record or restart Joyose. It used to do all
    // three, so the UI reported a successful submit for a no-op and the user
    // paid a Joyose cold start for nothing.
    const recordBefore =
      state.pristineSnapshot ??
      snapshotFromMaps({ cloudConfig: state.cloudConfig, rulesByModule: state.rulesByModule });
    const recordAfter = snapshotFromMaps({
      cloudConfig: state.cloudConfig,
      rulesByModule: state.rulesByModule,
    });
    const delta = diff(recordBefore, recordAfter);
    if (commitOutcome(delta.length, false, false) === 'no-change') {
      state.dirty = false;
      state.pristineSnapshot = recordAfter;
      return {
        file: null,
        changed: false,
        reason: 'no-change',
        wroteSmartp: false,
        wroteTeg: false,
        result: makeResult({ code: 'no-change', databaseChanged: false }),
      };
    }

    // re-pull current bytes, mutate, write back
    const [smartpBytes, tegBytes] = await Promise.all([
      writeSmartp && state.stat?.smartp?.exists ? bridge.pull('smartp') : Promise.resolve<null>(null),
      writeTeg && state.stat?.teg?.exists ? bridge.pull('teg') : Promise.resolve<null>(null),
    ]);
    const dbS = smartpBytes ? await openDb(smartpBytes) : null;
    const dbT = tegBytes ? await openDb(tegBytes) : null;

    let outSmartp: Uint8Array | null = null;
    let outTeg: Uint8Array | null = null;
    /** Params we actually wrote into SmartP, so the in-memory raw copy keeps
     *  matching the database after this commit. */
    const writtenRaw: Record<string, any> = {};
    try {
      // Only rewrite rows the user actually touched. Re-serialising every row
      // meant that a cloud push landing between our pull and our commit was
      // silently rolled back on every unrelated config, because we wrote the
      // whole in-memory snapshot back.
      const workBase = state.pristineSnapshot?.smartp?.cloud_config ?? {};
      // Read the merge base from the bytes we are about to write, not from
      // `state.smartpRaw`: that copy is whatever the last pull saw, so after a
      // second edit in the same session it no longer matches the row on disk
      // and the merge would silently undo the previous commit.
      if (dbS) {
        const plan = planSmartpWrites(dbS, state.cloudConfig, workBase);
        applySmartpWrites(dbS, plan.writes);
        for (const w of plan.writes) writtenRaw[w.name] = w.params;
      }
      if (dbT) {
        applyTegWrites(dbT, planTegWrites(dbT, state.rulesByModule));
      }

      outSmartp = dbS ? exportDb(dbS) : null;
      outTeg = dbT ? exportDb(dbT) : null;
    } finally {
      if (dbS) closeDb(dbS);
      if (dbT) closeDb(dbT);
    }

    const wroteSmartp = !!(outSmartp && smartpBytes && !sameBytes(outSmartp, smartpBytes));
    const wroteTeg = !!(
      outTeg &&
      tegBytes &&
      Object.values(state.rulesByModule).some((rows) => rows.length > 0) &&
      !sameBytes(outTeg, tegBytes)
    );
    // There are edits, but none of them land in the databases this commit is
    // allowed to write (e.g. the user edited a teg-only config while the write
    // target is SmartP-only). Say so instead of reporting a successful write.
    if (commitOutcome(delta.length, wroteSmartp, wroteTeg) === 'out-of-scope') {
      return {
        file: null,
        changed: false,
        reason: 'out-of-scope',
        wroteSmartp,
        wroteTeg,
        result: makeResult({ code: 'out-of-scope', databaseChanged: false }),
      };
    }

    // auto-backup — abort when it does not land. A commit whose restore point
    // silently failed is exactly the commit the user cannot walk back later.
    // Runs after the diff so a no-op never creates a backup, and immediately
    // before the write so the restore point is as close as possible to it.
    const backupState = await ensureBackup();
    backupWasRunning = backupState.wasRunning;

    // persist DBs first, so if anything fails we can re-sync
    const stops: boolean[] = [];
    const wasRunning: boolean[] = [];
    const recordStop = (r: { stopped?: boolean; stopConfirmed?: boolean; wasRunning?: boolean }) => {
      const confirmed = typeof r?.stopConfirmed === 'boolean' ? r.stopConfirmed : r?.stopped;
      if (typeof confirmed === 'boolean') stops.push(confirmed);
      if (typeof r?.wasRunning === 'boolean') wasRunning.push(r.wasRunning);
    };
    // Uploading a DB costs one ksu.exec round-trip per 48 KB of base64 — about
    // 30 calls per MB. Skip the ones whose bytes came back unchanged: editing
    // a SmartP-only config used to re-upload the 1 MB teg mirror for nothing.
    //
    // When both databases change, they go in as one device-side transaction.
    // Two independent pushes could leave SmartP written and teg untouched if
    // the second one failed — a combination that never existed on the phone,
    // reported to the user as a failed commit they would then retry.
    // Keep the results, not just the stop flags: they carry what the write
    // actually proved (digest vs. length, live re-check, label outcome), and
    // the user is told when any of that was weaker than it looks.
    const writeResults: Array<bridge.WriteResult | bridge.PairWriteResult> = [];
    if (wroteSmartp && wroteTeg) {
      const spCurrent = await bridge.sha256Hex(smartpBytes!);
      const tegCurrent = await bridge.sha256Hex(tegBytes!);
      const pair = await bridge.pushPair(outSmartp!, outTeg!, {
        smartpExpect: spCurrent,
        tegExpect: tegCurrent,
      });
      writeResults.push(pair);
      recordStop(pair);
    } else if (wroteSmartp) {
      const currentSha = await bridge.sha256Hex(smartpBytes!);
      const one = await bridge.push('smartp', outSmartp!, { expectCurrent: currentSha });
      writeResults.push(one);
      recordStop(one);
    } else if (wroteTeg) {
      const currentSha = await bridge.sha256Hex(tegBytes!);
      const one = await bridge.push('teg', outTeg!, { expectCurrent: currentSha });
      writeResults.push(one);
      recordStop(one);
    }
    if (wroteSmartp) {
      // The row on disk is now what we just wrote. Keeping the pre-commit copy
      // would make the next commit in this session merge onto a stale base.
      for (const [name, params] of Object.entries(writtenRaw)) {
        state.smartpRaw[name] = JSON.parse(JSON.stringify(params));
      }
    }

    // write history after successful DB push. v2 records store only the
    // forward delta (parent -> this); reconstruction walks the chain from
    // pristineSnapshot. Keeps each file in the KB range.
    //
    // A failure here must not turn a completed device write into "提交失败":
    // the DB is already changed at this point, and telling the user otherwise
    // invites them to retry a write that has landed.
    let fname: string | null = null;
    let historyError: string | undefined;
    try {
      const existing = await bridge.historyList();
      const seq = nextSeq(existing);
      const ts = Math.floor(Date.now() / 1000);
      // Where the databases ended up. Read after the swap so the record
      // describes reality, not our intention: "we asked for these bytes" and
      // "the file now holds them" are different claims.
      const afterDigest = await bridge.digest().catch(() => null);
      const rec = buildRecord({
        seq,
        timestamp: ts,
        source: opts.source ?? 'webui',
        note: opts.note ?? '',
        delta,
        dbKind: wroteSmartp && wroteTeg ? 'both' : wroteSmartp ? 'smartp' : 'teg',
        beforeDigest: beforeDigest ?? undefined,
        afterDigest: afterDigest ?? undefined,
        canRevert: delta.length > 0,
      });
      fname = buildHistoryFilename(ts, seq);
      await bridge.historySave(fname, JSON.stringify(rec));
      // Keep the timeline short: one delta record per commit adds up on a phone
      // with a 1 MB cloud config, and ten entries is plenty to walk back.
      await bridge.historyClear(HISTORY_KEEP).catch(() => null);
    } catch (err: any) {
      historyError = err?.message ?? String(err);
      fname = null;
    }

    // Restart Joyose so it re-reads the DB. Report the result instead of
    // swallowing it: a silent failure here looks like "the edit did nothing".
    let restartError: string | undefined;
    const restarted = await bridge.restart().catch((err) => {
      restartError = err?.message ?? String(err);
      return null;
    });
    if (restarted) recordStop(restarted);
    state.applyStatus = {
      stopConfirmed: stops.length > 0 ? stops.every(Boolean) : null,
      // Only report "it was running" when at least one write path told us.
      wasRunningBefore: wasRunning.length > 0 ? wasRunning.some(Boolean) : null,
      restartAttempted: true,
      startedAfter: restarted?.started ?? null,
      at: Date.now(),
    };

    state.pristineSnapshot = recordAfter;
    state.dirty = false;
    await refreshStat();
    await refreshBaseline();
    const stopConfirmed = stops.length > 0 ? stops.every(Boolean) : null;
    return {
      file: fname,
      changed: true,
      reason: 'written',
      wroteSmartp,
      wroteTeg,
      historyError,
      restartError,
      result: makeResult({
        code: commitCode({
          historyError,
          restartError,
          stopConfirmed,
          restartAttempted: true,
          startedAfter: restarted?.started ?? null,
          rebased: state.rebasedAt !== null,
        }),
        databaseChanged: wroteSmartp || wroteTeg,
        // A commit always takes its restore point before writing.
        backupCreated: true,
        joyoseStopped: stopConfirmed,
        joyoseWasRunning: wasRunning.length > 0 ? wasRunning.some(Boolean) : null,
        joyoseRestarted: restarted?.started ?? null,
        warnings: writeWarnings(writeResults),
      }),
    };
  } catch (err) {
    // ConflictError bubbles to pushAll, which rebases and retries; anything
    // else is a genuine failure and must reach the user.
    //
    // Before rethrowing: if the backup stopped Joyose and the write did not
    // put it back, start it now. Without this the phone sits with the game
    // service down until the next launch, and the error only says "write
    // failed" — nothing tells the user the config will not load.
    // A timeout is excluded: the shell command may still be running, and
    // racing a restart against it would interleave state we cannot see.
    const msg = (err as Error)?.message ?? String(err);
    if (backupWasRunning && !TIMEOUT_RE.test(msg)) {
      await reportRestartFailure(err, await bridge.restart().catch(() => null));
    }
    throw err;
  }
}

/** Append "Joyose is still down" to a failure the user is about to read.
 *
 *  The backup stops Joyose, so an error between the stop and the write leaves
 *  the service down. Attempting a restart is not enough: `.catch(() => null)`
 *  threw the outcome away, and the user was told only "写入失败" while the game
 *  silently lost its config. A field nobody renders is not a report, so the
 *  consequence goes into the message. */
async function reportRestartFailure(err: unknown, restarted: { started?: boolean } | null): Promise<void> {
  if (restarted?.started === true) return;
  if (!(err instanceof Error)) return;
  if (err.message.includes('Joyose')) return;
  err.message += restarted
    ? '；Joyose 原本在运行，但重启后没有观察到进程，进游戏前请手动打开一次'
    : '；Joyose 原本在运行，但重启失败，进游戏前请手动打开一次';
}

/** What the write actually proved, beyond "it returned ok".
 *
 *  `verifiedBy: 'length'` and `liveChecked: false` both mean the WebView could
 *  not compute a SHA-256 — a real downgrade that used to be invisible, because
 *  the helper's silence read as success. */
function writeWarnings(
  results: Array<{
    verifiedBy?: string;
    liveChecked?: boolean;
    labelRestored?: string;
    label?: { smartp?: string; teg?: string };
  }>,
): string[] {
  const out: string[] = [];
  let weakDigest = false;
  let notRechecked = false;
  let labelFailed = false;
  for (const r of results) {
    if (r.verifiedBy === 'length' || r.verifiedBy === 'none') weakDigest = true;
    if (r.liveChecked === false) notRechecked = true;
    const labels = r.label
      ? [r.label.smartp, r.label.teg].filter(Boolean)
      : r.labelRestored
        ? [r.labelRestored]
        : [];
    if (labels.includes('failed')) labelFailed = true;
  }
  if (weakDigest) out.push('本次写入只按大小校验（WebView 无法计算 SHA-256）');
  if (notRechecked) out.push('写入前没有复核设备上的库，若云端同时下发可能被覆盖');
  if (labelFailed) out.push('SELinux 标签未能恢复，Joyose 可能读不到配置');
  return out;
}

/** Re-apply the pending edits on top of whatever Joyose just wrote.
 *
 *  The user's changes are expressed as a delta against pristineSnapshot; we
 *  pull the fresh DBs, restore the per-row metadata (a locked version must not
 *  be undone by the rebase), and replay the delta onto the new base.
 *
 *  Replay has to be checked, not assumed: when the new base is missing a row
 *  the delta addresses (cloud replaced it, or another editor deleted it),
 *  `applyDelta` drops that path and returns the rest, and the commit then
 *  succeeds while carrying only part of the user's work. So the delta is
 *  replayed through `applyDeltaReport`, and any unresolved path aborts the
 *  rebase with the working copy untouched. */
async function rebaseOntoLatest(): Promise<void> {
  const baseSnap =
    state.pristineSnapshot ??
    snapshotFromMaps({ cloudConfig: state.cloudConfig, rulesByModule: state.rulesByModule });
  const workingSnap = snapshotFromMaps({
    cloudConfig: state.cloudConfig,
    rulesByModule: state.rulesByModule,
  });
  const delta = diff(baseSnap, workingSnap);

  const metasBefore: Record<string, any> = {};
  for (const [k, v] of Object.entries(state.cloudConfig)) {
    metasBefore[k] = JSON.parse(JSON.stringify((v as any).meta ?? null));
  }

  const [smartpBytes, tegBytes] = await Promise.all([
    state.stat?.smartp?.exists ? bridge.pull('smartp') : Promise.resolve<null>(null),
    state.stat?.teg?.exists ? bridge.pull('teg') : Promise.resolve<null>(null),
  ]);
  const dbS = smartpBytes ? await openDb(smartpBytes) : null;
  const dbT = tegBytes ? await openDb(tegBytes) : null;
  try {
    readIntoState(dbS, dbT);
  } finally {
    if (dbS) closeDb(dbS);
    if (dbT) closeDb(dbT);
  }

  for (const [k, m] of Object.entries(metasBefore)) {
    if (state.cloudConfig[k] && m) (state.cloudConfig[k] as any).meta = m;
  }

  const newestSnap = snapshotFromMaps({
    cloudConfig: state.cloudConfig,
    rulesByModule: state.rulesByModule,
  });
  const report = planRebase(newestSnap, delta);
  if (report.missing.length > 0) {
    // Put the working copy back the way the user left it. `readIntoState`
    // above already replaced it with the fresh DB, and losing their edits is
    // exactly what this branch exists to prevent.
    rehydrateFromSnapshot(workingSnap);
    throw new RebaseConflictError(report.missing);
  }
  rehydrateFromSnapshot(report.snapshot);
  state.pristineSnapshot = newestSnap;
  state.dirty = true;
}

/** Front-end half of the write lock.
 *
 *  The helper's device lock stops two shell commands from interleaving; this
 *  stops the second UI action from being sent at all, so the user gets an
 *  immediate "already running" instead of a 20 s wait followed by a failure.
 *  Both halves are needed: a timeout on the front end does not cancel the
 *  command that is already running on the device. */
let writeBusy = false;

const TIMEOUT_RE = /超时|timeout/i;

/** After a front-end timeout the shell command is still running: `Promise.race`
 *  only rejects our side. Poll the device lock before letting the user start
 *  another write, otherwise the retry queues behind — or interleaves with — the
 *  command that "timed out". Returns false when the device is still busy. */
async function waitForDeviceIdle(maxMs = 30000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const st = await bridge.lockStatus();
      if (!st.locked) return true;
    } catch {
      // Helper too old for lock-status: nothing to wait on.
      return true;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

/** Put Joyose back if a write left it down.
 *
 *  Every write stops Joyose and starts it again when it finishes. A write that
 *  never finishes — the front-end timed out, the WebView was closed, the manager
 *  killed the shell — leaves the phone running without a cloud config, and
 *  nothing else would notice: the next game launch just reads nothing. The
 *  helper leaves a marker for exactly that, and this is the only place that
 *  acts on it.
 *
 *  Silent on success (Joyose being up is the normal state, and the user already
 *  saw the timeout); loud on failure, because nothing else will try again until
 *  the app is reopened. */
async function rescueStoppedService(reason: string): Promise<void> {
  let st: bridge.StatResult | null = null;
  try {
    st = await bridge.stat();
  } catch {
    return; // cannot tell — do not guess
  }
  if (!st?.service_stopped) return;
  const r = await bridge.restart().catch(() => null);
  const started = r?.started === true;
  state.applyStatus = {
    // The marker existing *is* the record of a confirmed stop.
    stopConfirmed: true,
    wasRunningBefore: true,
    restartAttempted: true,
    startedAfter: started,
    at: Date.now(),
  };
  if (!started) {
    state.lastError = `${reason}，Joyose 仍处于停止状态，进游戏前请手动打开一次。`;
  }
}

async function withWriteLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (writeBusy) {
    throw new Error(`上一个写入操作尚未结束，暂时不能${label}，请稍后再试`);
  }
  writeBusy = true;
  let timedOut = false;
  try {
    return await fn();
  } catch (err) {
    timedOut = TIMEOUT_RE.test(String((err as Error)?.message ?? ''));
    throw err;
  } finally {
    if (!timedOut) {
      writeBusy = false;
    } else {
      // Do NOT await here: the user must see "timed out" now, not in 30 s.
      // The lock stays held in the background until the device reports idle,
      // so a retry is refused locally instead of stacking on top of the
      // command that never answered us.
      void waitForDeviceIdle()
        .then(async (idle) => {
          if (!idle) {
            state.lastError =
              '设备侧的写入在超时后仍未结束。已保持互斥锁，请等它完成或重启手机后再操作。';
            return;
          }
          // The device is quiet again. If that write had taken Joyose down, it
          // is still down, and it is the only cost of the timeout the user
          // cannot see.
          await rescueStoppedService('上一次写入超时');
        })
        .finally(() => {
          writeBusy = false;
        });
    }
  }
}

export function isWriteBusy(): boolean {
  return writeBusy;
}

/** Public commit entry point: on a conflict, rebase onto the fresh DBs and
 *  retry (up to 3 attempts) before surfacing the error. */
export async function pushAll(opts: PushOptions = {}): Promise<CommitResult> {
  return withWriteLock('提交', async () => {
    state.loading = true;
    try {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await pushCore(opts);
        } catch (err) {
          lastErr = err;
          if (!(err instanceof ConflictError) || opts.force || attempt === 2) throw err;
          await rebaseOntoLatest();
          state.rebasedAt = Date.now();
        }
      }
      throw lastErr;
    } finally {
      state.loading = false;
    }
  });
}

/* Locked wrappers for the operations the views used to call bridge directly.
 * Keeping them here means a page cannot bypass the lock by importing the
 * bridge, and every mutating entry point has exactly one implementation.
 *
 * Each returns the bridge's own fields plus `result`, so a view can branch on
 * one code instead of re-deriving the outcome from a different set of
 * booleans per action. */
export type WithResult<T> = T & {
  result: OperationResult;
  /** Set when the state after the operation could not be re-read. The
   *  operation itself succeeded — this only means the page may be stale. */
  refreshError?: string;
};

export async function backupNow(label?: string): Promise<WithResult<bridge.BackupResult>> {
  return withWriteLock('备份', async () => {
    const r = await bridge.backup(label);
    return {
      ...r,
      result: makeResult({
        code: 'backed-up',
        // A backup does not move the databases; it copies them.
        databaseChanged: false,
        backupCreated: true,
        joyoseStopped: r.stopped ?? null,
        joyoseWasRunning: r.wasRunning ?? null,
        joyoseRestarted: r.restarted ?? null,
      }),
    };
  });
}

export async function revertToBackup(name: string): Promise<WithResult<bridge.RevertResult>> {
  return withWriteLock('回滚', async () => {
    const r = await bridge.revert(name);
    // A file-level revert replaces the databases behind the delta chain's
    // back. Re-read them first: keeping the pre-revert snapshot would make the
    // next commit diff against bytes that no longer exist. Then record the
    // floor, so a record from before this point is refused instead of being
    // replayed onto a base it never saw.
    const pulled = await pullAll();
    await markHistoryFloor();
    return {
      ...r,
      refreshError: pulled.ok ? undefined : (pulled.error ?? '刷新失败'),
      result: makeResult({
        code: 'reverted',
        databaseChanged: true,
        joyoseStopped: r.stopped ?? null,
        joyoseWasRunning: r.wasRunning ?? null,
        joyoseRestarted: r.restarted ?? null,
      }),
    };
  });
}

export async function revertLatestBackup(): Promise<WithResult<bridge.RevertResult>> {
  return withWriteLock('回滚', async () => {
    const r = await bridge.revertLatest();
    const pulled = await pullAll();
    await markHistoryFloor();
    return {
      ...r,
      refreshError: pulled.ok ? undefined : (pulled.error ?? '刷新失败'),
      result: makeResult({
        code: 'reverted',
        databaseChanged: true,
        joyoseStopped: r.stopped ?? null,
        joyoseWasRunning: r.wasRunning ?? null,
        joyoseRestarted: r.restarted ?? null,
      }),
    };
  });
}

export async function resetCloudData(): Promise<WithResult<bridge.ResetCloudResult>> {
  return withWriteLock('重置云控', async () => {
    const r = await bridge.resetCloud();
    // Only a failed `pm clear` means nothing happened. The broadcasts are
    // wake-ups that Joyose repeats by itself, so a partial result is reported
    // (see the view) instead of being thrown as a total failure.
    if (!r.cleared) {
      throw new Error(`云控数据没有被清除：${r.failed.join('、') || '未知原因'}`);
    }
    return {
      ...r,
      result: makeResult({ code: 'reset', databaseChanged: true }),
    };
  });
}

export async function freezeTeg(): Promise<WithResult<bridge.TegRewriteResult>> {
  return withWriteLock('冻结云控', async () => {
    const r = await bridge.tegFreeze();
    return {
      ...r,
      result: makeResult({
        code: 'frozen',
        // This writes SharedPreferences, not either database.
        databaseChanged: false,
        joyoseStopped: r.stopped ?? null,
        joyoseWasRunning: r.wasRunning ?? null,
        joyoseRestarted: r.restarted ?? null,
      }),
    };
  });
}

export async function unfreezeTeg(): Promise<WithResult<bridge.TegRewriteResult>> {
  return withWriteLock('解冻云控', async () => {
    const r = await bridge.tegUnfreeze();
    return {
      ...r,
      result: makeResult({
        code: 'unfrozen',
        databaseChanged: false,
        joyoseStopped: r.stopped ?? null,
        joyoseWasRunning: r.wasRunning ?? null,
        joyoseRestarted: r.restarted ?? null,
      }),
    };
  });
}

/** Digest of the databases as the newest recorded commit left them.
 *
 *  Only the first few records are scanned: a backup checkpoint carries no
 *  digest, and reading all ten costs ten shell calls for no extra safety. */
async function newestKnownDigest(): Promise<DbDigests | null> {
  // Order by seq, not by timestamp: `listHistory` sorts for display, and a
  // device whose clock moved backwards would otherwise hand back an older
  // record as "the newest one we know".
  const meta = (await listHistory()).sort((a, b) => b.seq - a.seq);
  for (const m of meta.slice(0, 3)) {
    try {
      const rec = await readHistory(m.name);
      if (rec.afterDigest) return rec.afterDigest;
    } catch {
      // An unreadable record is not a reason to block the rollback.
    }
  }
  return null;
}

/** Walk the commit chain from the working tree (`pristineSnapshot`) back to
 * the post-state of `targetSeq`, then rehydrate the result. Semantics mirror
 * `git checkout <commit>`: you land on the state at the end of that commit.
 * To see the pre-state of commit N, restore to commit N-1 instead.
 *
 *  IO lives here; every decision (floor, marker record, digests, replay) is in
 *  `planRestore`, a pure function, so each refusal path has a test. */
export async function restoreToRecord(targetSeq: number): Promise<void> {
  if (!state.pristineSnapshot) {
    throw new Error('working tree 未初始化，先在概览点刷新');
  }
  const floor = getHistoryFloor();
  const meta = await listHistory();
  const targetMeta = meta.find((m) => m.seq === targetSeq);
  if (!targetMeta) {
    throw new Error(`未找到 seq=${targetSeq} 的历史记录`);
  }
  const targetRecord = await readHistory(targetMeta.name);
  const newerRecords: HistoryRecord[] = [];
  for (const m of meta) {
    if (m.seq > targetSeq) newerRecords.push(await readHistory(m.name));
  }
  // Only ask the device what "correct" is when a record can answer. On a
  // history written before v1.2.0 there is no digest, and the call would be
  // spent on a check that cannot run.
  const anchorDigest = await newestKnownDigest();
  const nowDigest = anchorDigest ? await bridge.digest().catch(() => null) : null;
  const plan = planRestore({
    targetSeq,
    floor,
    meta,
    newerRecords,
    targetRecord,
    anchorDigest,
    nowDigest,
    current: state.pristineSnapshot,
  });
  if (!plan.ok) throw new Error(plan.message);
  rehydrateFromSnapshot(plan.snapshot);
  state.dirty = true;
}

/** After a file-level revert the old delta chain is no longer replayable.
 *  Record the newest seq that predates it; new commits continue above it. */
async function markHistoryFloor(): Promise<void> {
  try {
    const hist = await listHistory();
    const max = hist.reduce((m, h) => Math.max(m, h.seq), 0);
    if (max > 0) setHistoryFloor(max);
    await whenPrefsPersisted();
  } catch {
    // History unreadable: the revert itself already succeeded and reported its
    // own status; do not turn a successful restore into a failure.
  }
}

function rehydrateFromSnapshot(snap: ConfigSnapshot): void {
  // Rebuild, do not patch. The old loop walked the snapshot and skipped any
  // config that was missing from the working copy (`if (!state.cloudConfig[name])
  // continue`), and stopped short of the snapshot's length for teg rows. After
  // rolling back to a version with fewer rows, the extra rows stayed in the
  // working copy — so the "restored" config still contained what the user
  // asked to undo, and the next commit wrote them straight back.
  const next: Record<string, any> = {};
  for (const [name, params] of Object.entries(snap.smartp.cloud_config ?? {})) {
    // `meta` is not part of the snapshot: it carries the locked version and the
    // parse status, which describe the row as it exists now, not as it was.
    const current = state.cloudConfig[name];
    next[name] = current ? { ...current, params } : { meta: {}, params };
  }
  state.cloudConfig = next;

  const rules: Record<string, any[]> = {};
  for (const [module, contents] of Object.entries(snap.teg.rules ?? {})) {
    const current = state.rulesByModule[module] ?? [];
    rules[module] = (contents as any[]).map((content, i) => {
      const row = current[i];
      // Rows that did not exist in the working copy become new teg rows; the
      // commit path inserts them (see applyTegWrites).
      return row ? { ...row, content } : { meta: { rule_module: module, _real: false }, content };
    });
  }
  state.rulesByModule = rules;

  if (state.cloudConfig.booster_config) {
    state.paths = detectPaths(state.cloudConfig.booster_config.params ?? {});
  }
}

// ---- history helpers exposed to views -----------------------------------
export async function listHistory(): Promise<HistoryFileMeta[]> {
  const names = await bridge.historyList();
  return names
    .map((n) => parseHistoryFilename(n))
    .filter((m): m is HistoryFileMeta => !!m)
    .sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
}

export async function readHistory(name: string): Promise<HistoryRecord> {
  return JSON.parse(await bridge.historyGet(name));
}

/**
 * Write a marker history entry noting that a raw DB backup was taken.
 * Empty delta = timeline anchor, no state transition. Restoration still
 * goes through `bridge.revert(backupName)` (file-level DB copy), unrelated
 * to the commit chain. File size: ~200 bytes.
 */
export async function recordBackupCheckpoint(backupName: string): Promise<void> {
  const existing = await bridge.historyList();
  const seq = nextSeq(existing);
  const ts = Math.floor(Date.now() / 1000);
  const rec = buildRecord({
    seq,
    timestamp: ts,
    source: 'backup',
    note: backupName,
    delta: [],
    // A marker with no delta has nothing to replay: offering it as a rollback
    // target would silently do nothing and still look like a restore.
    canRevert: false,
  });
  await bridge.historySave(buildHistoryFilename(ts, seq), JSON.stringify(rec));
  await bridge.historyClear(HISTORY_KEEP).catch(() => null);
}

export function buildHistoryStore() {
  return new DriverBackedStore({
    async listNames() {
      return bridge.historyList();
    },
    async readText(name: string) {
      return bridge.historyGet(name);
    },
    async writeText(name: string, content: string) {
      await bridge.historySave(name, content);
    },
    async remove() {
      // bridge.historyClear(keep) handles bulk remove; single-file remove is
      // deliberately not exposed.
      throw new Error('direct history removal not supported — use historyClear()');
    },
  });
}
