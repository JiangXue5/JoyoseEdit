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
