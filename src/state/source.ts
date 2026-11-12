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
//     stub / incomplete, so the user must opt into teg explicitly.
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

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && (allowed as readonly string[]).includes(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

function writePref(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
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
 *  stub/incomplete, so the user must opt into teg explicitly. */
export function getCommonSourcePref(): BoosterSourcePref {
  return readPref(COMMON_KEY, ['smartp', 'teg'] as const, 'smartp');
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
 *  once by the WebUI to reset per-device preferences (an upgrade keeps them). */
export function getStoredInstallTs(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(INSTALL_TS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storeInstallTs(ts: string): void {
  writePref(INSTALL_TS_KEY, ts);
}

/** Reset every local preference so a reinstall starts from the defaults:
 *  write target = both, booster source = auto, common source = smartp. */
export function resetAllPrefs(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(WRITE_KEY);
    localStorage.removeItem(BOOSTER_KEY);
    localStorage.removeItem(COMMON_KEY);
    localStorage.removeItem(INSTALL_TS_KEY);
    localStorage.removeItem(DATA_SOURCE_KEY);
  } catch {
    /* ignore */
  }
}

// ----- labels ---------------------------------------------------------------

export const PREF_LABELS: Record<BoosterSourcePref, string> = {
  auto: '自动（版本较新者优先）',
  smartp: 'SmartP.db（cloud_config）',
  teg: 'teg_config.db（rules 最新）',
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
