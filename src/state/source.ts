// Source-of-truth selection for booster_config / common_config.
//
// Joyose keeps the same cloud JSON in two databases:
//   - SmartP.db  cloud_config.params            (key column version, e.g. 2026042590)
//   - teg_config.db rules.rule_content          (an envelope { ..., version,
//                                                 params } with several rows of
//                                                 history per module)
// The two `version` numbers use the SAME YYYYMMDDxx scheme, but the rules
// table also has an internal `rule_version` (a monotonically increasing
// ordinal like 649438) that must NOT be compared against SmartP's version.
// The envelope.version is the comparable one.
//
// Choice policy:
//   · common_config defaults to SmartP.db — its teg mirror is frequently
//     stub / incomplete, so the user must opt into teg explicitly. `auto` is
//     still selectable; on equal versions it resolves to SmartP.
//   · booster_config follows a user preference:
//       auto   -> the side with the higher envelope.version wins
//       smartp -> always SmartP.db
//       teg    -> always the latest teg row
//   · When teg is selected, the row with the highest envelope.version is used
//     (the rules table keeps multiple historical releases).

export type BoosterSourcePref = 'auto' | 'smartp' | 'teg';

const BOOSTER_KEY = 'joyose-edit.boosterSource';
const COMMON_KEY = 'joyose-edit.commonSource';
const WRITE_KEY = 'joyose-edit.writeTarget';
const DATA_SOURCE_KEY = 'joyose-edit.dataSource';
const INSTALL_TS_KEY = 'joyose-edit.installTs';
/** Highest history seq that must not be replayed: a file-level revert replaced
 *  the databases underneath the old delta chain. Persisted so the guard still
 *  holds after the WebUI is reopened. */
const HISTORY_FLOOR_KEY = 'joyose-edit.historyFloor';
/** Pre-lock version per config. Without this, a refresh rebuilt the working
 *  copy from the DB and "unlock" could only see the 2099 value it was trying to
 *  undo. */
const LOCKED_VERSIONS_KEY = 'joyose-edit.lockedVersions';

const ALL_KEYS = [
  BOOSTER_KEY,
  COMMON_KEY,
  WRITE_KEY,
  DATA_SOURCE_KEY,
  INSTALL_TS_KEY,
  HISTORY_FLOOR_KEY,
  LOCKED_VERSIONS_KEY,
];

// Preferences live in /data/adb/joyose-edit/settings.json (see prefs-read /
// prefs-write in the helper), *not* only in localStorage.
//
// The WebUI runs inside whatever WebView the manager provides, and that storage
// is keyed by origin: Magisk's embedded server hands out a fresh port every
// launch, KSU's asset loader domain has changed between versions, and any
// "clear WebView data" wipes it. When that happened the pickers silently fell
// back to the defaults — the settings looked like they never applied.
//
// The in-memory cache is what every getter reads, so callers stay synchronous;
// hydratePrefs() seeds it from the file once at boot and each setter writes the
// whole object back through the helper.
const cache = new Map<string, string>();
let hydratePromise: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();
/** Why the last settings write failed, or null when it went through. */
let persistError: string | null = null;
/** Whether the settings file had any content at boot — see prefsFileExisted. */
let fileExisted = false;

function lsGet(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the file copy is authoritative */
  }
}

function lsRemove(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = cache.get(key) ?? lsGet(key);
  if (v && (allowed as readonly string[]).includes(v)) return v as T;
  return fallback;
}

function writePref(key: string, value: string): void {
  cache.set(key, value);
  lsSet(key, value);
  queuePersist();
}

async function persistNow(): Promise<void> {
  try {
    const bridge = await import('@/root/bridge');
    await bridge.writePrefs(JSON.stringify(Object.fromEntries(cache)));
    persistError = null;
  } catch (err) {
    // Non-KSU host: nothing to write to, and localStorage still works.
    persistError = (err as Error)?.message ?? String(err);
  }
}

/** Why the last settings write failed, or null when it went through. */
export function getPersistError(): string | null {
  return persistError;
}

/** Serialise the writes so two quick changes cannot land out of order. */
function queuePersist(): void {
  writeChain = writeChain.then(persistNow, persistNow);
}

/** Load the settings file into the cache. Call once before the app mounts (and
 *  before comparing the install marker). Concurrent callers share the same
 *  promise, so nobody reads the cache while it is still being filled. */
export function hydratePrefs(): Promise<void> {
  if (!hydratePromise) hydratePromise = loadPrefs();
  return hydratePromise;
}

async function loadPrefs(): Promise<void> {
  let fromFile: Record<string, unknown> = {};
  try {
    const bridge = await import('@/root/bridge');
    const parsed = JSON.parse(await bridge.readPrefs());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fromFile = parsed as Record<string, unknown>;
    }
  } catch {
    /* keep whatever localStorage still holds */
  }
  for (const [k, v] of Object.entries(fromFile)) {
    if (typeof v === 'string') {
      cache.set(k, v);
      lsSet(k, v);
    }
  }
  // Migrate: a user upgrading from a build that only had localStorage keeps
  // their choice, and the first write then persists the whole object.
  for (const key of ALL_KEYS) {
    if (cache.has(key)) continue;
    const v = lsGet(key);
    if (v) cache.set(key, v);
  }
  fileExisted = Object.keys(fromFile).length > 0;
}

/** True when settings.json already carried values at boot. The install-marker
 *  reset only applies to an *existing* file: on the first run of a build that
 *  introduced the file, a cleared WebView must not count as "fresh install"
 *  and wipe the choices the user is about to make. */
export function prefsFileExisted(): boolean {
  return fileExisted;
}

/** Flush any queued write. Exported for tests / shutdown paths. */
export function whenPrefsPersisted(): Promise<void> {
  return writeChain;
}

/** The newest seq that predates a file-level revert, or 0 when no revert has
 *  happened. Records at or below it describe a database that no longer exists. */
export function getHistoryFloor(): number {
  const v = cache.get(HISTORY_FLOOR_KEY) ?? lsGet(HISTORY_FLOOR_KEY);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function setHistoryFloor(seq: number): void {
  if (!Number.isFinite(seq) || seq <= 0) return;
  writePref(HISTORY_FLOOR_KEY, String(seq));
}

/** Config name → the version that was in place before the user locked it. */
export function getLockedVersions(): Record<string, number> {
  const raw = cache.get(LOCKED_VERSIONS_KEY) ?? lsGet(LOCKED_VERSIONS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function setLockedVersion(config: string, original: number): void {
  if (!Number.isFinite(original)) return;
  const map = getLockedVersions();
  if (typeof map[config] === 'number') return;
  map[config] = original;
  writePref(LOCKED_VERSIONS_KEY, JSON.stringify(map));
}

export function clearLockedVersion(config: string): void {
  const map = getLockedVersions();
  if (!(config in map)) return;
  delete map[config];
  writePref(LOCKED_VERSIONS_KEY, JSON.stringify(map));
}

// ----- booster_config source -------------------------------------------------

export function getBoosterSourcePref(): BoosterSourcePref {
  return readPref(BOOSTER_KEY, ['auto', 'smartp', 'teg'] as const, 'auto');
}

export function setBoosterSourcePref(v: BoosterSourcePref): void {
  writePref(BOOSTER_KEY, v);
}

// ----- common_config source (independent from booster_config) -----------------

/** Defaults to SmartP.db — the teg mirror of common_config is frequently
 *  stub/incomplete, so the user must opt into teg explicitly. `auto` is a valid
 *  choice too: it compares envelope.version and still lands on SmartP on a tie
 *  (see pickBoosterParams). Not allowing it here meant the picker wrote
 *  "auto" to disk but every later boot silently read it back as SmartP. */
export function getCommonSourcePref(): BoosterSourcePref {
  return readPref(COMMON_KEY, ['auto', 'smartp', 'teg'] as const, 'smartp');
}

export function setCommonSourcePref(v: BoosterSourcePref): void {
  writePref(COMMON_KEY, v);
}

// ----- write target (覆写逻辑) ------------------------------------------------

export type WriteTarget = 'both' | 'smartp' | 'teg';

/** Which database(s) a commit should write to. Global — every view's push
 *  (including DB version lock, unlocked-fps, thermal unlock, …) honours it.
 *  Defaults to 'both' (mirror both DBs, the historical behaviour). */
export function getWriteTarget(): WriteTarget {
  return readPref(WRITE_KEY, ['both', 'smartp', 'teg'] as const, 'both');
}

export function setWriteTarget(v: WriteTarget): void {
  writePref(WRITE_KEY, v);
}

// ----- data source policy (SmartP only vs teg fallback) ----------------------

export type DataSourcePref = 'smartp' | 'teg-fallback';

/** - smartp       : SmartP only (matches the upstream behaviour). When SmartP
 *                  has no content for a config the related page stays disabled.
 *  - teg-fallback : when SmartP lacks the content (or holds an empty row), the
 *                  teg envelope is used instead, and every later edit / lock
 *                  writes to teg_config.db only. */
export function getDataSourcePref(): DataSourcePref {
  return readPref(DATA_SOURCE_KEY, ['smartp', 'teg-fallback'] as const, 'smartp');
}

export function setDataSourcePref(v: DataSourcePref): void {
  writePref(DATA_SOURCE_KEY, v);
}

// ----- install marker -------------------------------------------------------

/** Timestamp stamped by customize.sh on a fresh install / reinstall, consumed
 *  once by the WebUI to reset per-device preferences (an upgrade keeps them).
 *  Kept in the settings file too, so it cannot outlive the preferences it
 *  guards (or vice versa) after the WebView storage is cleared. */
export function getStoredInstallTs(): string {
  return cache.get(INSTALL_TS_KEY) ?? lsGet(INSTALL_TS_KEY) ?? '';
}

export function storeInstallTs(ts: string): void {
  writePref(INSTALL_TS_KEY, ts);
}

/** Reset every local preference so a reinstall starts from the defaults:
 *  write target = both, booster source = auto, common source = smartp. */
export function resetAllPrefs(): void {
  cache.clear();
  for (const key of ALL_KEYS) lsRemove(key);
  queuePersist();
}

// ----- labels ---------------------------------------------------------------

export const PREF_LABELS: Record<BoosterSourcePref, string> = {
  auto: '自动（版本较新者优先）',
  smartp: 'SmartP.db（cloud_config）',
  teg: 'teg_config.db（rules）',
};

export const WRITE_TARGET_LABELS: Record<WriteTarget, string> = {
  both: '同时写 SmartP.db + teg_config.db（默认）',
  smartp: '仅 SmartP.db（cloud_config）',
  teg: '仅 teg_config.db（rules）',
};

export const DATA_SOURCE_LABELS: Record<DataSourcePref, string> = {
  smartp: '仅 SmartP（默认）',
  'teg-fallback': '允许 teg 兜底',
};

// ----- pure picking logic ---------------------------------------------------

export interface SmartRowLike {
  meta?: { version?: number | null };
  params?: any;
}

export interface TegRowLike {
  meta?: { rule_version?: number | null };
  content?: unknown;
}

/** Latest comparable envelope.version across teg rows (0 when none usable).
 *  Used by the Overview to show SmartP vs teg versions side by side. */
export function latestEnvelopeVersion(tegRows: TegRowLike[] | undefined): number {
  // Only envelope.version (the YYYYMMDDxx scheme) is comparable across DBs.
  // rule_version is an internal ordinal — using it here surfaces garbage like
  // 467472 / 706918 when the teg envelope has no version.
  let best = 0;
  for (const r of tegRows ?? []) {
    const env = r.content;
    const envParams =
      env && typeof env === 'object' && !Array.isArray(env) ? (env as any).params : null;
    if (!envParams || typeof envParams !== 'object') continue;
    const v = Number((env as any).version);
    if (Number.isFinite(v) && v > best) best = v;
  }
  return best;
}

export interface PickedBooster {
  params: any;
  /** The comparable version (envelope.version when teg wins, else smartp). */
  version: number;
  /** Which side the params came from. */
  source: 'smartp' | 'teg';
}

/** Decide which params to edit from the two candidate rows. Pure & testable.
 *  Returns null only when the smartp row is missing. */
export function pickBoosterParams(
  smartRow: SmartRowLike | undefined,
  tegRows: TegRowLike[] | undefined,
  pref: BoosterSourcePref,
): PickedBooster | null {
  if (!smartRow) return null;

  if (pref !== 'smartp' && Array.isArray(tegRows) && tegRows.length > 0) {
    let best: { version: number; params: any } | null = null;
    for (const r of tegRows) {
      const env = r.content;
      const envParams =
        env && typeof env === 'object' && !Array.isArray(env) ? (env as any).params : null;
      if (!envParams || typeof envParams !== 'object') continue;
      const v = Number((env as any).version);
      if (!Number.isFinite(v) || v <= 0) continue; // no usable envelope.version
      if (!best || v > best.version) best = { version: v, params: envParams };
    }
    if (best) {
      const smartV = Number(smartRow.meta?.version ?? 0);
      if (pref === 'teg' || best.version > smartV) {
        return { params: best.params, version: best.version, source: 'teg' };
      }
    }
  }

  return {
    params: smartRow.params,
    version: Number(smartRow.meta?.version ?? 0),
    source: 'smartp',
  };
}
