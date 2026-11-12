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
  if (state.stat?.smartp.exists) {
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
      bridge.pull('smartp'),
      bridge.pull('teg'),
    ]);

    // open + extract
    const dbS = await openDb(smartpBytes);
    const dbT = await openDb(tegBytes);
    try {
      readIntoState(dbS, dbT);
    } finally {
      closeDb(dbS);
      closeDb(dbT);
    }

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

function readIntoState(dbS: Database, dbT: Database) {
  const cc: Record<string, any> = {};
  for (const row of listCloudConfig(dbS)) {
    cc[row.config_name] = {
      meta: row,
      params: parseParams(row.params),
    };
  }
  state.cloudConfig = cc;

  const byModule: Record<string, any[]> = {};
  for (const row of listRules(dbT)) {
    const mod = row.rule_module ?? 'unknown';
    if (!byModule[mod]) byModule[mod] = [];
    try {
      byModule[mod].push({ meta: row, content: parseParams(row.rule_content) });
    } catch {
      // keep the raw row even if JSON is malformed
      byModule[mod].push({ meta: row, content: row.rule_content });
    }
  }
  state.rulesByModule = byModule;

  const booster = cc.booster_config?.params ?? {};
  state.paths = detectPaths(booster);
  state.activeBackend = detectActiveBackend(booster);
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
  const current = Number(cc.meta.version ?? cc.params?.header?.version ?? 0);
  const locked = rewriteYear(current);
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
    recordStop(await bridge.push('smartp', outSmartp));
    // only touch teg if we actually have rows to write
    if (Object.values(state.rulesByModule).some((rows) => rows.length > 0)) {
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
