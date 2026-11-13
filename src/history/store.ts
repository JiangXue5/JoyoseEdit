// Append-only edit history.
// Every push generates one file under /data/adb/joyose-edit/history/<epoch>-<seq>.json
// whose contents are a `HistoryRecord`. The store is monotonic: rollback
// writes a new record rather than deleting any existing one, so the audit
// chain is never destroyed.

import type { DiffRecord } from './diff';

export type HistorySource = 'webui' | 'revert' | 'cleanup' | 'backup';

/** Full snapshot of the params we edit, so rollback is a pure function. */
export interface ConfigSnapshot {
  smartp: {
    cloud_config: Record<string, unknown>; // config_name -> parsed params
  };
  teg: {
    /** rule_module -> array of parsed rule_content JSON objects.
     *  We keep an array because teg_config.rules can carry multiple history
     *  rows per module. Writing syncs by (module, rule_id). */
    rules: Record<string, unknown[]>;
  };
}

/** Which database(s) a record's delta was applied to. */
export type DbKind = 'smartp' | 'teg' | 'both';

/** Content digests of the two databases at one moment. `null` means the file
 *  was absent, or the device has no sha256sum and we could not compute one —
 *  never "unchanged". */
export interface DbDigests {
  smartp: string | null;
  teg: string | null;
}

/** Git-style incremental commit. `delta` is the forward patch from parent
 * state to this state; state is reconstructed by walking the chain (see
 * session.ts::restoreToRecord). Files stay in the KB range.
 *
 *  v2 format (delta only) is still what `version` means. The fields below were
 *  added afterwards without changing the delta shape, so old readers keep
 *  working and new readers can tell a record's base from its own fields:
 *
 *  * `dbKind`      which DB the delta landed in (a commit can touch both);
 *  * `beforeDigest` the DBs as they were when this record's base was read;
 *  * `afterDigest`  the DBs immediately after the write landed;
 *  * `canRevert`   whether this record may be replayed at all (a backup
 *                  checkpoint has no delta, so replaying it means nothing).
 *
 *  Digests are what let rollback refuse to run on a database somebody else
 *  changed in the meantime — replaying a delta onto a base it was not
 *  computed from produces a wrong result and still "succeeds". */
export interface HistoryRecord {
  version: 2;
  seq: number;
  timestamp: number;
  source: HistorySource;
  note: string;
  delta: DiffRecord[];
  /** Absent on records written before v1.2.0. */
  dbKind?: DbKind;
  beforeDigest?: DbDigests;
  afterDigest?: DbDigests;
  canRevert?: boolean;
}

export interface HistoryFileMeta {
  name: string;
  timestamp: number;
  seq: number;
}

/**
 * Parse a history filename. Files are named `<epoch>-<seq>.json`. Returns null
 * for unknown shapes (so stray files don't break the list).
 */
export function parseHistoryFilename(name: string): HistoryFileMeta | null {
  const m = /^(\d+)-(\d+)\.json$/.exec(name);
  if (!m) return null;
  return { name, timestamp: Number(m[1]), seq: Number(m[2]) };
}

export function buildHistoryFilename(timestamp: number, seq: number): string {
  return `${timestamp}-${seq}.json`;
}

/** Pick the next seq number given an existing list of filenames. */
export function nextSeq(existing: string[]): number {
  let max = 0;
  for (const n of existing) {
    const meta = parseHistoryFilename(n);
    if (meta && meta.seq > max) max = meta.seq;
  }
  return max + 1;
}

export interface BuildRecordArgs {
  seq: number;
  timestamp?: number;
  source?: HistorySource;
  note?: string;
  /** Forward delta (parent-state -> this-state). Typically produced by
   *  `diff(before, after)` where before / after are `ConfigSnapshot`s. */
  delta: DiffRecord[];
  /** Optional bookkeeping about the databases this delta was applied to. */
  dbKind?: DbKind;
  beforeDigest?: DbDigests;
  afterDigest?: DbDigests;
  /** Defaults to `delta.length > 0`: a checkpoint with no delta cannot be
   *  replayed, so it must not be offered as a rollback target. */
  canRevert?: boolean;
}

export function buildRecord(args: BuildRecordArgs): HistoryRecord {
  const rec: HistoryRecord = {
    version: 2,
    seq: args.seq,
    timestamp: args.timestamp ?? Math.floor(Date.now() / 1000),
    source: args.source ?? 'webui',
    note: args.note ?? '',
    delta: args.delta,
  };
  if (args.dbKind) rec.dbKind = args.dbKind;
  if (args.beforeDigest) rec.beforeDigest = args.beforeDigest;
  if (args.afterDigest) rec.afterDigest = args.afterDigest;
  rec.canRevert = args.canRevert ?? args.delta.length > 0;
  return rec;
}

/** Project `state.cloudConfig` / `state.rulesByModule` (which wrap values
 * as `{meta, params|content}`) into a lean snapshot that carries only the
 * parsed JSON — `meta` holds DB row metadata (version, uid, …) that would
 * inflate the snapshot without helping state reconstruction; rehydration
 * keeps the live `meta` from current state anyway. */
export function snapshotFromMaps(args: {
  cloudConfig: Record<string, unknown>;
  rulesByModule: Record<string, unknown[]>;
}): ConfigSnapshot {
  const cc: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(args.cloudConfig)) {
    const inner = (v as any)?.params;
    cc[name] = clone(inner !== undefined ? inner : v);
  }
  const rules: Record<string, unknown[]> = {};
  for (const [mod, rows] of Object.entries(args.rulesByModule)) {
    rules[mod] = rows.map((r: any) => {
      const inner = r?.content;
      return clone(inner !== undefined ? inner : r);
    });
  }
  return { smartp: { cloud_config: cc }, teg: { rules } };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * RootBackedStore uses the `bin/joyose-edit.sh history-*` subcommands
 * (in the live module) to persist records. In Node (tests) we substitute a
 * FilesystemStore — both implement the same interface.
 */
export interface HistoryStore {
  list(): Promise<HistoryFileMeta[]>;
  read(name: string): Promise<HistoryRecord>;
  append(record: HistoryRecord): Promise<string>;
  clear(keep: number): Promise<number>;
}

export interface StoreDriver {
  listNames(): Promise<string[]>;
  readText(name: string): Promise<string>;
  writeText(name: string, content: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export class DriverBackedStore implements HistoryStore {
  constructor(private readonly driver: StoreDriver) {}

  async list(): Promise<HistoryFileMeta[]> {
    const names = await this.driver.listNames();
    return names
      .map((n) => parseHistoryFilename(n))
      .filter((x): x is HistoryFileMeta => !!x)
      .sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
  }

  async read(name: string): Promise<HistoryRecord> {
    const text = await this.driver.readText(name);
    return JSON.parse(text) as HistoryRecord;
  }

  async append(record: HistoryRecord): Promise<string> {
    const name = buildHistoryFilename(record.timestamp, record.seq);
    await this.driver.writeText(name, JSON.stringify(record));
    return name;
  }

  async clear(keep: number): Promise<number> {
    if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be non-negative integer');
    const list = await this.list();
    const toRemove = list.slice(keep);
    for (const m of toRemove) await this.driver.remove(m.name);
    return toRemove.length;
  }
}
