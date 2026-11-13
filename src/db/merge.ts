// Merge a user's edits onto the database's own params.
//
// The working copy shown in the UI may come from either database (the
// "来源与写入" setting lets booster_config/common_config be read from teg while
// the commit still writes SmartP). Writing that working copy back wholesale
// would copy teg-only fields into SmartP and silently drop SmartP fields teg
// has never heard of.
//
// So the commit computes the user's edits (before -> after) and applies only
// those paths to the raw SmartP params. Edits that never happened produce an
// empty delta and the raw value is returned untouched.

import { diff, applyDelta } from '@/history/diff';

export interface MergeInput {
  /** The database's own params, as read from SmartP. */
  raw: unknown;
  /** Working copy before the user's edits. */
  before: unknown;
  /** Working copy after the user's edits. */
  after: unknown;
}

export interface MergeResult {
  value: unknown;
  /** False when before and after are equivalent — nothing to write. */
  changed: boolean;
}

export function mergeOntoRaw({ raw, before, after }: MergeInput): MergeResult {
  const edits = diff({ v: before }, { v: after });
  if (edits.length === 0) return { value: raw, changed: false };
  return { value: (applyDelta({ v: raw }, edits) as { v: unknown }).v, changed: true };
}

export interface PlanSmartpWriteInput {
  /** The params currently stored in SmartP, read from the bytes we are about
   *  to write — not from anything cached in memory at pull time. */
  raw: unknown;
  /** Working copy at the moment of the last pull (the diff baseline). */
  workBefore: unknown;
  /** Working copy now, i.e. with the user's edits applied. */
  workAfter: unknown;
  /** meta.source of the working copy: 'smartp' | 'teg' | undefined. */
  source?: string | null;
}

export type SmartpWritePlan =
  | { write: false; reason: 'no-row' | 'teg-sourced' | 'unchanged' }
  | { write: true; params: unknown; reason: 'merged' | 'wholesale' };

/** Decide what (if anything) to write into SmartP's cloud_config row.
 *
 *  Two rules that the old inline code got wrong once the raw copy went stale:
 *    * the merge base is what is on disk *now*, so a second commit in the same
 *      session cannot roll back the first one;
 *    * a working copy that came from teg is never written wholesale, because
 *      that would replace SmartP's params with content SmartP never had. */
export function planSmartpWrite({
  raw,
  workBefore,
  workAfter,
  source,
}: PlanSmartpWriteInput): SmartpWritePlan {
  if (raw === undefined) return { write: false, reason: 'no-row' };
  if (workBefore === undefined) {
    if (source !== 'smartp') return { write: false, reason: 'teg-sourced' };
    const same = JSON.stringify(raw) === JSON.stringify(workAfter);
    return same
      ? { write: false, reason: 'unchanged' }
      : { write: true, params: workAfter, reason: 'wholesale' };
  }
  const merged = mergeOntoRaw({ raw, before: workBefore, after: workAfter });
  return merged.changed
    ? { write: true, params: merged.value, reason: 'merged' }
    : { write: false, reason: 'unchanged' };
}

export interface VersionMeta {
  fromTeg?: boolean;
  originalVersion?: unknown;
  version?: unknown;
  smartpVersion?: unknown;
}

/** Which version belongs in SmartP's own `version` column.
 *
 *  The working copy may have been reconciled from teg, in which case
 *  meta.version is teg's envelope version and must never be written into
 *  SmartP. A user-locked version wins; otherwise use SmartP's own column and
 *  leave the column alone when that value is unknown. */
export function pickSmartpVersion(meta: VersionMeta | undefined): number | undefined {
  if (!meta || meta.fromTeg) return undefined;
  if (typeof meta.originalVersion !== 'undefined') {
    return typeof meta.version === 'number' ? meta.version : undefined;
  }
  return typeof meta.smartpVersion === 'number' && meta.smartpVersion > 0
    ? meta.smartpVersion
    : undefined;
}

/** What a commit should report, given the structural diff and whether either
 *  database actually changed.
 *
 *  `no-change` must not write history or restart Joyose: an empty delta used to
 *  produce a history entry and a restart anyway, so a no-op looked exactly like
 *  a real submit. `out-of-scope` means the user did edit something, but the
 *  current write target excludes the config that changed — reporting success
 *  there is a lie, and the working copy must stay dirty. */
export function commitOutcome(
  deltaCount: number,
  wroteSmartp: boolean,
  wroteTeg: boolean,
): 'no-change' | 'out-of-scope' | 'written' {
  if (deltaCount === 0) return 'no-change';
  if (!wroteSmartp && !wroteTeg) return 'out-of-scope';
  return 'written';
}

/** A version the module itself locked (leading `2099`). Used by the UI badges,
 *  the unlock path and the persisted pre-lock value. */
export function isVersionLocked(v: unknown): boolean {
  return typeof v === 'number' && String(v).startsWith('2099');
}

/** The cloud-lock badge answers one question — "is the active cloud config's
 *  version locked?" — and used to be recomputed in two places from the same
 *  path. Keep the path in one spot so the badge and the header cannot drift.
 *
 *  Not to be confused with the teg SDK freeze (`pref_local_max_version`):
 *  that is a different mechanism with its own status call. */
export function isCloudLocked(configs: Record<string, any> | null | undefined): boolean {
  return isVersionLocked(configs?.booster_config?.meta?.version);
}

/** Re-attach persisted pre-lock versions after a pull.
 *
 *  The database only carries the `2099*` value, so the working copy has no way
 *  to know what the version was before locking. `locked` comes from the
 *  settings file. A config whose version is no longer locked is reported as
 *  stale so the caller can drop the record instead of resurrecting it later. */
export function applyLockedOriginals(
  configs: Record<string, any>,
  locked: Record<string, number>,
): { applied: string[]; stale: string[] } {
  const applied: string[] = [];
  const stale: string[] = [];
  for (const [name, original] of Object.entries(locked)) {
    const cfg = configs[name];
    if (!cfg) continue;
    if (isVersionLocked(cfg.meta?.version)) {
      cfg.meta.originalVersion = original;
      applied.push(name);
    } else {
      stale.push(name);
    }
  }
  return { applied, stale };
}
