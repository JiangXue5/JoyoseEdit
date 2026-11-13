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
