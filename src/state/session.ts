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
  insertRuleRow,
  updateCloudConfigParams,
  updateRuleContentById,
} from '@/db/dbio';
import { mergeOntoRaw, pickSmartpVersion, planSmartpWrite } from '@/db/merge';
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
  type HistoryFileMeta,
  type HistoryRecord,
  type HistorySource,
} from '@/history/store';
import { diff, applyDelta, invertDelta } from '@/history/diff';
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
} from '@/state/source';

/** "Empty config": params null / not an object / no keys at all (the cloud
 *  did ship a row but only `{}`). Treated as "not yet delivered" — no version
 *  shown, not lockable, not written back. */
function isEmptyCloudParams(p: unknown): boolean {
  return (
    !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p as object).length === 0
  );
}

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
  /** Raw deep copy of teg_config's rule envelopes, grouped by module. Edited
   *  rows live in `rulesByModule`; this copy never changes while the page is
   *  open, so "what teg actually had" stays answerable after an edit. */
  tegRaw: Record<string, any[]>;
  /** Per-source baselines captured at pull time. `history` is the working copy
   *  the history delta is computed against; `smartp` / `teg` are the two source
   *  copies, kept apart so a write target can be diffed against its own DB. */
  baselines: {
    smartp: Record<string, unknown>;
    teg: Record<string, unknown>;
    history: ReturnType<typeof snapshotFromMaps> | null;
  };
  /** Parsed rule_content JSON arrays grouped by rule_module. */
  rulesByModule: Record<string, any[]>;
  /** V3 path detection result (refreshed whenever booster_config is re-parsed). */
  paths: V3PathStatus[];
  /** Which insertion backend this device actually uses. Drives which editor
   * panel the UI surfaces. `null` until a pull completes or when no backend
   * is detectable (e.g. unrelated ROM). */
  activeBackend: ActiveBackend;
  /** Snapshot of the state captured on pull — used as `before` for history records. */
  pristineSnapshot: ReturnType<typeof snapshotFromMaps> | null;
  dirty: boolean;
  /** Outcome of the last write: whether Joyose was confirmed stopped, and
   *  whether it was brought back afterwards (i.e. it has already re-read the
   *  DBs, so the next game launch picks the edit up). `null` while unknown
   *  (helper too old to report it). */
  applyStatus: { stopped: boolean | null; started: boolean | null; at: number } | null;
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
  tegRaw: {},
  baselines: { smartp: {}, teg: {}, history: null },
  rulesByModule: {},
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

export async function pullAll(): Promise<void> {
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
    // Freeze the two source copies separately from the working copy. Written
    // here (not inside readIntoState) so a rebase mid-commit does not reset
    // them: a rebase deliberately keeps the user's working copy.
    state.baselines = {
      smartp: JSON.parse(JSON.stringify(state.smartpRaw)),
      teg: tegParamsByModule(),
      history: state.pristineSnapshot,
    };
    state.dirty = false;
    state.applyStatus = null;
    state.rebasedAt = null;
    state.lastError = null;
  } catch (err: any) {
    state.lastError = err?.message ?? String(err);
  } finally {
    state.loading = false;
  }
}

/** The params of teg's newest envelope, per module, as read at pull time. */
function tegParamsByModule(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [mod, rows] of Object.entries(state.tegRaw)) {
    let best: any = null;
    let bestV = -1;
    for (const r of rows) {
      const v = Number(r?.content?.version ?? r?.meta?.rule_version ?? 0);
      if (v >= bestV) {
        bestV = v;
        best = r;
      }
    }
    const p = best?.content?.params;
    if (p !== undefined) out[mod] = JSON.parse(JSON.stringify(p));
  }
  return out;
}

function readIntoState(dbS: Database | null, dbT: Database | null) {
  const cc: Record<string, any> = {};
  const smartpRaw: Record<string, any> = {};
  if (dbS) {
    for (const row of listCloudConfig(dbS)) {
      const params = parseParams(row.params);
      // `{}` is not "never delivered": keep the row, flag it empty, and let the
      // UI / lock / push treat it as "nothing to work with" explicitly.
      const empty = isEmptyCloudParams(params);
      cc[row.config_name] = { meta: { ...row, _real: true, empty }, params };
      smartpRaw[row.config_name] = JSON.parse(JSON.stringify(params));
    }
  }
  state.cloudConfig = cc;
  state.smartpRaw = smartpRaw;

  const byModule: Record<string, any[]> = {};
  const tegRaw: Record<string, any[]> = {};
  if (dbT) {
    for (const row of listRules(dbT)) {
      const mod = row.rule_module ?? 'unknown';
      if (!byModule[mod]) byModule[mod] = [];
      if (!tegRaw[mod]) tegRaw[mod] = [];
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
        tegRaw[mod].push({
          meta: { ...row, _real: true, empty: isEmptyCloudParams(envParams) },
          content: JSON.parse(JSON.stringify(content)),
        });
      } catch {
        // keep the raw row even if JSON is malformed
        byModule[mod].push({ meta: { ...row, _real: true, empty: false }, content: row.rule_content });
        tegRaw[mod].push({
          meta: { ...row, _real: true, empty: false },
          content: row.rule_content,
        });
      }
    }
  }
  state.rulesByModule = byModule;
  state.tegRaw = tegRaw;

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

/** The row Joyose treats as current for a module: highest `rule_version`
 * (an insert ordinal), not highest envelope version. The rules table keeps
 * every historical release, so "the module" is ambiguous without this. */
export function currentRuleRow<T extends { meta: { rule_version?: unknown } }>(
  rows: T[],
): T | null {
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestVersion = Number(best.meta?.rule_version ?? 0);
  if (!Number.isFinite(bestVersion)) bestVersion = 0;
  for (const row of rows.slice(1)) {
    const v = Number(row.meta?.rule_version ?? 0);
    if (Number.isFinite(v) && v > bestVersion) {
      best = row;
      bestVersion = v;
    }
  }
  return best;
}

/** Version used when teg needs a new mirror row and SmartP offers none. */
export const COMMON_CONFIG_VERSION = 2024010101;

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
  state.rulesByModule[name] = [
    {
      meta: { rule_version: COMMON_CONFIG_VERSION, _real: true, empty: false },
      content: refreshEnvelope(null, cc.params, COMMON_CONFIG_VERSION, name),
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
export async function saveJsonTarget(
  target: JsonTarget,
  jsonText: string,
): Promise<{ ok: true; target: string }> {
  return withWriteLock('参数树写入', () => saveJsonTargetLocked(target, jsonText));
}

async function saveJsonTargetLocked(
  target: JsonTarget,
  jsonText: string,
): Promise<{ ok: true; target: string }> {
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
  await ensureBackup('json-edit');

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
    const res = await bridge.push('smartp', out);
    state.applyStatus = { stopped: res.stopped ?? null, started: null, at: Date.now() };
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
    const res = await bridge.push('teg', out);
    state.applyStatus = { stopped: res.stopped ?? null, started: null, at: Date.now() };
  }

  const restarted = await bridge.restart().catch(() => null);
  if (restarted && typeof restarted.stopped === 'boolean') {
    state.applyStatus = {
      stopped: state.applyStatus?.stopped === false ? false : restarted.stopped,
      started: restarted.started ?? null,
      at: Date.now(),
    };
  }

  // Rebuild from the DB so the editor shows what actually landed. A failure
  // here does not invalidate the write.
  await pullAll().catch(() => null);
  return { ok: true, target };
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
 *  only way back, so a missing backup means the write must not start. */
async function ensureBackup(label?: string): Promise<void> {
  try {
    const res = await bridge.backup(label, { restore: false });
    if (!res?.ok || !res.dir) {
      throw new Error('备份命令没有返回备份目录');
    }
  } catch (err: any) {
    throw new Error(`自动备份失败，已中止写入：${err?.message ?? String(err)}`);
  }
}

/** Re-read the DB digests and store them as the conflict-detection baseline. */export async function refreshBaseline(): Promise<void> {
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

/** Commit the in-memory edits: build history record, write both DBs, save
 * history, refresh state. Returns the history filename written. */
async function pushCore(opts: PushOptions = {}): Promise<string> {
  try {
    // Which database(s) this commit may touch. Global setting, honoured by
    // every page — see the "来源与写入" panel.
    const writeTarget = getWriteTarget();
    const writeSmartp = writeTarget === 'both' || writeTarget === 'smartp';
    const writeTeg = writeTarget === 'both' || writeTarget === 'teg';

    if (!opts.force) {
      const fresh = await bridge.digest().catch(() => null);
      const check = (label: string, baseline: string | null, current: string | null) => {
        if (!baseline || !current || baseline === current) return;
        throw new ConflictError(
          `${label} 在拉取后被改动过（${current.slice(0, 12)} ≠ ${baseline.slice(0, 12)}）。`,
        );
      };
      // Only the database we are about to write can conflict with us; a teg
      // update must not block a SmartP-only commit.
      if (fresh) {
        if (writeSmartp) check('SmartP.db', state.baselineSmartp, fresh.smartp);
        if (writeTeg) check('teg_config.db', state.baselineTeg, fresh.teg);
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

    // auto-backup — abort when it does not land. A commit whose restore point
    // silently failed is exactly the commit the user cannot walk back later.
    await ensureBackup();

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
      const diskParams: Record<string, any> = {};
      if (dbS) {
        for (const row of listCloudConfig(dbS)) {
          diskParams[row.config_name] = parseParams(row.params);
        }
      }
      for (const [name, obj] of dbS ? Object.entries(state.cloudConfig) : []) {
        // Only rows that genuinely exist in SmartP and carry content: a config
        // that arrived from the teg fallback must never be written into SmartP,
        // and an empty row has nothing to write.
        if (obj.meta?._real !== true || obj.meta?.empty || obj.meta?.fromTeg) continue;
        const raw = diskParams[name];
        const plan = planSmartpWrite({
          raw,
          workBefore: workBase[name],
          workAfter: obj.params,
          source: obj.meta?.source,
        });
        if (!plan.write) continue;
        const serialized = stringifyParams(plan.params);
        if (stringifyParams(raw) === serialized) continue;
        // Keep SmartP's own version column unless the user locked it: the
        // reconciled meta.version may come from teg, and copying it here would
        // silently move SmartP's version forward on every source switch.
        const version = pickSmartpVersion(obj.meta);
        if (dbS) updateCloudConfigParams(dbS, name, serialized, version);
        writtenRaw[name] = plan.params;
      }
      for (const [module, rows] of dbT ? Object.entries(state.rulesByModule) : []) {
        // When rules table is empty (redmi style), skip.
        if (rows.length === 0) continue;
        const row = currentRuleRow(rows);
        if (!row) continue;
        // Same rule for the mirror: never write a row the DB does not have, and
        // skip empty envelopes so a placeholder cannot erase real content.
        if (row.meta?._real !== true || row.meta?.empty) continue;
        // Resolve the target *against the DB we are about to write*, not
        // against our (possibly stale) in-memory copy: Joyose may have
        // appended a newer revision between pull and push.
        if (!dbT) continue;
        const id = latestRuleIdForModule(dbT, module);
        if (id === null) {
          // The mirror row was created in memory above; insert it now instead of
          // silently dropping the write.
          insertRuleRow(dbT, module, JSON.stringify(row.content), COMMON_CONFIG_VERSION);
          continue;
        }
        updateRuleContentById(dbT, id, JSON.stringify(row.content));
      }

      outSmartp = dbS ? exportDb(dbS) : null;
      outTeg = dbT ? exportDb(dbT) : null;
    } finally {
      if (dbS) closeDb(dbS);
      if (dbT) closeDb(dbT);
    }

    const recordBefore = state.pristineSnapshot ??
      snapshotFromMaps({ cloudConfig: state.cloudConfig, rulesByModule: state.rulesByModule });
    const recordAfter = snapshotFromMaps({
      cloudConfig: state.cloudConfig,
      rulesByModule: state.rulesByModule,
    });

    // persist DBs first, so if anything fails we can re-sync
    const stops: boolean[] = [];
    const recordStop = (r: { stopped?: boolean }) => {
      if (typeof r?.stopped === 'boolean') stops.push(r.stopped);
    };
    // Uploading a DB costs one ksu.exec round-trip per 48 KB of base64 — about
    // 30 calls per MB. Skip the ones whose bytes came back unchanged: editing
    // a SmartP-only config used to re-upload the 1 MB teg mirror for nothing.
    if (outSmartp && smartpBytes && !sameBytes(outSmartp, smartpBytes)) {
      recordStop(await bridge.push('smartp', outSmartp));
      // The row on disk is now what we just wrote. Keeping the pre-commit copy
      // would make the next commit in this session merge onto a stale base.
      for (const [name, params] of Object.entries(writtenRaw)) {
        state.smartpRaw[name] = JSON.parse(JSON.stringify(params));
      }
    }
    // only touch teg if we actually have rows to write
    if (
      outTeg &&
      tegBytes &&
      Object.values(state.rulesByModule).some((rows) => rows.length > 0) &&
      !sameBytes(outTeg, tegBytes)
    ) {
      recordStop(await bridge.push('teg', outTeg));
    }

    // write history after successful DB push. v2 records store only the
    // forward delta (parent -> this); reconstruction walks the chain from
    // pristineSnapshot. Keeps each file in the KB range.
    const delta = diff(recordBefore, recordAfter);
    const existing = await bridge.historyList();
    const seq = nextSeq(existing);
    const ts = Math.floor(Date.now() / 1000);
    const rec = buildRecord({
      seq,
      timestamp: ts,
      source: opts.source ?? 'webui',
      note: opts.note ?? '',
      delta,
    });
    const fname = buildHistoryFilename(ts, seq);
    await bridge.historySave(fname, JSON.stringify(rec));
    // Keep the timeline short: one delta record per commit adds up on a phone
    // with a 1 MB cloud config, and ten entries is plenty to walk back.
    await bridge.historyClear(HISTORY_KEEP).catch(() => null);

    // Restart Joyose so it re-reads the DB. Report the result instead of
    // swallowing it: a silent failure here looks like "the edit did nothing".
    const restarted = await bridge.restart().catch(() => null);
    if (restarted) recordStop(restarted);
    state.applyStatus = {
      stopped: stops.length > 0 ? stops.every(Boolean) : null,
      started: restarted?.started ?? null,
      at: Date.now(),
    };

    state.pristineSnapshot = recordAfter;
    state.dirty = false;
    await refreshStat();
    await refreshBaseline();
    return fname;
  } catch (err) {
    // ConflictError bubbles to pushAll, which rebases and retries; anything
    // else is a genuine failure and must reach the user.
    throw err;
  }
}

/** Re-apply the pending edits on top of whatever Joyose just wrote.
 *
 *  The user's changes are expressed as a delta against pristineSnapshot; we
 *  pull the fresh DBs, restore the per-row metadata (a locked version must not
 *  be undone by the rebase), and replay the delta onto the new base. Nothing
 *  is discarded except a change the cloud made to the exact same field. */
async function rebaseOntoLatest(): Promise<void> {
  const baseSnap =
    state.pristineSnapshot ??
    snapshotFromMaps({ cloudConfig: state.cloudConfig, rulesByModule: state.rulesByModule });
  const delta = diff(baseSnap, snapshotFromMaps({
    cloudConfig: state.cloudConfig,
    rulesByModule: state.rulesByModule,
  }));

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
  rehydrateFromSnapshot(applyDelta(newestSnap, delta));
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

async function withWriteLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (writeBusy) {
    throw new Error(`上一个写入操作尚未结束，暂时不能${label}，请稍后再试`);
  }
  writeBusy = true;
  try {
    return await fn();
  } finally {
    writeBusy = false;
  }
}

export function isWriteBusy(): boolean {
  return writeBusy;
}

/** Public commit entry point: on a conflict, rebase onto the fresh DBs and
 *  retry (up to 3 attempts) before surfacing the error. */
export async function pushAll(opts: PushOptions = {}): Promise<string> {
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
 * bridge, and every mutating entry point has exactly one implementation. */
export async function backupNow(label?: string) {
  return withWriteLock('备份', () => bridge.backup(label));
}

export async function revertToBackup(name: string) {
  return withWriteLock('回滚', () => bridge.revert(name));
}

export async function revertLatestBackup() {
  return withWriteLock('回滚', () => bridge.revertLatest());
}

export async function resetCloudData(): Promise<void> {
  await withWriteLock('重置云控', () => bridge.resetCloud());
}

export async function freezeTeg() {
  return withWriteLock('冻结云控', () => bridge.tegFreeze());
}

export async function unfreezeTeg() {
  return withWriteLock('解冻云控', () => bridge.tegUnfreeze());
}

/** Walk the commit chain from the working tree (`pristineSnapshot`) back to
 * the post-state of `targetSeq`, applying inverse deltas, then rehydrate
 * the resulting snapshot into the in-memory state. Semantics mirror
 * `git checkout <commit>`: you land on the state at the end of that commit.
 * To see the pre-state of commit N, restore to commit N-1 instead. */
export async function restoreToRecord(targetSeq: number): Promise<void> {
  if (!state.pristineSnapshot) {
    throw new Error('working tree 未初始化，先在概览点刷新');
  }
  const meta = await listHistory();
  const newer = meta.filter((m) => m.seq > targetSeq);
  if (!meta.some((m) => m.seq === targetSeq)) {
    throw new Error(`未找到 seq=${targetSeq} 的历史记录`);
  }

  let snap: ConfigSnapshot = JSON.parse(JSON.stringify(state.pristineSnapshot));
  for (const m of newer) {
    const rec = await readHistory(m.name);
    snap = applyDelta(snap, invertDelta(rec.delta));
  }
  rehydrateFromSnapshot(snap);
  state.dirty = true;
}

function rehydrateFromSnapshot(snap: ConfigSnapshot): void {
  // snapshot only carries parsed content; preserve meta from current state
  for (const [name, params] of Object.entries(snap.smartp.cloud_config)) {
    if (!state.cloudConfig[name]) continue;
    state.cloudConfig[name].params = params;
  }
  for (const [module, contents] of Object.entries(snap.teg.rules)) {
    const rows = state.rulesByModule[module];
    if (!rows) continue;
    for (let i = 0; i < rows.length && i < contents.length; i++) {
      rows[i].content = contents[i];
    }
  }
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
