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
  getStoredInstallTs,
  storeInstallTs,
  resetAllPrefs,
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
  /** Outcome of the last write: whether Joyose was confirmed stopped.
   * `null` while unknown (helper too old to report it). */
  applyStatus: { stopped: boolean | null; at: number } | null;
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
  paths: [],
  activeBackend: null,
  pristineSnapshot: null,
  dirty: false,
  applyStatus: null,
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
  // A fresh flash / reinstall / upgrade stamps a marker; when it moved, drop
  // the per-device preferences (write target back to `both`, …) so a WebView
  // localStorage left over from the previous install cannot silently persist.
  try {
    const ts = await bridge.moduleInstallTs();
    if (ts && ts !== '0' && ts !== getStoredInstallTs()) {
      resetAllPrefs();
      storeInstallTs(ts);
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
    state.dirty = false;
    state.applyStatus = null;
    state.lastError = null;
  } catch (err: any) {
    state.lastError = err?.message ?? String(err);
  } finally {
    state.loading = false;
  }
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
      } catch {
        // keep the raw row even if JSON is malformed
        byModule[mod].push({ meta: { ...row, _real: true, empty: false }, content: row.rule_content });
      }
    }
  }
  state.rulesByModule = byModule;

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
  row.content = refreshEnvelope(row.content as any, cc.params, v);
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

export interface PushOptions {
  note?: string;
  source?: HistorySource;
  /** If true, ignore the baseline digest mismatch and overwrite. */
  force?: boolean;
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

/** Commit the in-memory edits: build history record, write both DBs, save
 * history, refresh state. Returns the history filename written. */
export async function pushAll(opts: PushOptions = {}): Promise<string> {
  state.loading = true;
  try {
    if (!opts.force) {
      const fresh = await bridge.digest().catch(() => null);
      const check = (label: string, baseline: string | null, current: string | null) => {
        if (!baseline || !current || baseline === current) return;
        throw new Error(
          `${label} 在拉取后被改动过（${current.slice(0, 12)} ≠ ${baseline.slice(0, 12)}）。` +
            `请重新拉取，或强制覆盖。`,
        );
      };
      if (fresh) {
        check('SmartP.db', state.baselineSmartp, fresh.smartp);
        check('teg_config.db', state.baselineTeg, fresh.teg);
      }
    }

    // Auto-sync rules.rule_content from the matching cloud_config row, so
    // any edit made via the structured views propagates to the teg mirror
    // without the view layer needing to remember.
    for (const name of Object.keys(state.cloudConfig)) {
      if (state.rulesByModule[name]?.length) syncRuleContent(name);
    }

    // auto-backup
    await bridge.backup().catch(() => null);

    // re-pull current bytes, mutate, write back
    const [smartpBytes, tegBytes] = await Promise.all([bridge.pull('smartp'), bridge.pull('teg')]);
    const dbS = await openDb(smartpBytes);
    const dbT = await openDb(tegBytes);

    let outSmartp: Uint8Array;
    let outTeg: Uint8Array;
    try {
      // Only rewrite rows the user actually touched. Re-serialising every row
      // meant that a cloud push landing between our pull and our commit was
      // silently rolled back on every unrelated config, because we wrote the
      // whole in-memory snapshot back.
      const baseline = state.pristineSnapshot?.smartp?.cloud_config ?? {};
      for (const [name, obj] of Object.entries(state.cloudConfig)) {
        const serialized = stringifyParams(obj.params);
        if (baseline[name] !== undefined && JSON.stringify(baseline[name]) === serialized) {
          continue;
        }
        const version =
          typeof obj.meta.version === 'number' ? obj.meta.version : undefined;
        updateCloudConfigParams(dbS, name, serialized, version);
      }
      for (const [module, rows] of Object.entries(state.rulesByModule)) {
        // When rules table is empty (redmi style), skip.
        if (rows.length === 0) continue;
        const row = currentRuleRow(rows);
        if (!row) continue;
        // Resolve the target *against the DB we are about to write*, not
        // against our (possibly stale) in-memory copy: Joyose may have
        // appended a newer revision between pull and push.
        const id = latestRuleIdForModule(dbT, module);
        if (id === null) continue;
        updateRuleContentById(dbT, id, JSON.stringify(row.content));
      }

      outSmartp = exportDb(dbS);
      outTeg = exportDb(dbT);
    } finally {
      closeDb(dbS);
      closeDb(dbT);
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
    if (!sameBytes(outSmartp, smartpBytes)) {
      recordStop(await bridge.push('smartp', outSmartp));
    }
    // only touch teg if we actually have rows to write
    if (
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

    // Restart Joyose so it re-reads the DB. Report the result instead of
    // swallowing it: a silent failure here looks like "the edit did nothing".
    const restarted = await bridge.restart().catch(() => null);
    if (restarted) recordStop(restarted);
    state.applyStatus = {
      stopped: stops.length > 0 ? stops.every(Boolean) : null,
      at: Date.now(),
    };

    state.pristineSnapshot = recordAfter;
    state.dirty = false;
    await refreshStat();
    await refreshBaseline();
    return fname;
  } finally {
    state.loading = false;
  }
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
