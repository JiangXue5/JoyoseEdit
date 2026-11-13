// Per-row parsing for cloud_config, kept in its own module:
//  * it has no Vue / bridge dependency, so the tests can exercise it directly;
//  * the "one bad row must not blank the page" contract lives in one place.

import { parseParams } from '@/db/schema';

/** A row whose JSON could not be parsed, kept for the UI instead of aborting
 *  the pull. `config` is a config_name. */
export interface ParseIssue {
  db: 'smartp' | 'teg';
  config: string;
  message: string;
}

/** "Empty config": params null / not an object / no keys at all (the cloud
 *  did ship a row but only `{}`). Treated as "not yet delivered" — no version
 *  shown, not lockable, not written back. */
export function isEmptyCloudParams(p: unknown): boolean {
  return (
    !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p as object).length === 0
  );
}

/** Parse `cloud_config` rows one by one.
 *
 *  `parseParams` is a bare JSON.parse, so one truncated row used to throw out
 *  of readIntoState and leave every config on every page blank. A broken row is
 *  kept with its metadata, marked `broken`, and reported — its original bytes
 *  stay untouched in the database and the commit path refuses to write it. */
export function parseCloudConfigRows(
  rows: Array<Record<string, any>>,
): { configs: Record<string, any>; issues: ParseIssue[] } {
  const configs: Record<string, any> = {};
  const issues: ParseIssue[] = [];
  for (const row of rows) {
    const name = String(row.config_name ?? '');
    try {
      const params = parseParams(row.params);
      const empty = isEmptyCloudParams(params);
      configs[name] = { meta: { ...row, _real: true, empty }, params };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      configs[name] = {
        meta: { ...row, _real: true, empty: false, broken: true, parseError: message },
        params: {},
      };
      issues.push({ db: 'smartp', config: name, message });
    }
  }
  return { configs, issues };
}
