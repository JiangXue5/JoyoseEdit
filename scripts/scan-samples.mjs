#!/usr/bin/env node
// Refuse to ship a sample database that carries device-identifying data.
//
// The samples under tests/ are Joyose's own store, which happens to include
// tables Joyose fills from the phone: Wi-Fi SSID/BSSID history, place history,
// user habits. In the samples currently in the repo those tables are empty,
// but "empty today" is not a guarantee — a future sample pulled from a live
// phone would bring the owner's home network with it.
//
// Run by CI and by `npm run scan:samples`. Exits 1 on any hit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Column names that identify a person or their network. Matched as a whole
 *  word inside a snake_case / camelCase name so `model` does not match `mac`
 *  and `connect_time` does not match `account`. */
const SENSITIVE_COLUMN =
  /(^|_)(ssid|bssid|mac(|_address)|imei|meid|serial(|_no|_number)?|android_id|account|phone|email|latitude|longitude)(_|$)/i;

/** A bare MAC address inside free-form JSON is just as identifying. */
const MAC_RE = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i;

function collectDbFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...collectDbFiles(full));
    } else if (entry.name.endsWith('.db')) {
      out.push(full);
    }
  }
  return out;
}

function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function scan(db, file) {
  const hits = [];
  const tablesRes = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
  const tables = tablesRes[0]?.values?.map((r) => String(r[0])) ?? [];

  for (const table of tables) {
    const colsRes = db.exec(`PRAGMA table_info(${q(table)})`);
    const cols = colsRes[0]?.values?.map((r) => String(r[1])) ?? [];
    const sensitive = cols.filter((c) => SENSITIVE_COLUMN.test(c));
    if (!sensitive.length) continue;
    for (const col of sensitive) {
      const res = db.exec(
        `SELECT COUNT(*) FROM ${q(table)} WHERE ${q(col)} IS NOT NULL AND TRIM(CAST(${q(col)} AS TEXT)) NOT IN ('', '0')`,
      );
      const n = Number(res[0]?.values?.[0]?.[0] ?? 0);
      if (n > 0) {
        hits.push(`${path.relative(ROOT, file)}: ${table}.${col} has ${n} non-empty row(s)`);
      }
    }
  }

  // Free-form JSON payloads: a MAC inside cloud_config.params is as bad as one
  // in a dedicated column.
  for (const [table, column] of [
    ['cloud_config', 'params'],
    ['rules', 'rule_content'],
  ]) {
    if (!tables.includes(table)) continue;
    const res = db.exec(`SELECT ${q(column)} FROM ${q(table)}`);
    for (const row of res[0]?.values ?? []) {
      const text = String(row[0] ?? '');
      const m = text.match(MAC_RE);
      if (m) hits.push(`${path.relative(ROOT, file)}: ${table}.${column} contains a MAC address (${m[0]})`);
    }
  }

  // Generic text sweep over the phone-owned tables, in case a future ROM adds
  // a column with a name we do not know yet.
  for (const table of ['smart_wifi_info_history', 'smart_place_info_history']) {
    if (!tables.includes(table)) continue;
    const res = db.exec(`SELECT * FROM ${q(table)}`);
    for (const row of res[0]?.values ?? []) {
      const joined = row.map((v) => String(v ?? '')).join(' ');
      if (joined.trim() !== '' && joined.replace(/[\s0]/g, '') !== '') {
        hits.push(`${path.relative(ROOT, file)}: ${table} has a non-empty row`);
        break;
      }
    }
  }

  return hits;
}

const files = collectDbFiles(path.join(ROOT, 'tests'));
if (!files.length) {
  console.error('scan-samples: no sample databases found under tests/');
  process.exit(1);
}

const SQL = await initSqlJs({
  locateFile: (f) => path.join(ROOT, 'node_modules/sql.js/dist', f),
});

const all = [];
for (const file of files) {
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    all.push(...scan(db, file));
  } finally {
    db.close();
  }
}

if (all.length) {
  console.error('scan-samples: refusing to publish samples with identifying data:');
  for (const hit of all) console.error('  - ' + hit);
  process.exit(1);
}

console.log(`scan-samples: ${files.length} sample database(s) clean`);
