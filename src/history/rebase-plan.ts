// Replaying a pending edit set onto a database that moved underneath it.
//
// The rebase used to be `applyDelta(newest, delta)`, which returns a snapshot
// and says nothing about the paths it could not resolve. When the cloud pushed
// a new row set in the meantime, the row a user's edit addressed was simply
// gone: the delta for it was dropped, the rest was applied, and the commit
// reported success. The user's change was lost and the history record did not
// even mention it.
//
// A rebase that cannot cover every edit is not a rebase. This module keeps the
// decision separate from the store so it can be tested without a device: plan
// the replay, look at `missing`, and refuse if it is non-empty.

import { applyDeltaReport, formatPath, type DiffRecord } from './diff';
import type { ConfigSnapshot } from './store';

export interface RebasePlan {
  /** The new base with every replayable edit applied. Only meaningful when
   *  `missing` is empty — a partial snapshot must never be committed. */
  snapshot: ConfigSnapshot;
  /** Human-readable paths the new base could not resolve, in delta order. */
  missing: string[];
}

export function planRebase(newest: ConfigSnapshot, delta: DiffRecord[]): RebasePlan {
  const report = applyDeltaReport(newest, delta);
  return { snapshot: report.value, missing: report.missing.map((p) => formatPath(p)) };
}
