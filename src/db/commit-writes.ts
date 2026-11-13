// Turning "state the user edited" into "rows to write".
//
// This used to live inline in session.ts, mixed with bridge calls and UI
// state, which made it untestable without a full WebView: the rules that
// decide *which rows may be written at all* (a row that came from the teg
// fallback must never land in SmartP, an unparseable row must keep its
// original bytes, an unchanged row must not be rewritten) were only covered
// indirectly through the UI.
//
// The functions here take a Database and plain snapshots; they do not know
// about Vue, ksu.exec or the session store.

import type { Database } from 'sql.js';
import type { RulesRow } from './schema';
import { parseParams, stringifyParams } from './schema';
import { listCloudConfig, updateCloudConfigParams, latestRuleIdForModule, insertRuleRow, updateRuleContentById } from './dbio';
import { planSmartpWrite, pickSmartpVersion } from './merge';

/** Why a config row was not written. Kept as data so a caller can explain a
 *  "nothing was written" outcome instead of guessing. */
export type SkipReason =
  | 'not-smartp'   // mirror row: lives in teg, not in this table
  | 'empty'        // placeholder row with no content
  | 'broken'       // JSON we could not parse — keep the original bytes
  | 'from-teg'     // value came from the teg source, not from SmartP
  | 'no-row'       // no such config_name in this database
  | 'unchanged';   // plan or serialisation matched what is already on disk

export interface SmartpWrite {
  name: string;
  params: unknown;
  serialized: string;
  version?: number;
}

export interface SmartpPlan {
  writes: SmartpWrite[];
  skipped: Record<string, SkipReason>;
}

/** Decide which `cloud_config` rows this commit should rewrite.
 *
 *  `workBase` is the snapshot the user's edits were made against
 *  (pristineSnapshot.smartp.cloud_config); `cloudConfig` is the edited state.
 *  The merge happens against the bytes we are about to write, not against an
 *  in-memory copy, so a second edit in the same session cannot silently undo
 *  the first one. */
export function planSmartpWrites(
  db: Database,
  cloudConfig: Record<string, any>,
  workBase: Record<string, any>,
): SmartpPlan {
  const diskParams: Record<string, any> = {};
  for (const row of listCloudConfig(db)) {
    diskParams[row.config_name] = parseParams(row.params);
  }

  const writes: SmartpWrite[] = [];
  const skipped: Record<string, SkipReason> = {};

  for (const [name, obj] of Object.entries(cloudConfig)) {
    const meta = obj?.meta;
    if (meta?._real !== true) {
      skipped[name] = 'not-smartp';
      continue;
    }
    if (meta?.empty) {
      skipped[name] = 'empty';
      continue;
    }
    if (meta?.broken) {
      skipped[name] = 'broken';
      continue;
    }
    if (meta?.fromTeg) {
      skipped[name] = 'from-teg';
      continue;
    }
    const raw = diskParams[name];
    const plan = planSmartpWrite({
      raw,
      workBefore: workBase[name],
      workAfter: obj.params,
      source: meta?.source,
    });
    if (!plan.write) {
      skipped[name] = plan.reason === 'no-row' ? 'no-row' : 'unchanged';
      continue;
    }
    const serialized = stringifyParams(plan.params);
    if (stringifyParams(raw) === serialized) {
      skipped[name] = 'unchanged';
      continue;
    }
    // Keep SmartP's own version column unless the user locked it: the
    // reconciled meta.version may come from teg, and copying it here would
    // silently move SmartP's version forward on every source switch.
    writes.push({ name, params: plan.params, serialized, version: pickSmartpVersion(meta) });
  }

  return { writes, skipped };
}

/** Apply a plan. Separate from planning so a caller can write both databases
 *  only after every plan came back clean. */
export function applySmartpWrites(db: Database, writes: SmartpWrite[]): void {
  for (const w of writes) {
    updateCloudConfigParams(db, w.name, w.serialized, w.version);
  }
}

export interface RuleUpdate {
  module: string;
  id: number;
  content: string;
}

export interface RuleInsert {
  module: string;
  content: string;
  version?: number;
}

export interface TegPlan {
  updates: RuleUpdate[];
  inserts: RuleInsert[];
  skipped: Record<string, SkipReason>;
}

/** Decide which `rules` rows the teg mirror needs.
 *
 *  A module with no row yet gets one inserted instead of being dropped: the
 *  mirror row was created in memory by the structured editor, and silently
 *  skipping it meant the edit looked applied but never reached teg. */
export function planTegWrites(
  db: Database,
  rulesByModule: Record<string, Array<{ content: unknown; meta?: any }>>,
): TegPlan {
  const updates: RuleUpdate[] = [];
  const inserts: RuleInsert[] = [];
  const skipped: Record<string, SkipReason> = {};

  for (const [module, rows] of Object.entries(rulesByModule)) {
    if (!rows.length) {
      skipped[module] = 'empty';
      continue;
    }
    // Rules are versioned: only the newest revision of a module is written.
    const row = currentRuleRow(rows);
    if (!row) {
      skipped[module] = 'empty';
      continue;
    }
    if (row.meta?._real !== true) {
      skipped[module] = 'not-smartp';
      continue;
    }
    if (row.meta?.empty) {
      skipped[module] = 'empty';
      continue;
    }
    if (row.meta?.broken) {
      skipped[module] = 'broken';
      continue;
    }
    // Resolve the target against the DB we are about to write: Joyose may have
    // appended a newer revision between pull and push.
    const id = latestRuleIdForModule(db, module);
    if (id === null) {
      const mirrorVersion =
        Number(row.meta?.rule_version ?? 0) || Number((row.content as any)?.version ?? 0);
      inserts.push({
        module,
        content: JSON.stringify(row.content),
        version: mirrorVersion > 0 ? mirrorVersion : undefined,
      });
      continue;
    }
    updates.push({ module, id, content: JSON.stringify(row.content) });
  }

  return { updates, inserts, skipped };
}

export function applyTegWrites(db: Database, plan: TegPlan): void {
  for (const u of plan.updates) updateRuleContentById(db, u.id, u.content);
  for (const ins of plan.inserts) {
    const res = insertRuleRow(db, ins.module, ins.content, ins.version);
    if (res.inserted !== 1) {
      throw new Error(`teg 镜像行写入失败（${ins.module}）：${res.error ?? '没有插入任何行'}`);
    }
  }
}

/** The row Joyose treats as current for a module: highest `rule_version`
 *  (an insert ordinal), not highest envelope version. The rules table keeps
 *  every historical release, so "the module" is ambiguous without this.
 *
 *  Lives here (and is re-exported by the session store) so the write planner
 *  and the UI resolve "current" the same way. */
export function currentRuleRow<T extends { meta?: { rule_version?: unknown } }>(
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

/** Re-exported so callers can type a `rules` row without importing schema. */
export type { RulesRow };
