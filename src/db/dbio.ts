// Thin, pure-TS wrapper around sql.js for reading and mutating SmartP.db /
// teg_config.db in the browser. The wrapper is intentionally narrow — it
// doesn't know about ksu.exec. Callers supply the raw bytes; the result bytes
// get written back via the root bridge.

import type { Database, SqlJsStatic } from 'sql.js';
import type { CloudConfigRow, RulesRow } from './schema';

let sqlPromise: Promise<SqlJsStatic> | null = null;

/** Lazily initialise sql.js. We strongly prefer reading the WASM via the
 * root bridge (ksu.exec cat → base64) because some KernelSU WebView builds
 * serve `.wasm` with the wrong MIME type or reject the fetch outright —
 * which is what produced the "both async and sync fetching of the wasm
 * failed" error in v0.1.0 on Xiaomi 17 Pro Max. The HTTP locateFile path
 * is kept as a fallback for `npm run dev` (no root bridge there). */
export function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initializeSqlJs();
  }
  return sqlPromise;
}

async function initializeSqlJs(): Promise<SqlJsStatic> {
  const { default: initSqlJs } = await import('sql.js');

  // Attempt 1: load via root bridge (preferred in production).
  const ksuAvailable =
    typeof window !== 'undefined' && typeof (window as any).ksu?.exec === 'function';
  if (ksuAvailable) {
    try {
      // Imported lazily: the bridge imports this module back (base64 helpers),
      // so a top-level import would create a cycle that breaks non-WebView
      // consumers — including the test harness, which has no `kernelsu` module.
      const bridge = await import('@/root/bridge');
      const bytes = await bridge.readWasm();
      return await initSqlJs({ wasmBinary: bytes.buffer as ArrayBuffer });
    } catch (err) {
      console.warn('[joyose-edit] readWasm via root bridge failed, falling back to fetch:', err);
    }
  }

  // Attempt 2: let sql.js fetch it from ./assets/sql-wasm.wasm — the
  // dev-server / plain-browser path.
  return initSqlJs({
    locateFile: (file: string) => `./assets/${file}`,
  });
}

export async function openDb(bytes: Uint8Array): Promise<Database> {
  const SQL = await getSql();
  return new SQL.Database(bytes);
}

export function closeDb(db: Database): void {
  db.close();
}

export function exportDb(db: Database): Uint8Array {
  return db.export();
}

// ----- cloud_config -------------------------------------------------------

export function listCloudConfig(db: Database): CloudConfigRow[] {
  const stmt = db.prepare(
    `SELECT _id, config_name, group_name, enable, version, with_model,
            model, params, anchor, anchor_percents, anchor_values,
            value_type, final_value
       FROM cloud_config`,
  );
  const out: CloudConfigRow[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as unknown as CloudConfigRow);
  stmt.free();
  return out;
}

export function getCloudConfig(db: Database, name: string): CloudConfigRow | null {
  const stmt = db.prepare(
    `SELECT _id, config_name, group_name, enable, version, with_model,
            model, params, anchor, anchor_percents, anchor_values,
            value_type, final_value
       FROM cloud_config WHERE config_name = :name`,
  );
  stmt.bind({ ':name': name });
  let row: CloudConfigRow | null = null;
  if (stmt.step()) row = stmt.getAsObject() as unknown as CloudConfigRow;
  stmt.free();
  return row;
}

/** Update the `params` (and optionally `version`) of an existing row. */
export function updateCloudConfigParams(
  db: Database,
  name: string,
  params: string,
  version?: number,
): void {
  if (typeof version === 'number') {
    db.run(
      `UPDATE cloud_config SET params = :p, version = :v WHERE config_name = :n`,
      { ':p': params, ':v': version, ':n': name },
    );
  } else {
    db.run(`UPDATE cloud_config SET params = :p WHERE config_name = :n`, {
      ':p': params,
      ':n': name,
    });
  }
}

// ----- rules --------------------------------------------------------------

export function listRules(db: Database): RulesRow[] {
  const stmt = db.prepare(
    `SELECT _id, rule_id, rule_version, rule_module, rule_content FROM rules`,
  );
  const out: RulesRow[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as unknown as RulesRow);
  stmt.free();
  return out;
}

/**
 * `rules` keeps one row per historical release of a module — a Xiaomi 15
 * carries five booster_config revisions side by side, each ~140 KB with its
 * own envelope version. The row Joyose treats as current is the one with the
 * highest `rule_version` (a monotonic internal ordinal; it is NOT the
 * YYYYMMDDxx value that lives inside the envelope).
 */
export function latestRuleIdForModule(db: Database, module: string): number | null {
  const stmt = db.prepare(
    `SELECT _id FROM rules WHERE rule_module = :m
      ORDER BY rule_version DESC, _id DESC LIMIT 1`,
  );
  stmt.bind({ ':m': module });
  const has = stmt.step();
  const row = has ? (stmt.getAsObject() as { _id?: number }) : null;
  stmt.free();
  const id = Number(row?._id);
  return Number.isFinite(id) ? id : null;
}

/** Rewrite the content of a single rules row, addressed by primary key.
 * Deliberately leaves `rule_version` alone: it is Joyose's insert ordinal,
 * and rewriting it (or copying one row's value onto every sibling) makes the
 * local DB look older than the cloud and invites an immediate re-push. */
export function updateRuleContentById(db: Database, id: number, content: string): number {
  db.run(`UPDATE rules SET rule_content = :c WHERE _id = :id`, {
    ':c': content,
    ':id': id,
  });
  const res = db.exec(`SELECT changes() as n`);
  return Number(res[0]?.values?.[0]?.[0] ?? 0);
}

/** Insert one row for `module` when none exists (the teg mirror of a config
 * that SmartP has but teg never received). Returns 0 when the table is absent
 * (redmi-style DB) instead of throwing — pushing must not fail over a mirror. */
export interface InsertRuleResult {
  /** Rows actually inserted (1 on success). */
  inserted: number;
  /** Why it failed, when it did. Callers on the write path must not ignore a
   *  zero here: it used to be a bare `0` and the commit carried on as if the
   *  mirror row existed. */
  error?: string;
}

export function insertRuleRow(
  db: Database,
  module: string,
  content: string,
  version?: number,
): InsertRuleResult {
  try {
    db.run(
      `INSERT INTO rules (rule_module, rule_content, rule_version) VALUES (:m, :c, :v)`,
      {
        ':m': module,
        ':c': content,
        ':v': typeof version === 'number' ? version : null,
      },
    );
    const res = db.exec(`SELECT changes() as n`);
    const inserted = Number(res[0]?.values?.[0]?.[0] ?? 0);
    return inserted === 1 ? { inserted } : { inserted, error: 'changes() reported no row' };
  } catch (err: any) {
    return { inserted: 0, error: err?.message ?? String(err) };
  }
}

/** Update `rule_content` and `rule_version` of every row that matches `module`. */
export function updateRulesContent(
  db: Database,
  module: string,
  content: string,
  version?: number,
): number {
  if (typeof version === 'number') {
    db.run(
      `UPDATE rules SET rule_content = :c, rule_version = :v WHERE rule_module = :m`,
      { ':c': content, ':v': version, ':m': module },
    );
  } else {
    db.run(`UPDATE rules SET rule_content = :c WHERE rule_module = :m`, {
      ':c': content,
      ':m': module,
    });
  }
  const res = db.exec(`SELECT changes() as n`);
  return Number(res[0]?.values?.[0]?.[0] ?? 0);
}

export function countRulesForModule(db: Database, module: string): number {
  const res = db.exec(`SELECT COUNT(*) FROM rules WHERE rule_module = '${module.replace(/'/g, "''")}'`);
  return Number(res[0]?.values?.[0]?.[0] ?? 0);
}

/** Base64 <-> Uint8Array helpers; the root bridge emits base64. */
export function base64ToBytes(b64: string): Uint8Array {
  // strip stray whitespace that some shells add
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // chunk to avoid call-stack issues with large DBs (~500 KB+)
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
