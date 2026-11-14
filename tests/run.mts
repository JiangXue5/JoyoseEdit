// End-to-end validation harness. Run `npm test`.
//
// For each sample DB in the repo root:
//   1. Open via sql.js.
//   2. Detect V3 path shape (novatek / qualcomm / mivk / migl).
//   3. Parse every per-game string encountered with the relevant parser,
//      serialize back, and assert byte-for-byte equality with the input.
//   4. Exercise write paths: lock cloud versions, upsert frc entries, add
//      MIVK entries, edit novatek strings. Re-open the resulting bytes and
//      confirm the edits stuck.
//   5. Exercise history store + diff against a filesystem driver.

import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync,
  statSync, symlinkSync, chownSync, existsSync, unlinkSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { parseFrc, serializeFrc, blankFrc, validateFrc } from '../src/parsers/frc-string';
import {
  parseMifisr,
  serializeMifisr,
  validateMifisr,
  blankMifisr,
} from '../src/parsers/mifisr-string';
import {
  parseNovatek,
  serializeNovatek,
  validateNovatek,
  setThermal,
  blankNovatek,
  describeComplexBlocks,
  decodeSlot,
  encodeSlotHex,
} from '../src/parsers/novatek-string';
import {
  STRATEGY_PRESETS,
  upsertPkgPolicy,
  emptyFisrConfig,
  isFisrConfig,
  findGroupForPkg,
  removePkg,
  setPkgSupportVk,
  splitPkgGroup,
  groupImpact,
  addPolicyForPkg,
  removePolicyForPkg,
} from '../src/parsers/fisr-config';
import { findPkgRoutes, removePkgRoutes, renamePkgRoutes } from '../src/parsers/pkg-routes';
import {
  parseSupportModule,
  serializeSupportModule,
  withModule,
} from '../src/parsers/support-module';
import {
  getEntries,
  setEntries,
  newMivkEntry,
  newMiglEntry,
  findByCmdline,
  modulesOf,
  setModules,
  pruneOrphanedModuleBlocks,
} from '../src/parsers/mivk-migl';
import {
  parseCgameDf,
  serializeCgameDf,
  parsePkgFpsMode,
  serializePkgFpsMode,
  parsePkgFps,
  serializePkgFps,
} from '../src/parsers/per-game';
import {
  scanThermalUnlock,
  applyThermalUnlock,
  liftTempGroupsInString,
  findTempGroups,
} from '../src/parsers/thermal-unlock';
import {
  scanFpsLock,
  applyUnlockFps,
  applyLiftThermalFps,
  liftDynamicFpsTemps,
  isFpsLockKey,
} from '../src/parsers/fpslock';
import {
  insertRuleRow,
  latestRuleIdForModule,
  listRules,
  updateRuleContentById,
} from '../src/db/dbio';
import { detectActiveBackend, detectPaths, parseParams, stringifyParams } from '../src/db/schema';
import {
  pickBoosterParams,
  latestEnvelopeVersion,
  getCommonSourcePref,
  getWriteTarget,
  getBoosterSourcePref,
  setWriteTarget,
  setCommonSourcePref,
  resetAllPrefs,
} from '../src/state/source';
import {
  buildRecord,
  DriverBackedStore,
  snapshotFromMaps,
  parseHistoryFilename,
  nextSeq,
} from '../src/history/store';
import { diff, summarizeRecord, applyDelta, applyDeltaReport, invertDelta } from '../src/history/diff';
import { planRestore, digestDrift } from '../src/history/restore-plan';
import { previewThermalUnlock } from '../src/parsers/thermal-unlock';
import { isPlaceholderPkg, preflightCloudConfig } from '../src/db/preflight';
import { makeResult, commitCode, defaultMessage } from '../src/state/result';
import { CAPABILITIES, VERIFICATION_LABEL } from '../src/compat/matrix';
import { VIEW_IDS } from '../src/state/nav';
import type { ConfigSnapshot, DbDigests, HistoryFileMeta, HistoryRecord } from '../src/history/store';
import {
  applyLockedOriginals,
  commitOutcome,
  isVersionLocked,
  mergeOntoRaw,
  pickSmartpVersion,
  planSmartpWrite,
  isCloudLocked,
} from '../src/db/merge';
import { parseCloudConfigRows } from '../src/db/parse-rows';
import { listCloudConfig, listRules } from '../src/db/dbio';
import {
  planSmartpWrites,
  applySmartpWrites,
  planTegWrites,
  applyTegWrites,
  currentRuleRow,
} from '../src/db/commit-writes';
import {
  IMPORT_SCHEMA,
  applyImportPackage,
  pickCloudRowsForPreview,
  validateImportPackage,
  type ImportPackage,
} from '../src/import/package';
import { buildRuleEnvelope, refreshEnvelope } from '../src/history/envelope';
import { activeView, drawerOpen, navigate, setLeaveGuard } from '../src/state/nav';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SAMPLES = [
  { label: 'Xiaomi 17 Pro Max', smartp: 'tests/Xiaomi 17 Pro Max/SmartP.db', teg: 'tests/Xiaomi 17 Pro Max/teg_config.db', expectedBackend: 'mifisr' as const },
  { label: 'Xiaomi 17 Ultra', smartp: 'tests/Xiaomi 17 Ultra/SmartP.db', teg: 'tests/Xiaomi 17 Ultra/teg_config.db', expectedBackend: 'mifisr' as const },
  { label: 'Xiaomi 15', smartp: 'tests/Xiaomi 15/SmartP.db', teg: 'tests/Xiaomi 15/teg_config.db', expectedBackend: 'qualcomm' as const },
  { label: 'Xiaomi 15 Pro', smartp: 'tests/Xiaomi 15 Pro/SmartP.db', teg: 'tests/Xiaomi 15 Pro/teg_config.db', expectedBackend: 'qualcomm' as const },
  { label: 'Redmi K90 Pro Max', smartp: 'tests/Redmi K90 Pro Max/SmartP.db', teg: 'tests/Redmi K90 Pro Max/teg_config.db', expectedBackend: 'novatek' as const },
] as const;

type SamplePaths = (typeof SAMPLES)[number];

const results: { name: string; ok: boolean; info?: string; err?: unknown }[] = [];

async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    const info = await fn();
    results.push({ name, ok: true, info: typeof info === 'string' ? info : undefined });
    console.log(`  ✓ ${name}${info ? ` — ${info}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function openDb(bytes: Uint8Array, SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  return new SQL.Database(bytes);
}

async function main() {
  const SQL = await initSqlJs({});

  for (const sample of SAMPLES) {
    console.log(`\n=== ${sample.label} ===`);
    await runSample(sample, SQL);
  }

  await runHistoryStoreTest();
  await runDiffTest();
  await runDiffPropertyTest();
  await runRestorePlanTest();
  await runOperationResultTest();
  await runHelperFailureTest();
  await runTransactionTest();
  await runCompatMatrixTest();
  await runImportPackageTest();
  await runFrcStringTest();
  await runMifisrStringTest();
  await runPolicyResultTest();
  await runActiveBackendEdgeCases();
  await runEnvelopeTest();
  await runSourcePickTest();
  await runPrefsTest();
  await runFpsLockPrefixTest();
  await runLiftThermalTest();
  await runThermalUnlockTest();
  await runNovatekComplexTest();
  await runCommitWritesTest(SQL);
  await runRuleMirrorTest(SQL);
  await runNavGuardTest();
  await runShellBoundaryTest();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nSummary: ${results.length - failed.length} passed / ${failed.length} failed / ${results.length} total`,
  );
  if (failed.length) process.exit(1);
}

async function runSample(sample: SamplePaths, SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  const smartp = readFileSync(path.join(ROOT, sample.smartp));
  const teg = readFileSync(path.join(ROOT, sample.teg));

  const dbS = await openDb(new Uint8Array(smartp), SQL);
  const dbT = await openDb(new Uint8Array(teg), SQL);

  // Extract cloud_config rows
  const rows = dbS
    .exec('SELECT config_name, version, params FROM cloud_config')[0]
    ?.values ?? [];
  const cloudConfigRows: Record<string, any> = {};
  for (const row of rows) {
    const name = String(row[0]);
    cloudConfigRows[name] = {
      version: Number(row[1]),
      params: parseParams(String(row[2] ?? '')),
    };
  }

  await check(`${sample.label}: cloud_config has booster_config + common_config`, () => {
    if (!cloudConfigRows.booster_config) throw new Error('missing booster_config');
    if (!cloudConfigRows.common_config) throw new Error('missing common_config');
    return `versions: booster=${cloudConfigRows.booster_config.version}, common=${cloudConfigRows.common_config.version}`;
  });

  const booster = cloudConfigRows.booster_config.params as any;
  const gb = booster.game_booster ?? {};

  // Path detection
  const paths = detectPaths(booster);
  await check(`${sample.label}: detectPaths returns 5 path statuses`, () => {
    if (paths.length !== 5) throw new Error(`got ${paths.length}`);
    return paths.map((p) => `${p.id}=${p.active ? 'ACTIVE' : 'off'}(${p.count})`).join(', ');
  });

  await check(`${sample.label}: detectActiveBackend === ${sample.expectedBackend}`, () => {
    const got = detectActiveBackend(booster);
    if (got !== sample.expectedBackend) {
      throw new Error(`expected ${sample.expectedBackend}, got ${got}`);
    }
    return `backend=${got}`;
  });

  // --- FRC path ---
  const frcList: string[] = Array.isArray(gb.frc_game_params) ? gb.frc_game_params : [];
  if (frcList.length > 0) {
    await check(`${sample.label}: parse+serialize every frc_game_params entry`, () => {
      for (const s of frcList) {
        const parsed = parseFrc(s);
        const round = serializeFrc(parsed);
        if (round !== s) throw new Error(`round-trip mismatch:\n  in : ${s}\n  out: ${round}`);
      }
      return `${frcList.length} entries round-trip clean`;
    });
  }

  // --- MIFISR path (17 series) ---
  const mifisrList: string[] = Array.isArray(gb.customize_game_params?.game_mifisr_config)
    ? gb.customize_game_params.game_mifisr_config
    : [];
  if (mifisrList.length > 0) {
    await check(`${sample.label}: parse+serialize every game_mifisr_config entry`, () => {
      for (const s of mifisrList) {
        const parsed = parseMifisr(s);
        const round = serializeMifisr(parsed);
        if (round !== s) throw new Error(`round-trip mismatch:\n  in : ${s}\n  out: ${round}`);
        const issues = validateMifisr(parsed).filter((i) => i.severity !== 'warn');
        if (issues.length > 0) {
          throw new Error(`validation issues for ${parsed.pkg}: ${issues.map((i) => `${i.field}:${i.message}`).join('; ')}`);
        }
      }
      return `${mifisrList.length} entries round-trip clean`;
    });
  }

  // --- Novatek path ---
  const novatekList: string[] = Array.isArray(gb.novatek_game_params)
    ? gb.novatek_game_params
    : [];
  if (novatekList.length > 0) {
    await check(`${sample.label}: parse+serialize every novatek_game_params entry`, () => {
      for (const s of novatekList) {
        const parsed = parseNovatek(s);
        const round = serializeNovatek(parsed);
        if (round !== s) throw new Error(`round-trip mismatch:\n  in : ${s}\n  out: ${round}`);
        const issues = validateNovatek(parsed);
        if (issues.length > 0) {
          throw new Error(`validation issues for ${parsed.pkg}: ${issues.map((i) => `${i.segment}:${i.message}`).join('; ')}`);
        }
      }
      return `${novatekList.length} entries round-trip clean`;
    });

    // hex slot helpers
    await check(`${sample.label}: novatek hex slot helpers round-trip`, () => {
      const sample0 = parseNovatek(novatekList[0]);
      const slots = sample0.setA.csv.filter((v) => v.startsWith('0x'));
      for (const v of slots) {
        const dec = decodeSlot(v);
        const enc = encodeSlotHex(dec, v.length - 2);
        if (parseInt(enc, 16) !== dec) throw new Error(`hex round-trip failed for ${v}`);
      }
      return `checked ${slots.length} hex slots`;
    });

    // thermal mutation helper
    await check(`${sample.label}: setThermal writes all three segments`, () => {
      const parsed = parseNovatek(novatekList[0]);
      setThermal(parsed, '95', '93', '93', '91');
      for (const seg of [parsed.setA, parsed.setGpu, parsed.setB]) {
        if (seg.t1 !== '95' || seg.t2 !== '93' || seg.t3 !== '93' || seg.t4 !== '91') {
          throw new Error('setThermal did not update all segments');
        }
      }
    });
  }

  // --- FISR config ---
  if (gb.fisr_config && isFisrConfig(gb.fisr_config)) {
    await check(`${sample.label}: fisr_config groups have valid shape`, () => {
      let groupCount = 0;
      let policyCount = 0;
      for (const g of gb.fisr_config.enhance_config) {
        groupCount++;
        if (!Array.isArray(g.game_list) || g.game_list.length === 0) {
          throw new Error(`group with empty game_list`);
        }
        for (const p of g.enhance_policy_config) {
          policyCount++;
          if (!p.feature || !p.strategy) throw new Error('policy missing feature/strategy');
        }
      }
      return `${groupCount} groups / ${policyCount} policies`;
    });
  }

  // --- MIVK path ---
  const mivkApps = gb.mivk_settings?.app_params ?? [];
  if (mivkApps.length > 0) {
    await check(`${sample.label}: MIVK support_module round-trip`, () => {
      let checked = 0;
      for (const app of mivkApps) {
        const original = app.xrender_config?.support_module;
        if (!Array.isArray(original)) continue;
        const mods = parseSupportModule(original);
        const round = serializeSupportModule(mods);
        if (JSON.stringify(round) !== JSON.stringify(original)) {
          throw new Error(`mismatch on ${app.app}:\n  in : ${JSON.stringify(original)}\n  out: ${JSON.stringify(round)}`);
        }
        checked++;
      }
      return `${checked} apps round-trip`;
    });

    await check(`${sample.label}: MIVK withModule append/remove`, () => {
      const app = mivkApps[0];
      let mods = modulesOf(app);
      const before = mods.length;
      mods = withModule(mods, '__test__', 7);
      if (!mods.some((m) => m.name === '__test__' && m.level === 7)) {
        throw new Error('append failed');
      }
      mods = withModule(mods, '__test__', null);
      if (mods.length !== before) throw new Error('remove failed');
    });
  }

  // --- MIGL path ---
  const miglGames = gb.migl_settings?.game_params ?? [];
  if (miglGames.length > 0) {
    await check(`${sample.label}: MIGL support_module round-trip`, () => {
      let checked = 0;
      for (const game of miglGames) {
        const original = game.xrender_config?.support_module;
        if (!Array.isArray(original)) continue;
        const mods = parseSupportModule(original);
        const round = serializeSupportModule(mods);
        if (JSON.stringify(round) !== JSON.stringify(original)) {
          throw new Error(`mismatch on ${game.game}:\n  ${JSON.stringify(original)} vs ${JSON.stringify(round)}`);
        }
        checked++;
      }
      return `${checked} games round-trip`;
    });
  }

  // --- per-game secondary formats ---
  const mqs: string[] = Array.isArray(gb.mqs_enhance_list) ? gb.mqs_enhance_list : [];
  if (mqs.length > 0) {
    await check(`${sample.label}: mqs_enhance_list round-trip`, () => {
      for (const s of mqs) {
        const round = serializePkgFpsMode(parsePkgFpsMode(s));
        if (round !== s) throw new Error(`mqs mismatch ${s} vs ${round}`);
      }
      return `${mqs.length} entries`;
    });
  }

  const cgame: string[] = Array.isArray(gb.cgame_df) ? gb.cgame_df : [];
  if (cgame.length > 0) {
    await check(`${sample.label}: cgame_df round-trip`, () => {
      for (const s of cgame) {
        const round = serializeCgameDf(parseCgameDf(s));
        if (round !== s) throw new Error(`cgame_df mismatch ${s} vs ${round}`);
      }
      return `${cgame.length} entries`;
    });
  }

  const highfps: string[] = Array.isArray(gb.support_highfps_app) ? gb.support_highfps_app : [];
  if (highfps.length > 0) {
    await check(`${sample.label}: support_highfps_app round-trip`, () => {
      for (const s of highfps) {
        const round = serializePkgFps(parsePkgFps(s));
        if (round !== s) throw new Error(`highfps mismatch ${s} vs ${round}`);
      }
      return `${highfps.length} entries`;
    });
  }

  const gexLimit: string[] = Array.isArray(gb.novatek_gex_fps_limit) ? gb.novatek_gex_fps_limit : [];
  if (gexLimit.length > 0) {
    await check(`${sample.label}: novatek_gex_fps_limit round-trip`, () => {
      for (const s of gexLimit) {
        const round = serializePkgFps(parsePkgFps(s));
        if (round !== s) throw new Error(`gex mismatch ${s} vs ${round}`);
      }
      return `${gexLimit.length} entries`;
    });
  }

  // --- Cloud lock: bump versions to 2099xxxxxx ---
  await check(`${sample.label}: cloud-lock rewrites versions`, () => {
    const copyParams = JSON.parse(JSON.stringify(booster));
    const oldVersion = Number(copyParams.header?.version ?? 0);
    const newVersion = lockVersion(oldVersion);
    copyParams.header.version = String(newVersion);

    dbS.run(`UPDATE cloud_config SET params = ?, version = ? WHERE config_name = 'booster_config'`, [
      JSON.stringify(copyParams),
      newVersion,
    ]);
    // round-trip: export DB bytes, re-open, confirm value
    const bytes = dbS.export();
    const reopen = new SQL.Database(bytes);
    const back = reopen
      .exec(`SELECT version, params FROM cloud_config WHERE config_name='booster_config'`)[0];
    reopen.close();
    const v = Number(back.values[0][0]);
    const h = JSON.parse(String(back.values[0][1])).header.version;
    if (v !== newVersion) throw new Error(`version not persisted: ${v} vs ${newVersion}`);
    if (h !== String(newVersion)) throw new Error(`header.version not persisted: ${h}`);
    return `version ${oldVersion} -> ${newVersion}`;
  });

  // --- FRC upsert: the Xiaomi-17 'add from scratch' scenario ---
  await check(`${sample.label}: upsert a new frc_game_params + fisr route`, () => {
    const copyParams = JSON.parse(JSON.stringify(booster));
    const gb2 = (copyParams.game_booster ??= {});
    if (!Array.isArray(gb2.frc_game_params)) gb2.frc_game_params = [];
    const beforeCount = gb2.frc_game_params.length;

    const newParams = blankFrc('com.example.testgame');
    newParams.minFps = 45;
    newParams.targetFps = 90;
    newParams.srcFps = 30;
    newParams.modeFps = 60;
    newParams.resolution = '0x0';
    const serialized = serializeFrc(newParams);
    const validationIssues = validateFrc(newParams, [60, 90, 120]);
    if (validationIssues.length) {
      throw new Error('validation unexpectedly flagged: ' + JSON.stringify(validationIssues));
    }
    gb2.frc_game_params.push(serialized);

    // upsert fisr config
    if (!gb2.fisr_config) gb2.fisr_config = emptyFisrConfig();
    upsertPkgPolicy(
      gb2.fisr_config,
      newParams.pkg,
      STRATEGY_PRESETS.qualcommStandard('60#90'),
      { switch_default_status: '0#0' },
    );

    // also add to whitelist keys
    if (!Array.isArray(gb2.support_resolution_enhance_config)) {
      gb2.support_resolution_enhance_config = [];
    }
    gb2.support_resolution_enhance_config.push({ pkg: newParams.pkg, isSupportHotSwap: false });

    // round-trip through sqlite
    dbS.run(`UPDATE cloud_config SET params = ? WHERE config_name = 'booster_config'`, [
      JSON.stringify(copyParams),
    ]);
    const bytes = dbS.export();
    const reopen = new SQL.Database(bytes);
    const back = reopen
      .exec(`SELECT params FROM cloud_config WHERE config_name='booster_config'`)[0];
    reopen.close();
    const backParams = JSON.parse(String(back.values[0][0]));
    const frc = backParams.game_booster.frc_game_params;
    if (frc.length !== beforeCount + 1) throw new Error('entry count mismatch');
    const added = frc[frc.length - 1];
    if (added !== serialized) throw new Error(`persisted string mismatch:\n  ${added}\n  ${serialized}`);
    const group = findGroupForPkg(backParams.game_booster.fisr_config, newParams.pkg);
    if (!group) throw new Error('fisr_config group missing');
    if (group.enhance_policy_config.length !== 4) throw new Error('policy count mismatch');
    return `added ${newParams.pkg} => ${serialized}`;
  });

  // --- MIVK new entry: the small-app path ---
  await check(`${sample.label}: add MIVK entry with module stack`, () => {
    const copyParams = JSON.parse(JSON.stringify(booster));
    const gb2 = (copyParams.game_booster ??= {});
    if (!gb2.mivk_settings) gb2.mivk_settings = { enable: true, app_params: [] };

    const entries = getEntries(gb2, 'mivk');
    const beforeCount = entries.length;

    const newEntry = newMivkEntry('testapp', ['com.example.testapp']);
    let mods = modulesOf(newEntry);
    mods = withModule(mods, 'misr', 5);
    mods = withModule(mods, 'mifi', 4);
    mods = withModule(mods, 'drr', 7);
    setModules(newEntry, mods);
    (newEntry as any).misr = {
      backbuffer_size: '1920x883',
      manual_sr_size_config: ['1920x882->2608x1200'],
    };
    (newEntry as any).mifi = {
      screen_vu_type: 2,
      is_use_mask_image: false,
      is_use_multi_sample: true,
      original_backbuffer_size: '1920x883',
    };
    setEntries(gb2, 'mivk', [...entries, newEntry]);

    dbS.run(`UPDATE cloud_config SET params = ? WHERE config_name = 'booster_config'`, [
      JSON.stringify(copyParams),
    ]);
    const bytes = dbS.export();
    const reopen = new SQL.Database(bytes);
    const back = reopen
      .exec(`SELECT params FROM cloud_config WHERE config_name='booster_config'`)[0];
    reopen.close();
    const backParams = JSON.parse(String(back.values[0][0]));
    const apps = backParams.game_booster.mivk_settings.app_params;
    if (apps.length !== beforeCount + 1) throw new Error('mivk entry not appended');
    const found = findByCmdline(apps, 'mivk', 'com.example.testapp');
    if (!found) throw new Error('new cmdline not found after round-trip');
    const foundMods = modulesOf(found);
    if (!foundMods.some((m) => m.name === 'misr' && m.level === 5)) {
      throw new Error('misr level 5 not persisted');
    }
    return `added mivk entry; support_module=${JSON.stringify(found.xrender_config.support_module)}`;
  });

  // --- pruneOrphanedModuleBlocks ---
  await check(`${sample.label}: pruneOrphanedModuleBlocks strips removed module keys`, () => {
    const copyParams = JSON.parse(JSON.stringify(booster));
    const gb2 = copyParams.game_booster;
    if (!gb2?.mivk_settings?.app_params?.length) return 'no mivk entries; skipped';
    const entry = JSON.parse(JSON.stringify(gb2.mivk_settings.app_params[0]));
    entry.__test_misr_block__ = undefined;
    (entry as any).misr = { marker: 1 };
    setModules(entry, []);
    pruneOrphanedModuleBlocks(entry);
    if ((entry as any).misr !== undefined) throw new Error('misr block not pruned');
  });

  // --- Novatek edit + round-trip ---
  if (novatekList.length > 0) {
    await check(`${sample.label}: novatek edit round-trip`, () => {
      const copyParams = JSON.parse(JSON.stringify(booster));
      const gb2 = copyParams.game_booster;
      const parsed = parseNovatek(gb2.novatek_game_params[0]);
      const before = serializeNovatek(parsed);
      setThermal(parsed, '95', '93', '93', '91');
      const edited = serializeNovatek(parsed);
      if (edited === before) throw new Error('edit had no effect');
      gb2.novatek_game_params[0] = edited;

      dbS.run(`UPDATE cloud_config SET params = ? WHERE config_name = 'booster_config'`, [
        JSON.stringify(copyParams),
      ]);
      const reopen = new SQL.Database(dbS.export());
      const back = reopen
        .exec(`SELECT params FROM cloud_config WHERE config_name='booster_config'`)[0];
      reopen.close();
      const backParams = JSON.parse(String(back.values[0][0]));
      if (backParams.game_booster.novatek_game_params[0] !== edited) {
        throw new Error('novatek edit not persisted');
      }
      return `thermal locked to 95/93/93/91`;
    });
  }

  // --- rules sync: touch rule_version on both rows ---
  await check(`${sample.label}: rules sync for booster_config`, () => {
    const list = dbT.exec(`SELECT rule_module, rule_version FROM rules`)[0];
    const beforeCount = list ? list.values.length : 0;
    if (beforeCount === 0) return `no rules present (redmi / fresh device)`;
    const targetVersion = 20990000000000;
    dbT.run(`UPDATE rules SET rule_version = ? WHERE rule_module = ?`, [
      targetVersion,
      'booster_config',
    ]);
    const reopen = new SQL.Database(dbT.export());
    const back = reopen
      .exec(`SELECT rule_version FROM rules WHERE rule_module='booster_config'`)[0];
    reopen.close();
    for (const row of back?.values ?? []) {
      if (Number(row[0]) !== targetVersion) {
        throw new Error(`version not persisted: ${row[0]}`);
      }
    }
    return `synced ${back?.values.length} booster_config rows`;
  });

  // --- removePkg inverse ---
  if (gb.fisr_config && isFisrConfig(gb.fisr_config)) {
    await check(`${sample.label}: removePkg drops the package from every group`, () => {
      const cfg = JSON.parse(JSON.stringify(gb.fisr_config));
      const anyPkg = cfg.enhance_config[0]?.game_list[0];
      if (!anyPkg) return 'no pkg to remove';
      removePkg(cfg, anyPkg);
      for (const g of cfg.enhance_config) {
        if (g.game_list.includes(anyPkg)) throw new Error(`${anyPkg} still present`);
      }
      return `${anyPkg} removed cleanly`;
    });
  }

  // --- End-to-end: FRC upsert + envelope sync into teg_config.rules ---
  await check(`${sample.label}: FRC upsert propagates into teg_config.rules.rule_content`, () => {
    const ccParams = JSON.parse(JSON.stringify(booster));
    const gb2 = (ccParams.game_booster ??= {});
    if (!Array.isArray(gb2.frc_game_params)) gb2.frc_game_params = [];
    const addPkg = 'com.example.e2e';
    const addStr = serializeFrc({ ...blankFrc(addPkg), resolution: '0x0' });
    gb2.frc_game_params.push(addStr);
    if (!gb2.fisr_config) gb2.fisr_config = emptyFisrConfig();
    upsertPkgPolicy(gb2.fisr_config, addPkg, STRATEGY_PRESETS.qualcommStandard());

    // Persist SmartP.db
    dbS.run(`UPDATE cloud_config SET params = ? WHERE config_name='booster_config'`, [
      JSON.stringify(ccParams),
    ]);

    // Inspect rules table to find a booster_config row to sync
    const ruleRows = dbT.exec(
      `SELECT _id, rule_version, rule_content FROM rules WHERE rule_module='booster_config'`,
    )[0];
    if (!ruleRows || ruleRows.values.length === 0) {
      return 'no booster_config rules on this device; envelope sync skipped';
    }
    const first = ruleRows.values[0];
    const existing = JSON.parse(String(first[2]));
    const updatedVersion = Number(first[1]);
    const fresh = refreshEnvelope(existing, ccParams, updatedVersion);
    dbT.run(`UPDATE rules SET rule_content = ?, rule_version = ? WHERE _id = ?`, [
      JSON.stringify(fresh),
      updatedVersion,
      Number(first[0]),
    ]);

    // re-open both DBs, verify the new frc string is visible from BOTH sides
    const reopenS = new SQL.Database(dbS.export());
    const smartpBack = JSON.parse(
      String(
        reopenS.exec(`SELECT params FROM cloud_config WHERE config_name='booster_config'`)[0]
          .values[0][0],
      ),
    );
    reopenS.close();
    const reopenT = new SQL.Database(dbT.export());
    const tegBack = JSON.parse(
      String(
        reopenT.exec(
          `SELECT rule_content FROM rules WHERE rule_module='booster_config' AND _id=${Number(first[0])}`,
        )[0].values[0][0],
      ),
    );
    reopenT.close();

    if (!smartpBack.game_booster.frc_game_params.includes(addStr)) {
      throw new Error('SmartP.db missing new FRC entry after round-trip');
    }
    if (!tegBack.params.game_booster.frc_game_params.includes(addStr)) {
      throw new Error('teg_config.db mirror missing new FRC entry');
    }
    return `${addPkg} written to both DBs consistently`;
  });

  dbS.close();
  dbT.close();
}

function lockVersion(current: number): number {
  // Rewrite the leading 4 digits to "2099". Joyose stores version as a 12-ish
  // digit decimal, e.g. 2025092351. Replace only the year.
  const s = String(current);
  if (s.length < 4) return 209900000000;
  return Number(`2099${s.slice(4)}`);
}

async function runHistoryStoreTest() {
  console.log('\n=== history store ===');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'joyose-hist-'));
  const driver = {
    async listNames() {
      try {
        return await fs.readdir(tmp);
      } catch {
        return [];
      }
    },
    async readText(name: string) {
      return fs.readFile(path.join(tmp, name), 'utf-8');
    },
    async writeText(name: string, content: string) {
      await fs.writeFile(path.join(tmp, name), content, 'utf-8');
    },
    async remove(name: string) {
      await fs.rm(path.join(tmp, name));
    },
  };
  const store = new DriverBackedStore(driver);

  await check('history: parseHistoryFilename', () => {
    const m = parseHistoryFilename('1712345678-3.json');
    if (!m || m.timestamp !== 1712345678 || m.seq !== 3) throw new Error('parse failed');
    if (parseHistoryFilename('garbage.json') !== null) throw new Error('accepted garbage');
  });

  const s1 = snapshotFromMaps({
    cloudConfig: { booster_config: { v: 1, x: [1, 2, 3] } },
    rulesByModule: { booster_config: [{ v: 1 }] },
  });
  const s2 = snapshotFromMaps({
    cloudConfig: { booster_config: { v: 2, x: [1, 9, 3], y: 'new' } },
    rulesByModule: { booster_config: [{ v: 2 }] },
  });

  const rec1 = buildRecord({ seq: 1, delta: diff(s1, s2), note: 'first edit' });
  await check('history: append + list + read', async () => {
    const n1 = await store.append(rec1);
    if (!n1.endsWith('-1.json')) throw new Error(`bad filename: ${n1}`);
    const list = await store.list();
    if (list.length !== 1 || list[0].seq !== 1) throw new Error('list wrong');
    const read = await store.read(n1);
    if (read.seq !== 1 || read.note !== 'first edit') throw new Error('read mismatch');
    if (read.version !== 2) throw new Error(`expected v2, got v${read.version}`);
    if (read.version === 2 && (!Array.isArray(read.delta) || read.delta.length === 0)) {
      throw new Error('delta empty');
    }
  });

  await check('history: nextSeq bumps past existing', async () => {
    const existing = await driver.listNames();
    const next = nextSeq(existing);
    if (next !== 2) throw new Error(`expected 2, got ${next}`);
  });

  const rec2 = buildRecord({ seq: 2, delta: diff(s2, s1), note: 'rollback', source: 'revert' });
  await check('history: multiple records sort by time+seq desc', async () => {
    await store.append(rec2);
    const list = await store.list();
    if (list[0].seq !== 2 || list[1].seq !== 1) throw new Error('sort order wrong');
  });

  await check('history: clear keeps N newest', async () => {
    for (let i = 3; i < 8; i++) {
      await store.append(
        buildRecord({ seq: i, delta: diff(s1, s2), note: `edit ${i}`, timestamp: 1_700_000_000 + i }),
      );
    }
    const removed = await store.clear(3);
    const list = await store.list();
    if (list.length !== 3) throw new Error(`expected 3, got ${list.length}`);
    if (removed + 3 !== 7) throw new Error(`removed+kept should be 7, got ${removed}+3`);
  });

  await check('history: v2 record JSON round-trip', async () => {
    const fresh = buildRecord({ seq: 99, delta: diff(s1, s2), note: 'round-trip' });
    const serialized = JSON.stringify(fresh);
    const parsed = JSON.parse(serialized);
    if (parsed.version !== 2) throw new Error('version lost');
    if (JSON.stringify(parsed.delta) !== JSON.stringify(fresh.delta)) throw new Error('delta drift');
    if ('before' in parsed || 'after' in parsed) throw new Error('v2 must not carry before/after');
  });

  await fs.rm(tmp, { recursive: true, force: true });
}

async function runDiffTest() {
  console.log('\n=== json diff ===');
  const a = { x: 1, y: { z: [1, 2, 3] }, kill: true };
  const b = { x: 2, y: { z: [1, 9, 3] }, added: 'new' };
  const records = diff(a, b);
  await check('diff: finds added / removed / changed', () => {
    const kinds = new Set(records.map((r) => r.kind));
    if (!kinds.has('added')) throw new Error('missing added');
    if (!kinds.has('removed')) throw new Error('missing removed');
    if (!kinds.has('changed')) throw new Error('missing changed');
  });
  await check('diff: summarizeRecord formats compactly', () => {
    const lines = records.map((r) => summarizeRecord(r));
    if (lines.some((l) => l.length > 200)) throw new Error('line too long');
  });
  await check('diff: empty when equal', () => {
    const r = diff({ a: 1 }, { a: 1 });
    if (r.length !== 0) throw new Error('should be empty');
  });

  await check('diff: applyDelta reconstructs after from before', () => {
    const d = diff(a, b);
    const got = applyDelta(a, d);
    if (JSON.stringify(got) !== JSON.stringify(b)) {
      throw new Error(`reconstruct mismatch:\n  got=${JSON.stringify(got)}\n  want=${JSON.stringify(b)}`);
    }
  });

  await check('diff: invertDelta reverses back to before', () => {
    const d = diff(a, b);
    const back = applyDelta(b, invertDelta(d));
    if (JSON.stringify(back) !== JSON.stringify(a)) {
      throw new Error(`reverse mismatch:\n  got=${JSON.stringify(back)}\n  want=${JSON.stringify(a)}`);
    }
  });

  await check('diff: invertDelta is self-inverse', () => {
    const d = diff(a, b);
    const twice = invertDelta(invertDelta(d));
    if (JSON.stringify(twice) !== JSON.stringify(d)) throw new Error('double-invert drift');
  });

  await check('diff: insertion by stable id does not renumber siblings', () => {
    const before = { groups: [{ pkg: 'a', v: 1 }, { pkg: 'b', v: 2 }] };
    const after = { groups: [{ pkg: 'new', v: 0 }, { pkg: 'a', v: 1 }, { pkg: 'b', v: 2 }] };
    const d = diff(before, after);
    const added = d.filter((r) => r.kind === 'added');
    const changed = d.filter((r) => r.kind === 'changed');
    if (added.length !== 1) throw new Error('added records: ' + JSON.stringify(d));
    if (changed.length !== 0) throw new Error('insertion renumbered siblings: ' + JSON.stringify(d));
    const got = applyDelta(before, d);
    if (JSON.stringify(got) !== JSON.stringify(after)) throw new Error('apply mismatch');
    return '1 added / 0 spurious';
  });

  await check('diff: removal by stable id leaves the neighbours alone', () => {
    const before = { groups: [{ pkg: 'a', v: 1 }, { pkg: 'b', v: 2 }, { pkg: 'c', v: 3 }] };
    const after = { groups: [{ pkg: 'a', v: 1 }, { pkg: 'c', v: 3 }] };
    const d = diff(before, after);
    if (d.length !== 1 || d[0].kind !== 'removed') throw new Error('records: ' + JSON.stringify(d));
    const got = applyDelta(before, d);
    if (JSON.stringify(got) !== JSON.stringify(after)) throw new Error('apply mismatch');
    return '1 removed';
  });

  await check('diff: arrays without identity are replaced wholesale', () => {
    const before = { list: ['a', 'b'] };
    const after = { list: ['x', 'a', 'b'] };
    const d = diff(before, after);
    if (d.length !== 1 || d[0].kind !== 'changed') {
      throw new Error('expected one whole-array record, got ' + JSON.stringify(d));
    }
    if (JSON.stringify(applyDelta(before, d)) !== JSON.stringify(after)) {
      throw new Error('apply mismatch');
    }
    return 'whole array';
  });

  await check('diff: keys containing dots stay unambiguous', () => {
    const before: any = { 'a.b': 1, a: { b: 2 } };
    const after: any = { 'a.b': 9, a: { b: 2 } };
    const d = diff(before, after);
    if (d.length !== 1) throw new Error('records: ' + JSON.stringify(d));
    if (JSON.stringify(d[0].path) !== JSON.stringify(['a.b'])) {
      throw new Error('path wrong: ' + JSON.stringify(d[0].path));
    }
    const got: any = applyDelta(before, d);
    if (got['a.b'] !== 9) throw new Error('literal key not updated');
    if (got.a.b !== 2) throw new Error('nested key was hit instead');
    return 'literal dot key';
  });

  await check('apply: a missing keyed element is reported, not skipped', () => {
    const before = { groups: [{ pkg: 'a', v: 1 }] };
    const after = { groups: [{ pkg: 'a', v: 2 }] };
    const d = diff(before, after);
    const rep = applyDeltaReport({ groups: [{ pkg: 'zzz', v: 1 }] }, d);
    if (!rep.missing.length) throw new Error('missing path not reported');
    const good = applyDeltaReport(before, d);
    if (good.missing.length) throw new Error('healthy replay reported missing: ' + JSON.stringify(good.missing));
    return 'reported';
  });

  await check('apply: legacy string paths still replay', () => {
    const legacy: any = [{ path: 'groups[0].v', kind: 'changed', before: 1, after: 5 }];
    const got: any = applyDelta({ groups: [{ pkg: 'a', v: 1 }] }, legacy);
    if (got.groups[0].v !== 5) throw new Error('legacy path failed');
    return 'legacy ok';
  });

  await check('diff: chain round-trip across 3 commits (walk back)', () => {
    // Simulates the restore path: working-tree (sN) + reverse-applying N forward
    // deltas must land on the original base state.
    const s0 = { n: 0, tags: [] as string[], meta: { v: 0 } };
    const s1 = { n: 1, tags: ['a'], meta: { v: 0 } };
    const s2 = { n: 2, tags: ['a', 'b'], meta: { v: 1 } };
    const s3 = { n: 2, tags: ['a'], meta: { v: 1, extra: true } };
    const deltas = [diff(s0, s1), diff(s1, s2), diff(s2, s3)];
    // Forward composition: applying deltas in order on s0 yields s3
    let cur: any = JSON.parse(JSON.stringify(s0));
    for (const d of deltas) cur = applyDelta(cur, d);
    if (JSON.stringify(cur) !== JSON.stringify(s3)) throw new Error('forward chain failed');
    // Reverse composition: walk s3 back via inverse deltas in reverse order
    cur = JSON.parse(JSON.stringify(s3));
    for (let i = deltas.length - 1; i >= 0; i--) cur = applyDelta(cur, invertDelta(deltas[i]));
    if (JSON.stringify(cur) !== JSON.stringify(s0)) throw new Error('reverse chain failed');
  });

  await check('merge: edits land on SmartP raw, teg-only fields stay out', () => {
    // Working copy came from teg: it has a field SmartP never had and a
    // different value for one that both have. The user only touched `a`.
    const raw = { a: 1, b: { x: 1, y: 2 } };
    const before = { a: 9, b: { x: 1, y: 2 }, tegOnly: true };
    const after = { a: 5, b: { x: 1, y: 2 }, tegOnly: true };
    const { value, changed } = mergeOntoRaw({ raw, before, after });
    const v = value as any;
    if (!changed) throw new Error('edit not detected');
    if (v.a !== 5) throw new Error('edit lost: ' + JSON.stringify(v));
    if (v.b.y !== 2) throw new Error('untouched SmartP field lost: ' + JSON.stringify(v));
    if ('tegOnly' in v) throw new Error('teg-only field leaked into SmartP: ' + JSON.stringify(v));
    if (raw.a !== 1) throw new Error('raw input mutated');
    return 'a=5, b kept, tegOnly dropped';
  });

  await check('version: a teg-sourced meta never writes its version into SmartP', () => {
    const tegSourced = pickSmartpVersion({ fromTeg: true, version: 2026010101 });
    if (tegSourced !== undefined) {
      throw new Error('teg version leaked into SmartP column: ' + tegSourced);
    }
    const own = pickSmartpVersion({ version: 2026010101, smartpVersion: 2025010101 });
    if (own !== 2025010101) throw new Error('SmartP column not preferred: ' + own);
    const locked = pickSmartpVersion({ originalVersion: 2025010101, version: 2099010101 });
    if (locked !== 2099010101) throw new Error('locked version not honoured: ' + locked);
    if (pickSmartpVersion({ smartpVersion: 0 }) !== undefined) {
      throw new Error('zero must mean unknown, not a version');
    }
    return 'teg dropped / own kept / lock wins';
  });

  await check('rows: one broken JSON row does not blank the others', () => {
    const rows = [
      { config_name: 'booster_config', params: '{"a":1}', version: 1 },
      { config_name: 'common_config', params: '{"game_list":["com.x"]', version: 2 },
      { config_name: 'thermal_config', params: '{}', version: 3 },
    ];
    const { configs, issues } = parseCloudConfigRows(rows);
    if (Object.keys(configs).length !== 3) throw new Error('a row was dropped');
    if (configs.booster_config.params.a !== 1) throw new Error('good row not parsed');
    if (!configs.common_config.meta.broken) throw new Error('broken row not flagged');
    if (configs.common_config.meta.version !== 2) throw new Error('broken row lost its metadata');
    if (configs.common_config.meta.parseError === undefined) throw new Error('no parse error kept');
    if (issues.length !== 1 || issues[0].config !== 'common_config') {
      throw new Error('issue not reported: ' + JSON.stringify(issues));
    }
    // `{}` is "not delivered yet", not "corrupt" — it must stay writable.
    if (configs.thermal_config.meta.broken) throw new Error('empty row marked broken');
    if (!configs.thermal_config.meta.empty) throw new Error('empty row not flagged empty');
    return '3 rows / 1 broken / 1 empty';
  });

  await check('lock: persisted originals are re-attached, stale ones reported', () => {
    const configs: any = {
      booster_config: { meta: { version: 2099220930 } },
      common_config: { meta: { version: 2024010101 } },
    };
    const { applied, stale } = applyLockedOriginals(configs, {
      booster_config: 2025090830,
      common_config: 2024010101,
      missing_config: 1,
    });
    if (applied.join(',') !== 'booster_config') throw new Error('applied: ' + applied.join(','));
    if (stale.join(',') !== 'common_config') throw new Error('stale: ' + stale.join(','));
    if (configs.booster_config.meta.originalVersion !== 2025090830) {
      throw new Error('original version not restored');
    }
    if (!isVersionLocked(2099220930) || isVersionLocked(2025090830)) {
      throw new Error('lock detection wrong');
    }
    return '1 applied / 1 stale / 1 missing ignored';
  });

  await check('commit: no-op means no history and no restart', () => {
    if (commitOutcome(0, false, true) !== 'no-change') throw new Error('empty delta not no-change');
    if (commitOutcome(0, true, true) !== 'no-change') throw new Error('empty delta with writes');
    return 'no-change';
  });

  await check('commit: edits outside the write target are reported, not written', () => {
    if (commitOutcome(2, false, false) !== 'out-of-scope') throw new Error('not out-of-scope');
    if (commitOutcome(2, true, false) !== 'written') throw new Error('smartp write misclassified');
    if (commitOutcome(1, false, true) !== 'written') throw new Error('teg write misclassified');
    return 'scope respected';
  });

  await check('merge: no edits returns the raw value unchanged', () => {
    const raw = { a: 1, list: [1, 2, 3] };
    const { value, changed } = mergeOntoRaw({ raw, before: { a: 7 }, after: { a: 7 } });
    if (changed) throw new Error('reported a change with identical copies');
    if (value !== raw) throw new Error('raw value was cloned or replaced');
    return 'unchanged';
  });

  await check('writeback: 第二次提交以磁盘为准，不会回滚第一次的改动', () => {
    // Pull sees {a:1,b:1}. The user edits a, commits: disk becomes {a:2,b:1}.
    // Then edits b. Merging onto the *old* raw would emit {a:1,b:2} and quietly
    // undo the first commit — the in-memory raw copy has to follow the write.
    const disk: any = { a: 1, b: 1 };
    const first = planSmartpWrite({
      raw: disk,
      workBefore: { a: 1, b: 1 },
      workAfter: { a: 2, b: 1 },
      source: 'smartp',
    });
    if (!first.write) throw new Error('first commit was skipped: ' + first.reason);
    Object.assign(disk, first.params as any);

    const second = planSmartpWrite({
      raw: disk,
      workBefore: { a: 2, b: 1 },
      workAfter: { a: 2, b: 2 },
      source: 'smartp',
    });
    if (!second.write) throw new Error('second commit was skipped: ' + second.reason);
    const out = second.params as any;
    if (out.a !== 2 || out.b !== 2) throw new Error('earlier edit rolled back: ' + JSON.stringify(out));

    // Same call with the stale base reproduces the bug — kept as documentation.
    const stale = mergeOntoRaw({ raw: { a: 1, b: 1 }, before: { a: 2, b: 1 }, after: { a: 2, b: 2 } });
    if ((stale.value as any).a !== 1) throw new Error('expected the stale base to drop a=2');
    return 'a=2 & b=2 kept';
  });

  await check('writeback: 无 SmartP 行 / teg 来源 / 无改动 都不写', () => {
    const noRow = planSmartpWrite({ raw: undefined, workBefore: { a: 1 }, workAfter: { a: 2 } });
    if (noRow.write || noRow.reason !== 'no-row') throw new Error('missing row not skipped');
    const tegSourced = planSmartpWrite({
      raw: { a: 1 },
      workBefore: undefined,
      workAfter: { a: 2, fromTeg: true },
      source: 'teg',
    });
    if (tegSourced.write) throw new Error('teg working copy written into SmartP');
    const unchanged = planSmartpWrite({
      raw: { a: 1 },
      workBefore: { a: 1 },
      workAfter: { a: 1 },
      source: 'smartp',
    });
    if (unchanged.write || unchanged.reason !== 'unchanged') throw new Error('no-op not skipped');
    return 'no-row / teg / unchanged skipped';
  });

  await check('writeback: 没有工作基线时只允许 SmartP 来源整份写入', () => {
    const whole = planSmartpWrite({
      raw: { a: 1 },
      workBefore: undefined,
      workAfter: { a: 2, b: 3 },
      source: 'smartp',
    });
    if (!whole.write || whole.reason !== 'wholesale') throw new Error('smartp wholesale rejected');
    const same = planSmartpWrite({
      raw: { a: 1 },
      workBefore: undefined,
      workAfter: { a: 1 },
      source: 'smartp',
    });
    if (same.write) throw new Error('identical wholesale copy was still written');
    return 'wholesale only for smartp source';
  });

  await check('diff: array trailing remove is correctly inverted', () => {
    // Regression: diff() emits `removed` records for trailing array elements
    // in ascending index order. applyDelta's reverse-processing must restore
    // them cleanly via invertDelta.
    const before = { xs: ['a', 'b', 'c', 'd', 'e'] };
    const after = { xs: ['a', 'b'] };
    const d = diff(before, after);
    const fwd = applyDelta(before, d);
    if (JSON.stringify(fwd) !== JSON.stringify(after)) throw new Error('forward truncation failed');
    const back = applyDelta(after, invertDelta(d));
    if (JSON.stringify(back) !== JSON.stringify(before)) throw new Error('reverse extension failed');
  });
}

async function runFrcStringTest() {
  console.log('\n=== frc validation edge cases ===');
  await check('frc: rejects 11-field string', () => {
    try {
      parseFrc('pkg_1_2_3_4_5_6_7_8_9_10');
    } catch {
      return 'correctly rejected';
    }
    throw new Error('should have thrown');
  });
  await check('frc: validateFrc flags min < src+1', () => {
    const p = blankFrc('com.x');
    p.minFps = 30;
    p.srcFps = 60;
    const issues = validateFrc(p, [60, 90]);
    if (!issues.some((i) => i.field === 'relation')) throw new Error('expected relation issue');
  });
  await check('frc: serialize preserves "46.5" temperature', () => {
    const p = blankFrc('com.x');
    p.t2 = 46.5;
    const s = serializeFrc(p);
    if (!s.includes('_46.5_')) throw new Error(`expected 46.5 in output: ${s}`);
  });
  await check('frc: rejects package name with underscore', () => {
    const p = blankFrc('has_underscore');
    try {
      serializeFrc(p);
    } catch {
      return 'rejected';
    }
    throw new Error('should have rejected');
  });
}

async function runPolicyResultTest() {
  console.log('\n=== policy add outcome ===');
  await check('policy: duplicate feature reports its own reason', () => {
    const cfg = emptyFisrConfig();
    const first = addPolicyForPkg(cfg, 'com.a', { feature: 'FI', strategy: 1 } as any);
    if (!first.ok) throw new Error('first add refused: ' + JSON.stringify(first));
    const again = addPolicyForPkg(cfg, 'com.a', { feature: 'FI', strategy: 2 } as any);
    if (again.ok) throw new Error('duplicate accepted');
    if (again.reason !== 'duplicate') throw new Error('wrong reason: ' + again.reason);
    const group = findGroupForPkg(cfg, 'com.a')!;
    if (group.enhance_policy_config.length !== 1) throw new Error('duplicate mutated the list');
    return 'duplicate reported without mutating';
  });
  await check('policy: empty package name is refused explicitly', () => {
    const cfg = emptyFisrConfig();
    const res = addPolicyForPkg(cfg, '   ', { feature: 'FI', strategy: 1 } as any);
    if (res.ok || res.reason !== 'invalid-pkg') throw new Error('not refused: ' + JSON.stringify(res));
    if ((cfg.enhance_config as any[]).length !== 0) throw new Error('created a group for an empty name');
    return 'invalid-pkg';
  });

  await check('policy: 重复添加不拆分共享组', () => {
    // A shared group is [com.a, com.b] with feature FI. Adding FI to com.a is a
    // no-op — and it must stay a no-op, not split the group on the way to
    // returning `duplicate`. Splitting changes what the other game sees.
    const cfg: any = {
      enhance_config: [
        {
          game_list: ['com.a', 'com.b'],
          enhance_policy_config: [{ feature: 'FI', strategy: 1 }],
        },
      ],
    };
    const before = JSON.stringify(cfg);
    const res = addPolicyForPkg(cfg, 'com.a', { feature: 'FI', strategy: 1 } as any);
    if (res.ok || res.reason !== 'duplicate') throw new Error('not duplicate: ' + JSON.stringify(res));
    if (JSON.stringify(cfg) !== before) throw new Error('shared group was split by a no-op');
    return 'duplicate, structure untouched';
  });

  await check('policy: 删除不存在的 feature 不拆分共享组', () => {
    const cfg: any = {
      enhance_config: [
        {
          game_list: ['com.a', 'com.b'],
          enhance_policy_config: [{ feature: 'FI', strategy: 1 }],
        },
      ],
    };
    const before = JSON.stringify(cfg);
    const removed = removePolicyForPkg(cfg, 'com.a', 'NOPE');
    if (removed) throw new Error('reported a removal that did not happen');
    if (JSON.stringify(cfg) !== before) throw new Error('shared group was split by a no-op');
    return 'missing feature, structure untouched';
  });
  await check('policy: adding to a shared group reports the split', () => {
    const cfg = emptyFisrConfig();
    (cfg.enhance_config as any[]).push({
      game_list: ['com.a', 'com.b'],
      enhance_policy_config: [{ feature: 'FI', strategy: 1 }],
    });
    const res = addPolicyForPkg(cfg, 'com.a', { feature: 'SR', strategy: 2 } as any);
    if (!res.ok) throw new Error('refused: ' + JSON.stringify(res));
    if (!res.splitShared) throw new Error('split not reported');
    const a = findGroupForPkg(cfg, 'com.a')!;
    const b = findGroupForPkg(cfg, 'com.b')!;
    if (a === b) throw new Error('group not split');
    if (a.enhance_policy_config.length !== 2) throw new Error('new policy not on the split group');
    if (b.enhance_policy_config.length !== 1) throw new Error('peer group changed');
    return 'split reported and peer untouched';
  });
  await check('lock: isCloudLocked reads the booster_config version only', () => {
    if (isCloudLocked(null)) throw new Error('null must be unlocked');
    if (isCloudLocked({})) throw new Error('empty must be unlocked');
    if (isCloudLocked({ booster_config: { meta: {} } })) throw new Error('missing version must be unlocked');
    if (!isCloudLocked({ booster_config: { meta: { version: 2099012345 } } })) {
      throw new Error('2099 version must be locked');
    }
    if (isCloudLocked({ common_config: { meta: { version: 2099012345 } } })) {
      throw new Error('other configs must not drive the cloud badge');
    }
    return 'booster_config only';
  });
}

async function runMifisrStringTest() {
  console.log('\n=== mifisr validation edge cases ===');

  await check('mifisr: parse Ultra原神 canonical form', () => {
    const p = parseMifisr('com.miHoYo.Yuanshen_-1#-1#45,60#47#45#44#42');
    if (p.pkg !== 'com.miHoYo.Yuanshen') throw new Error('pkg');
    if (p.minFps !== -1) throw new Error('minFps');
    if (p.targetFps !== -1) throw new Error('targetFps');
    if (JSON.stringify(p.srcFps) !== JSON.stringify([45, 60])) throw new Error('srcFps');
    if (p.t1 !== 47 || p.t2 !== 45 || p.t3 !== 44 || p.t4 !== 42) throw new Error('thermal');
  });

  await check('mifisr: parse Ultra星铁 single-srcFps form', () => {
    const p = parseMifisr('com.miHoYo.hkrpg_-1#-1#60#47#45#44#42');
    if (JSON.stringify(p.srcFps) !== JSON.stringify([60])) throw new Error(`srcFps ${p.srcFps}`);
  });

  await check('mifisr: rejects pkg with underscore', () => {
    try {
      serializeMifisr({ ...blankMifisr('has_under'), srcFps: [60] });
    } catch {
      return 'rejected';
    }
    throw new Error('should have rejected');
  });

  await check('mifisr: rejects 6-field body', () => {
    try {
      parseMifisr('pkg_-1#-1#60#47#45#44'); // missing T4
    } catch {
      return 'rejected';
    }
    throw new Error('should have thrown');
  });

  await check('mifisr: rejects whitespace in srcFps list', () => {
    try {
      parseMifisr('pkg_-1#-1#45, 60#47#45#44#42');
    } catch {
      return 'rejected';
    }
    throw new Error('should have thrown');
  });

  await check('mifisr: validateMifisr flags target < min when both explicit', () => {
    const p = blankMifisr('com.x');
    p.minFps = 90;
    p.targetFps = 60;
    const issues = validateMifisr(p).filter((i) => i.severity !== 'warn');
    if (!issues.some((i) => i.field === 'relation')) throw new Error('expected relation issue');
  });

  await check('mifisr: validateMifisr warns on srcFps < 45 (not error)', () => {
    const p = blankMifisr('com.x');
    p.srcFps = [30];
    const issues = validateMifisr(p);
    if (!issues.some((i) => i.field === 'srcFps' && i.severity === 'warn')) {
      throw new Error('expected warn on srcFps=30');
    }
    if (issues.some((i) => i.field === 'srcFps' && i.severity !== 'warn')) {
      throw new Error('srcFps=30 should not be an error');
    }
  });

  await check('mifisr: validateMifisr flags T4 > T1 (non-monotonic)', () => {
    const p = blankMifisr('com.x');
    p.t1 = 40;
    p.t4 = 80;
    const issues = validateMifisr(p).filter((i) => i.severity !== 'warn');
    if (!issues.some((i) => i.field === 'relation')) throw new Error('expected relation issue');
  });

  await check('mifisr: mifisrStandard preset returns triple FI/SR/FISR policies with correct strategies', () => {
    const policy = STRATEGY_PRESETS.mifisrStandard();
    if (policy.length !== 3) throw new Error(`expected 3 policies, got ${policy.length}`);
    // All three bind to MIFISR — matches Xiaomi 17 Ultra cloud drops verbatim.
    // MIFISR's a() is dynamic (k(pkg,status) re-calibrates it per call), so a
    // single MIFISR instance can handle FI (1) / SR (2) / FISR (4) alike.
    const want = [
      ['FI', 'MIFISR'],
      ['SR', 'MIFISR'],
      ['FISR', 'MIFISR'],
    ];
    for (let i = 0; i < 3; i++) {
      if (policy[i].feature !== want[i][0]) {
        throw new Error(`policy[${i}].feature=${policy[i].feature}, want ${want[i][0]}`);
      }
      if (policy[i].strategy !== want[i][1]) {
        throw new Error(`policy[${i}].strategy=${policy[i].strategy}, want ${want[i][1]}`);
      }
      if ((policy[i] as any).support_game_mode !== '1#1') {
        throw new Error(`policy[${i}] default support_game_mode should be 1#1`);
      }
    }
  });

  await check('mifisr: mifisrStandard upsert produces all three FI/SR/FISR routes', () => {
    const cfg = emptyFisrConfig();
    upsertPkgPolicy(cfg, 'com.test.mifisr', STRATEGY_PRESETS.mifisrStandard());
    const group = findGroupForPkg(cfg, 'com.test.mifisr');
    if (!group) throw new Error('group missing');
    if (group.enhance_policy_config.length !== 3) {
      throw new Error(`policy count ${group.enhance_policy_config.length}, expected 3`);
    }
    const pairs = group.enhance_policy_config
      .map((p) => `${p.feature}:${p.strategy}`)
      .sort()
      .join(',');
    const want = ['FI:MIFISR', 'FISR:MIFISR', 'SR:MIFISR'].sort().join(',');
    if (pairs !== want) throw new Error(`pairs=${pairs}, want ${want}`);
  });

  await check('fisr: editing one game splits a shared policy group', () => {
    const cfg: any = {
      enhance_config: [
        {
          game_list: ['com.a', 'com.b'],
          support_vk: false,
          enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }],
        },
      ],
    };
    upsertPkgPolicy(cfg, 'com.a', [{ feature: 'FI', strategy: 'MIFISR' }]);
    const a = findGroupForPkg(cfg, 'com.a');
    const b = findGroupForPkg(cfg, 'com.b');
    if (!a || !b) throw new Error('group missing after upsert');
    if (a === b) throw new Error('shared group was edited in place');
    if (a.enhance_policy_config[0]?.strategy !== 'MIFISR') {
      throw new Error('target strategy not applied: ' + JSON.stringify(a));
    }
    if (b.enhance_policy_config[0]?.strategy !== 'AFME') {
      throw new Error('neighbour strategy changed: ' + JSON.stringify(b));
    }
    if (b.game_list.length !== 1 || b.game_list[0] !== 'com.b') {
      throw new Error('neighbour list changed: ' + JSON.stringify(b.game_list));
    }
    if (a.game_list.length !== 1) throw new Error('target still shared');
    return 'split: a independent, b untouched';
  });

  await check('fisr: setPkgSupportVk on a shared group stays scoped to one game', () => {
    const cfg: any = {
      enhance_config: [
        {
          game_list: ['com.a', 'com.b'],
          support_vk: false,
          enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }],
        },
      ],
    };
    if (!setPkgSupportVk(cfg, 'com.a', true)) throw new Error('set refused');
    const a = findGroupForPkg(cfg, 'com.a')!;
    const b = findGroupForPkg(cfg, 'com.b')!;
    if (a.support_vk !== true) throw new Error('flag not set on target');
    if (b.support_vk !== false) throw new Error('flag leaked to neighbour');
    return 'scoped to com.a';
  });

  await check('fisr: a single-game group is edited without cloning', () => {
    const cfg: any = {
      enhance_config: [
        { game_list: ['com.a'], enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }] },
      ],
    };
    const before = cfg.enhance_config.length;
    const own = splitPkgGroup(cfg, 'com.a');
    if (cfg.enhance_config.length !== before) throw new Error('group duplicated');
    if (own !== cfg.enhance_config[0]) throw new Error('returned a different group');
    return 'in place';
  });

  await check('impact: shared group names its peers, lone group does not', () => {
    const cfg: any = {
      enhance_config: [
        { game_list: ['com.a', 'com.b', 'com.c'], enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }, { feature: 'FISR', strategy: 'FRC' }] },
        { game_list: ['com.solo'], enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }] },
      ],
    };
    const shared = groupImpact(cfg, 'com.b')!;
    if (!shared.shared) throw new Error('shared group not detected');
    if (shared.peers.join(',') !== 'com.a,com.c') throw new Error('peers wrong: ' + shared.peers.join(','));
    if (shared.policies !== 2) throw new Error('policy count wrong: ' + shared.policies);
    const solo = groupImpact(cfg, 'com.solo')!;
    if (solo.shared || solo.peers.length !== 0) throw new Error('lone group reported as shared');
    if (groupImpact(cfg, 'com.missing') !== null) throw new Error('missing pkg must return null');
    return 'peers com.a,com.c / solo clean';
  });

  await check('routes: deleting a game clears its enhancement routes only', () => {
    const gb: any = {
      fisr_config: {
        enhance_config: [
          { game_list: ['com.a', 'com.b'], enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }] },
        ],
      },
      mqs_enhance_list: ['com.a:60#default', 'com.b:60#default'],
      customize_game_params: { dp_fi_config: ['com.a_dmi', 'com.b_dmi'] },
      support_highfps_app: ['com.a:120', 'com.b:120'],
      novatek_gex_fps_limit: ['com.a:144'],
      frc_game_params: ['com.a_45_90_30_60_47_46_43_41_0x0_1_1'],
    };
    const before = findPkgRoutes(gb, 'com.a').map((r) => r.key);
    if (before.length !== 6) throw new Error('expected 6 routes, got ' + before.join(','));
    const res = removePkgRoutes(gb, 'com.a');
    const removed = res.removed.map((r) => r.key).sort().join(',');
    if (removed !== 'customize_game_params.dp_fi_config,fisr_config,mqs_enhance_list,support_highfps_app') {
      throw new Error('removed set wrong: ' + removed);
    }
    const kept = res.kept.map((r) => r.key).sort().join(',');
    if (kept !== 'frc_game_params,novatek_gex_fps_limit') throw new Error('kept set wrong: ' + kept);
    if (findPkgRoutes(gb, 'com.a').length !== 2) throw new Error('routes left: ' + findPkgRoutes(gb, 'com.a').map((r) => r.key).join(','));
    // Neighbour untouched.
    const nb = findPkgRoutes(gb, 'com.b').map((r) => r.key).sort().join(',');
    if (nb !== 'customize_game_params.dp_fi_config,fisr_config,mqs_enhance_list,support_highfps_app') {
      throw new Error('neighbour damaged: ' + nb);
    }
    return '4 cleaned / 2 kept / neighbour intact';
  });

  await check('rename: every route moves with the package', () => {
    const gb: any = {
      fisr_config: {
        enhance_config: [
          { game_list: ['com.old', 'com.peer'], enhance_policy_config: [{ feature: 'FI', strategy: 'AFME' }] },
        ],
      },
      mqs_enhance_list: ['com.old:60#default', 'com.peer:60#default'],
      customize_game_params: { dp_fi_config: ['com.old_dmi'] },
      support_highfps_app: ['com.old:120'],
      novatek_gex_fps_limit: ['com.old:144'],
      frc_game_params: ['com.old_45_90_30_60_47_46_43_41_0x0_1_1'],
    };
    const res = renamePkgRoutes(gb, 'com.old', 'com.new');
    if (!res.ok) throw new Error('rename refused: ' + res.error);
    if (res.migrated.length !== 6) throw new Error('migrated ' + res.migrated.length + ' routes');
    const gl = gb.fisr_config.enhance_config[0].game_list.join(',');
    if (gl !== 'com.new,com.peer') throw new Error('game_list wrong: ' + gl);
    const all = [
      ...gb.mqs_enhance_list,
      ...gb.customize_game_params.dp_fi_config,
      ...gb.support_highfps_app,
      ...gb.novatek_gex_fps_limit,
      ...gb.frc_game_params,
    ].join('|');
    if (/com\.old/.test(all)) throw new Error('old name left behind: ' + all);
    if (!gb.mqs_enhance_list.includes('com.new:60#default')) throw new Error('mqs not renamed');
    if (!gb.frc_game_params[0].startsWith('com.new_')) throw new Error('frc not renamed');
    if (!gb.mqs_enhance_list.includes('com.peer:60#default')) throw new Error('neighbour damaged');
    return '6 routes migrated / neighbour intact';
  });

  await check('rename: refuses a package another game already owns', () => {
    const gb: any = {
      fisr_config: {
        enhance_config: [
          { game_list: ['com.a'], enhance_policy_config: [] },
          { game_list: ['com.taken'], enhance_policy_config: [] },
        ],
      },
      mqs_enhance_list: ['com.a:60#default'],
    };
    const res = renamePkgRoutes(gb, 'com.a', 'com.taken');
    if (res.ok) throw new Error('merged two games');
    if (res.reason !== 'conflict') throw new Error('wrong reason: ' + res.reason);
    if (gb.fisr_config.enhance_config[0].game_list[0] !== 'com.a') throw new Error('mutated on refusal');
    return 'refused';
  });

  await check('rename: rejects placeholder and malformed names', () => {
    const gb: any = { fisr_config: { enhance_config: [{ game_list: ['com.a'], enhance_policy_config: [] }] } };
    for (const bad of ['com.example.newgame', 'nodots', 'com..x', '']) {
      const res = renamePkgRoutes(gb, 'com.a', bad);
      if (res.ok) throw new Error('accepted ' + JSON.stringify(bad));
      if (res.reason !== 'invalid') throw new Error('wrong reason for ' + bad + ': ' + res.reason);
    }
    const same = renamePkgRoutes(gb, 'com.a', 'com.a');
    if (!same.ok || same.migrated.length) throw new Error('same-name rename should be a no-op');
    return '4 rejected / no-op ok';
  });

  await check('routes: second delete is a no-op and reports nothing removed', () => {
    const gb: any = { mqs_enhance_list: ['com.b:60#default'], support_highfps_app: ['com.b:120'] };
    if (findPkgRoutes(gb, 'com.a').length !== 0) throw new Error('unexpected hit');
    const res = removePkgRoutes(gb, 'com.a');
    if (res.removed.length || res.kept.length) throw new Error('reported work on a missing game');
    if (gb.mqs_enhance_list.length !== 1) throw new Error('unrelated entry removed');
    return 'no-op';
  });
}

async function runActiveBackendEdgeCases() {
  console.log('\n=== detectActiveBackend edge cases ===');

  await check('detectActiveBackend: empty booster -> null', () => {
    if (detectActiveBackend({} as any) !== null) throw new Error('should be null');
  });

  await check('detectActiveBackend: fisr_mqs_v2 alone -> mifisr', () => {
    const got = detectActiveBackend({ game_booster: { fisr_mqs_v2: true } } as any);
    if (got !== 'mifisr') throw new Error(`expected mifisr, got ${got}`);
  });

  await check('detectActiveBackend: key_mivk_gputuner_select_enable alone -> null', () => {
    // Intentional non-signal: must not trigger MIFISR classification.
    const got = detectActiveBackend({
      game_booster: { key_mivk_gputuner_select_enable: true },
    } as any);
    if (got !== null) throw new Error(`expected null, got ${got}`);
  });

  await check('detectActiveBackend: Novatek data takes priority over MIFISR flag', () => {
    const got = detectActiveBackend({
      game_booster: {
        fisr_mqs_v2: true,
        novatek_game_params: ['com.x'],
      },
    } as any);
    if (got !== 'novatek') throw new Error(`expected novatek, got ${got}`);
  });

  await check('detectActiveBackend: MIFISR takes priority over Qualcomm legacy', () => {
    const got = detectActiveBackend({
      game_booster: {
        fisr_mqs_v2: true,
        frc_game_params: ['com.x_45_90_30_60_47_46_43_41_0x0_1_1'],
      },
    } as any);
    if (got !== 'mifisr') throw new Error(`expected mifisr, got ${got}`);
  });

  await check('detectActiveBackend: frc_game_params alone -> qualcomm', () => {
    const got = detectActiveBackend({
      game_booster: { frc_game_params: ['com.x_45_90_30_60_47_46_43_41_0x0_1_1'] },
    } as any);
    if (got !== 'qualcomm') throw new Error(`expected qualcomm, got ${got}`);
  });
}

async function runEnvelopeTest() {
  console.log('\n=== rule envelope sync ===');
  await check('envelope: buildRuleEnvelope produces expected shape', () => {
    const env = buildRuleEnvelope('booster_config', { foo: 1 }, 20250101);
    if (env.config_name !== 'booster_config') throw new Error('config_name wrong');
    if (env.group_name !== 'booster_config') throw new Error('group_name wrong');
    if (env.enable !== true) throw new Error('enable wrong');
    if (env.version !== 20250101) throw new Error('version wrong');
    if (env.params.foo !== 1) throw new Error('params not embedded');
  });
  await check('envelope: refreshEnvelope preserves existing fields', () => {
    const orig = {
      config_name: 'booster_config',
      group_name: 'booster_config',
      enable: false,
      version: 1,
      with_model: true,
      params: { old: true },
    };
    const fresh = refreshEnvelope(orig, { fresh: 42 }, 2);
    if (fresh.enable !== false) throw new Error('enable not preserved');
    if (fresh.with_model !== true) throw new Error('with_model not preserved');
    if (fresh.version !== 2) throw new Error('version not applied');
    if ((fresh.params as any).fresh !== 42) throw new Error('params not replaced');
    if ((orig.params as any).old !== true) throw new Error('original mutated');
  });
  await check('envelope: refreshEnvelope handles null source', () => {
    const fresh = refreshEnvelope(null, { a: 1 }, 100);
    if (fresh.version !== 100) throw new Error('version wrong');
    if ((fresh.params as any).a !== 1) throw new Error('params wrong');
  });
  await check('envelope: every key is materialised (no undefined dropped by JSON)', () => {
    const fresh = refreshEnvelope({ version: 5, params: {} } as any, { a: 1 }, 2026080401);
    for (const k of ['config_name', 'group_name', 'enable', 'version', 'with_model', 'params']) {
      if (!(k in fresh)) throw new Error('missing key ' + k);
    }
    if (JSON.stringify(fresh).includes('undefined')) throw new Error('undefined leaked');
    if (fresh.enable !== true || fresh.with_model !== false) throw new Error('defaults wrong');
    return '6 keys, defaults applied';
  });
  await check('envelope: fallbackName repairs empty config_name / group_name', () => {
    const fresh = refreshEnvelope(
      { config_name: '', group_name: '', enable: true, version: 1, with_model: false, params: {} } as any,
      { a: 1 },
      2024010101,
      'common_config',
    );
    if (fresh.config_name !== 'common_config' || fresh.group_name !== 'common_config') {
      throw new Error('not repaired: ' + JSON.stringify(fresh));
    }
    if (JSON.stringify(fresh).includes('""')) throw new Error('empty name leaked');
    return 'repaired to module name';
  });
  await check('envelope: unknown upstream keys survive a refresh', () => {
    const orig = {
      config_name: 'booster_config',
      group_name: 'booster_config',
      enable: true,
      version: 1,
      with_model: false,
      params: { old: 1 },
      // Fields we have never modelled. A fixed-key rebuild used to drop these.
      model: 'Xiaomi 17',
      anchor_percents: [10, 90],
      future_flag: { nested: true },
    };
    const fresh = refreshEnvelope(orig as any, { fresh: 2 }, 3) as Record<string, any>;
    const parsed = JSON.parse(JSON.stringify(fresh));
    if (parsed.model !== 'Xiaomi 17') throw new Error('model dropped');
    if (JSON.stringify(parsed.anchor_percents) !== '[10,90]') throw new Error('anchor_percents dropped');
    if (parsed.future_flag?.nested !== true) throw new Error('unknown object dropped');
    if (parsed.group_name !== 'booster_config' || parsed.version !== 3) throw new Error('known keys wrong');
    if (parsed.params.fresh !== 2) throw new Error('params not replaced');
    return 'kept model/anchor_percents/future_flag';
  });
}

function collectAllKeys(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectAllKeys(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      acc.push(k);
      collectAllKeys(v, acc);
    }
  }
  return acc;
}

async function runFpsLockPrefixTest() {
  console.log('\n=== fpslock prefix matching ===');
  await check('fpslock: prefix matcher covers official PID_* / dynamic_fps* variants', () => {
    const match = ['PID_T', 'PID_M', 'PID_HQ2_T', 'PID_HQ2_M', 'PID_RE2_T', 'PID_RE3_M', 'PID_RE4_T', 'PID_RE5_T', 'dynamic_fps', 'dynamic_fps_M', 'dynamic_fps_T', 'dynamic_fps_RE2'];
    for (const k of match) if (!isFpsLockKey(k)) throw new Error(k + ' should match');
    const noMatch = ['cgame_enable', 'boost_policy', 'scene_ovrride', 'perflock', 'migt', 'start_scene', 'end_scene', 'badfps_thresh1', 'badfps_thresh2', 'PID'];
    for (const k of noMatch) if (isFpsLockKey(k)) throw new Error(k + ' should NOT match');
    return 'prefix matching OK';
  });
  await check('fpslock: same-named keys outside known containers stay', () => {
    const tree: any = {
      game_booster: {
        mifisr_settings: { PID_T: 1, dynamic_fps: 'x' },
        booster_config: { ovrride_config: [{ PID_T: 2 }] },
      },
    };
    const scan = scanFpsLock(tree);
    if (scan.unknownKeys !== 2) throw new Error('unknownKeys=' + scan.unknownKeys);
    if (scan.totalKeys !== 1) throw new Error('totalKeys=' + scan.totalKeys);
    applyUnlockFps(tree);
    if (tree.game_booster.mifisr_settings.PID_T !== 1) throw new Error('unknown PID_T was removed');
    if (tree.game_booster.mifisr_settings.dynamic_fps !== 'x') throw new Error('unknown dynamic_fps removed');
    if ('PID_T' in tree.game_booster.booster_config.ovrride_config[0]) {
      throw new Error('known PID_T not removed');
    }
    return '2 unknown kept / 1 known removed';
  });

  await check('fpslock: apply removes only lock keys and is idempotent', () => {
    const tree: any = {
      game_booster: {
        cgame_enable: true,
        dynamic_fps_global: '10:0,46.5:90,48:60',
        booster_config: { ovrride_config: [{ game_name: 'a.b.c', PID_T: 1, dynamic_fps: 'x' }] },
        mifisr_settings: { untouched: true },
      },
    };
    const before = collectAllKeys(tree);
    const r = applyUnlockFps(tree);
    const after = collectAllKeys(tree);
    const removed = before.filter((k) => !after.includes(k));
    const unexpected = removed.filter(
      (k) => !isFpsLockKey(k) && k !== 'cgame_enable' && k !== 'dynamic_fps_global',
    );
    if (unexpected.length) throw new Error('removed non-lock keys: ' + unexpected.join(','));
    if (after.some((k) => isFpsLockKey(k))) throw new Error('lock keys remain');
    if (!r.changed || r.entriesAffected !== 1) throw new Error('stats wrong');
    if (tree.game_booster.mifisr_settings?.untouched !== true) throw new Error('unrelated key touched');
    if (tree.game_booster.cgame_enable !== false) throw new Error('cgame not disabled');
    if (applyUnlockFps(tree).changed) throw new Error('second apply reported a change');
    return `removed ${removed.length} key(s), idempotent`;
  });
}

async function runLiftThermalTest() {
  console.log('\n=== dynamic_fps threshold lift ===');
  await check('lift: 46.5/48 -> 96.5/98', () => {
    const out = liftDynamicFpsTemps('10:0,46.5:90,48:60');
    if (out !== '10:0,96.5:90,98:60') throw new Error(out);
    return out;
  });
  await check('lift: 42.5/44 -> 92.5/94', () => {
    const out = liftDynamicFpsTemps('10:0,42.5:90,44:60');
    if (out !== '10:0,92.5:90,94:60') throw new Error(out);
    return out;
  });
  await check('lift: already 9x is idempotent', () => {
    const v = '10:0,98:90,99:60';
    if (liftDynamicFpsTemps(v) !== v) throw new Error('not idempotent');
    return 'idempotent';
  });
  await check('lift: non 3x-5x temperatures (10/12) preserved', () => {
    if (liftDynamicFpsTemps('10:0') !== '10:0') throw new Error('10 changed');
    if (liftDynamicFpsTemps('12:0') !== '12:0') throw new Error('12 changed');
    if (liftDynamicFpsTemps('') !== '') throw new Error('empty changed');
    if (liftDynamicFpsTemps('abc') !== 'abc') throw new Error('no-colon changed');
    return 'preserved';
  });
  await check('lift: removes PID_*, lifts dynamic_fps*, leaves cgame_enable alone', () => {
    const tree: any = {
      game_booster: {
        cgame_enable: true,
        dynamic_fps_global: '10:0,46.5:90,48:60',
        booster_config: {
          ovrride_config: [
            { game_name: 'a.b.c', dynamic_fps: '10:0,42.5:90,44:60', dynamic_fps_M: '10:0,40:90,41:60', PID_T: 1, PID_M: 2 },
          ],
        },
        mifisr_settings: { untouched: true },
      },
    };
    const r = applyLiftThermalFps(tree);
    const gb = tree.game_booster;
    if (gb.booster_config.ovrride_config[0].dynamic_fps !== '10:0,92.5:90,94:60') throw new Error('dynamic_fps not lifted');
    if (gb.booster_config.ovrride_config[0].dynamic_fps_M !== '10:0,90:90,91:60') throw new Error('dynamic_fps_M not lifted');
    if (gb.dynamic_fps_global !== '10:0,96.5:90,98:60') throw new Error('global not lifted');
    if ('PID_T' in gb.booster_config.ovrride_config[0] || 'PID_M' in gb.booster_config.ovrride_config[0]) throw new Error('PID not removed');
    if (gb.cgame_enable !== true) throw new Error('cgame_enable should stay');
    if (gb.mifisr_settings?.untouched !== true) throw new Error('unrelated key touched');
    if (!r.changed || !r.liftedKeys.includes('dynamic_fps') || r.removedByKey['PID_T'] !== 1) throw new Error('stats wrong');
    return 'lift-only scope confirmed';
  });
  await check('lift: no content -> changed=false', () => {
    if (applyLiftThermalFps({ game_booster: { cgame_enable: true, frc_game_params: [] } }).changed !== false) {
      throw new Error('should be no-op');
    }
    return 'no-op';
  });
  await check('scan: reports cgame / global / totals from a booster tree', () => {
    const s = scanFpsLock({
      game_booster: { cgame_enable: false, dynamic_fps_global: 'x', booster_config: { ovrride_config: [{ game_name: 'g', PID_T: 1 }] } },
    });
    if (s.cgameEnables !== false) throw new Error('cgame wrong');
    if (!s.hasDynamicFpsGlobal) throw new Error('global wrong');
    if (s.totalKeys !== 2) throw new Error('total wrong: ' + s.totalKeys);
    if (s.entries.length !== 1 || s.entries[0].name !== 'g') throw new Error('entry wrong');
    return 'scan OK';
  });
}

async function runThermalUnlockTest() {
  console.log('\n=== thermal unlock regressions ===');
  const STANDARD =
    'com.tencent.mf.uam_49#144#48,144,1,0x2012,0,0,1,0x535#45#43#43#41_0#0#0,0,0,0,1,2,1,0x535,1,1,0,0,0x22#45#43#43#41_49#144#48,144,1,0x2012,1,2,1,0x535,1,1,0,0,0x22#45#43#43#41';
  const WANT =
    'com.tencent.mf.uam_49#144#48,144,1,0x2012,0,0,1,0x535#95#93#93#91_0#0#0,0,0,0,1,2,1,0x535,1,1,0,0,0x22#95#93#93#91_49#144#48,144,1,0x2012,1,2,1,0x535,1,1,0,0,0x22#95#93#93#91';
  await check('thermal: standard novatek never touches next-set minFps (49 stays 49)', () => {
    const { out } = liftTempGroupsInString(STANDARD);
    if (out !== WANT) throw new Error('unexpected: ' + out.slice(0, 130));
    return 'all 3 sets lifted, 49#144 preserved';
  });
  await check('thermal: FRC / MIFISR / GPU delimiters lift without fps drift', () => {
    const frc = liftTempGroupsInString('com.x_45_90_30_60_47_46.5_43_41_0x0_1_1').out;
    if (!frc.includes('_97_96.5_93_91')) throw new Error('frc miss: ' + frc);
    const mif = liftTempGroupsInString('com.x_-1#-1#45,60#47#45#44#42').out;
    if (!mif.includes('#97#95#94#92')) throw new Error('mifisr miss: ' + mif);
    const gpu = liftTempGroupsInString('com.x_0#0#0,0,0,0,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#46.7#45#43#41').out;
    if (!gpu.includes('#96.7#95#93#91')) throw new Error('gpu set lift miss: ' + gpu);
    return 'delimiters handled';
  });
  await check('thermal: complex |49#144 boundary preserved', () => {
    const src = 'com.x_49#144#48,144,1,0x2114,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#45#43#41.5#40&41#120#40,120,1,0x2114,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#46.7#45#43#41|49#144#48,144,1,0x2114,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#46.7#45#43#41';
    const { out } = liftTempGroupsInString(src);
    if (out.includes('|99#144')) throw new Error('|49 became 99');
    if (!out.includes('#95#93#91.5#') || !out.includes('#96.7#')) throw new Error('temps not lifted');
    return '|49#144 preserved, temps lifted';
  });
  await check('thermal: &-suffixed minFps preserved (40&41 -> 90&41, 120 untouched)', () => {
    const src = 'com.x_a#1#2#45#43#41.5#40&41#120#40,120,1,0x1#46.7#45#43#41';
    const want = 'com.x_a#1#2#95#93#91.5#90&41#120#40,120,1,0x1#96.7#95#93#91';
    const { out } = liftTempGroupsInString(src);
    if (out !== want) throw new Error('got: ' + out);
    return '& minFps preserved';
  });
  await check('thermal: idempotent (second run no-op)', () => {
    const { out, count } = liftTempGroupsInString(WANT);
    if (count !== 0 || out !== WANT) throw new Error('not idempotent');
    return 'idempotent';
  });
  await check('thermal: findTempGroups only groups >=2 same-delimiter atoms', () => {
    const g = findTempGroups('a#45#43#41_b#120');
    if (g.length !== 1 || g[0].delim !== '#' || g[0].temps.length !== 3) {
      throw new Error('grouping wrong: ' + JSON.stringify(g));
    }
    if (findTempGroups('a#45_b#43').length !== 0) throw new Error('crossed section boundary');
    return 'grouping OK';
  });
  await check('thermal: unknown fields are previewed but never rewritten', () => {
    const tree: any = {
      game_booster: {
        future_thermal_field: ['x#45#43#41'],
        frc_game_params: ['com.a_45_90_30_60_47_46_43_41'],
      },
    };
    const scan = scanThermalUnlock(tree);
    if (!scan.unknownFields) throw new Error('unknown field not reported');
    const r = applyThermalUnlock(tree);
    if (!r.changed) throw new Error('apply did nothing');
    if (tree.game_booster.future_thermal_field[0] !== 'x#45#43#41') {
      throw new Error('unknown field was rewritten: ' + tree.game_booster.future_thermal_field[0]);
    }
    if (!tree.game_booster.frc_game_params[0].includes('_96_93_91')) {
      throw new Error('known field not lifted');
    }
    return 'unknown kept / known lifted';
  });

  await check('thermal: 预览列出字段与前后值，且不动原树', () => {
    const tree: any = {
      game_booster: {
        frc_game_params: [{ pkg: 'com.b', raw: 'com.b_45_90_30_60_47_46_43_41' }],
        future_thermal_field: ['x#45#43#41'],
      },
    };
    const snapshot = JSON.stringify(tree);
    const rows = previewThermalUnlock(tree);
    if (JSON.stringify(tree) !== snapshot) throw new Error('preview mutated the tree');
    if (rows.length !== 1) throw new Error('expected 1 row, got ' + rows.length);
    if (rows[0].field !== 'raw') throw new Error('wrong field: ' + rows[0].field);
    if (!rows[0].before.includes('_47_46_43_41')) throw new Error('before is wrong: ' + rows[0].before);
    if (!rows[0].after.includes('_97_96_93_91')) throw new Error('after is wrong: ' + rows[0].after);
    return '1 row, tree untouched';
  });

  await check('thermal: 预览对已处理过的树返回空', () => {
    const tree: any = { game_booster: { frc_game_params: ['com.b_45_90_30_60_97_96_93_91'] } };
    const rows = previewThermalUnlock(tree);
    if (rows.length) throw new Error('preview invented a change');
    return 'empty';
  });

  await check('preflight: 占位包名与真实包名的边界', () => {
    const bad = ['', 'com.example.newgame', 'com.example.game', 'your.package.name', 'your.company.app'];
    for (const p of bad) {
      if (!isPlaceholderPkg(p)) throw new Error('missed placeholder: ' + p);
    }
    const good = ['com.miHoYo.Yuanshen', 'com.tencent.tmgp.sgame', 'com.miHoYo.cloudgame.GI'];
    for (const p of good) {
      if (isPlaceholderPkg(p)) throw new Error('false positive: ' + p);
    }
    return `${bad.length} rejected / ${good.length} accepted`;
  });

  await check('preflight: 用真实 state 结构拦截三个域里的占位包名', () => {
    // The shape below is what App.vue actually passes. Every per-game list
    // hangs off booster_config.params.game_booster, and the entries are
    // serialized strings. The previous fixture used a convenience object
    // (`{ game_mifisr_config: { params: … } }`) that never occurs at runtime,
    // which is exactly why the broken path in preflight.ts looked green.
    const raw = (p: string) => serializeMifisr(blankMifisr(p));
    const wrap = (gb: any) => ({ booster_config: { params: { game_booster: gb } } });

    const mifisr = wrap({
      customize_game_params: {
        game_mifisr_config: [raw('com.example.newgame'), raw('com.example.newgame')],
      },
    });
    const i1 = preflightCloudConfig(mifisr);
    if (i1.length !== 1) throw new Error('mifisr: expected 1 issue, got ' + i1.length);

    const frc = wrap({ frc_game_params: [serializeFrc(blankFrc('com.example.newgame'))] });
    const i2 = preflightCloudConfig(frc);
    if (i2.length !== 1) throw new Error('frc: expected 1 issue, got ' + i2.length);

    const nt = wrap({
      novatek_game_params: [serializeNovatek(blankNovatek('com.example.newgame'))],
    });
    const i3 = preflightCloudConfig(nt);
    if (i3.length !== 1) throw new Error('novatek: expected 1 issue, got ' + i3.length);

    const clean = wrap({
      customize_game_params: { game_mifisr_config: [raw('com.miHoYo.Yuanshen')] },
      frc_game_params: [serializeFrc(blankFrc('com.tencent.tmgp.sgame'))],
      novatek_game_params: [serializeNovatek(blankNovatek('com.miHoYo.Yuanshen'))],
    });
    if (preflightCloudConfig(clean).length) throw new Error('clean config flagged');
    // preflight runs on every commit, including one with nothing to write.
    if (preflightCloudConfig({}).length) throw new Error('empty config flagged');
    return 'mifisr / frc / novatek all guarded';
  });

  await check('preflight: 顶层 game_mifisr_config 不是真实结构，不再被读取', () => {
    // Guard against the old bug coming back: a top-level row with that name
    // does not exist in the database, so reading it would silently pass every
    // placeholder. The check must ignore it and look only under game_booster.
    const wrong = {
      game_mifisr_config: {
        params: { game_mifisr_config: [serializeMifisr(blankMifisr('com.example.newgame'))] },
      },
    };
    if (preflightCloudConfig(wrong as any).length) {
      throw new Error('read a path that never exists');
    }
    return 'top-level shape ignored';
  });

  await check('thermal: scan + apply round trip on a synthetic tree', () => {
    const tree: any = {
      game_booster: {
        novatek_game_params: ['com.a_49#144#48,144,1,0x2114#45#43#43#41_0#0#0,0,0,0,1#45#43#43#41_49#144#48,144,1,0x2114#45#43#43#41'],
        frc_game_params: [{ pkg: 'com.b', raw: 'com.b_45_90_30_60_47_46.5_43_41' }],
      },
    };
    const scan = scanThermalUnlock(tree);
    if (scan.fieldsAffected < 2) throw new Error('scan missed fields: ' + scan.fieldsAffected);
    const r = applyThermalUnlock(tree);
    if (!r.changed || r.groupsTotal === 0) throw new Error('apply did nothing');
    if (!tree.game_booster.frc_game_params[0].raw.includes('_96.5_93_91')) throw new Error('frc not lifted');
    if (applyThermalUnlock(tree).changed) throw new Error('second apply changed something');
    return `lifted ${r.groupsTotal} groups across ${r.fieldsAffected} fields`;
  });
}

const COMPLEX_NOVATEK =
  'com.miHoYo.Yuanshen_49#144#48,144,1,0x2114,0,0,0,0,0,0,0,0,0,0,0,1,0x1#45#43#41.5#40&41#120#40,120,1,0x2114,0,0,0,0,0,0,0,0,0,0,0,1,0x1#46.7#45#43#41|49#144#48,144,1,0x2114,0,0,0,0,0,0,0,0,0,0,0,1,0x1#46.7#45#43#41_0#0#0,0,0,0,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#46.7#45#43#41_49#144#48,144,1,0x2114,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#45#43#41.5#40&41#120#40,120,1,0x2114,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#46.7#45#43#41|49#144#48,144,1,0x2114,1,0x55,1,0x222,0,0,0,0,0x52,1,0x1#46.7#45#43#41';

async function runNovatekComplexTest() {
  console.log('\n=== novatek complex multi-block ===');
  await check('novatek: complex multi-block round-trips verbatim', () => {
    const p = parseNovatek(COMPLEX_NOVATEK);
    if (serializeNovatek(p) !== COMPLEX_NOVATEK) throw new Error('round-trip mismatch');
    if (!p.complex) throw new Error('complex flag not set');
    return 'pkg=' + p.pkg + ': verbatim';
  });
  await check('novatek: three blocks per set with & / | joins preserved', () => {
    const blocks = describeComplexBlocks(parseNovatek(COMPLEX_NOVATEK).setA.raw as string);
    if (blocks.length !== 3) throw new Error('expected 3 blocks, got ' + blocks.length);
    if (blocks[0].join !== '' || blocks[1].join !== '&' || blocks[2].join !== '|') {
      throw new Error('joins wrong: ' + blocks.map((b) => b.join).join(','));
    }
    if (blocks[1].minFps !== '41' || blocks[1].targetFps !== '120') throw new Error('block2 mis-parse');
    return '3 blocks, joins preserved';
  });
  await check('novatek: setThermal lifts every block', () => {
    const p = parseNovatek(COMPLEX_NOVATEK);
    setThermal(p, '95', '93', '93', '91');
    const out = serializeNovatek(p);
    if (!out.includes('#95#93#93#91&41#120')) throw new Error('temps not lifted / join lost');
    return 'temps lifted, block joins preserved';
  });
  await check('novatek: a block with 8 fields is rejected, not truncated', () => {
    const raw = 'com.x_49#144#48,144,1,0x2114,1,1,1,0x1#45#43#43#41#EXTRA_49#144#48,144,1,0x2114,1,1,1,0x1#45#43#43#41_49#144#48,144,1,0x2114,1,1,1,0x1#45#43#43#41';
    let msg = '';
    try {
      parseNovatek(raw);
    } catch (err: any) {
      msg = String(err.message);
    }
    if (!/expected exactly 7/.test(msg)) throw new Error('accepted 8 fields: ' + msg);
    return 'rejected';
  });

  await check('novatek: csv whitespace round-trips byte-for-byte', () => {
    const raw = 'com.x_49#144#48, 144,1,0x2114,1,1,1,0x1#45#43#43#41_49#144#48,144,1,0x2114,1,1,1,0x1#45#43#43#41_49#144#48,144,1,0x2114,1,1,1,0x1#45#43#43#41';
    const p = parseNovatek(raw);
    if (p.setA.csv[1] !== ' 144') throw new Error('whitespace was trimmed: ' + JSON.stringify(p.setA.csv));
    if (serializeNovatek(p) !== raw) throw new Error('round trip changed the bytes');
    return 'verbatim';
  });

  await check('novatek: surface edits on a short set actually persist', () => {
    const p = parseNovatek(
      'com.miHoYo.Nap_61#120#60,120,1,0x2314#95#93#93#91_0#0#0,0,0,0,1,0x44,1,0x222,0,0,0,0,0x52,1,0x2#95#93#93#91_61#120#60,120,1,0x2314,1,0x44,1,0x222,0,0,0,0,0x52,1,0x2#95#93#93#91',
    );
    p.setA.minFps = '73';
    p.setA.t1 = '47';
    p.setB.targetFps = '144';
    const out = serializeNovatek(p);
    if (!out.startsWith('com.miHoYo.Nap_73#120#')) throw new Error('minFps not applied: ' + out.slice(0, 40));
    if (!out.includes('#47#93#93#91_')) throw new Error('t1 not applied');
    if (!out.includes('_61#144#')) throw new Error('setB targetFps not applied');
    if (serializeNovatek(parseNovatek(out)) !== out) throw new Error('round-trip broken after edit');
    return 'standard short format editable';
  });
}

/* B9: the tab guard is the only thing that can keep an unsaved JSON draft
 * alive. KeepAlive never unmounts the leaving view, so before this the user was
 * asked *after* the switch had already happened — a prompt that could not undo
 * anything, while the draft was overwritten on the next activation. */
async function runNavGuardTest() {
  console.log('\n=== nav guard ===');

  await check('nav: 拒绝的守卫保持当前标签页不变', async () => {
    setLeaveGuard(null);
    await navigate('overview');
    let asked = 0;
    setLeaveGuard(() => {
      asked++;
      return false;
    });
    const ok = await navigate('json');
    setLeaveGuard(null);
    if (ok !== false) throw new Error('navigate 返回了 true');
    if (activeView.value !== 'overview') throw new Error(`标签页变成了 ${activeView.value}`);
    if (asked !== 1) throw new Error(`守卫被调用 ${asked} 次`);
    return 'stayed on overview, guard asked once';
  });

  await check('nav: 接受的守卫放行并关闭抽屉', async () => {
    setLeaveGuard(null);
    await navigate('overview');
    drawerOpen.value = true;
    let asked = 0;
    setLeaveGuard(async () => {
      asked++;
      return true;
    });
    const ok = await navigate('json');
    setLeaveGuard(null);
    if (!ok) throw new Error('navigate 返回了 false');
    if (activeView.value !== 'json') throw new Error(`标签页是 ${activeView.value}`);
    if (drawerOpen.value) throw new Error('抽屉没有关闭');
    if (asked !== 1) throw new Error(`守卫被调用 ${asked} 次`);
    return 'switched to json, drawer closed';
  });

  await check('nav: 守卫抛错按拒绝处理', async () => {
    setLeaveGuard(null);
    await navigate('json');
    setLeaveGuard(() => {
      throw new Error('boom');
    });
    const ok = await navigate('overview');
    setLeaveGuard(null);
    if (ok !== false || activeView.value !== 'json') {
      throw new Error('守卫抛错后仍然切换了页面');
    }
    return 'treated as refusal';
  });

  await check('nav: 同一标签页不打扰用户', async () => {
    setLeaveGuard(null);
    await navigate('history');
    let asked = 0;
    setLeaveGuard(() => {
      asked++;
      return false;
    });
    const ok = await navigate('history');
    setLeaveGuard(null);
    if (!ok) throw new Error('同页导航被拒绝');
    if (asked) throw new Error('同页也问了守卫');
    return 'no prompt';
  });
}

async function runCommitWritesTest(SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  console.log('\n=== write planner ===');
  const smartpBytes = readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Pro Max/SmartP.db'));
  const tegBytes = readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Pro Max/teg_config.db'));

  await check('writes: only touched rows are planned; fallback/broken/empty rows are skipped', () => {
    const db = new SQL.Database(smartpBytes);
    try {
      const rows = listCloudConfig(db);
      const target = rows[0];
      const raw = JSON.parse(String(target.params));
      const edited = JSON.parse(JSON.stringify(raw));
      edited.__probe = 1;
      const cloudConfig = {
        [target.config_name]: { meta: { _real: true, source: 'smartp' }, params: edited },
        from_teg: { meta: { _real: true, fromTeg: true }, params: { a: 1 } },
        broken_row: { meta: { _real: true, broken: true }, params: {} },
        empty_row: { meta: { _real: true, empty: true }, params: {} },
        mirror_row: { meta: { _real: false }, params: { a: 1 } },
      };
      const plan = planSmartpWrites(db, cloudConfig, { [target.config_name]: raw });
      if (plan.writes.length !== 1) throw new Error('planned ' + plan.writes.length + ' writes');
      if (plan.writes[0].name !== target.config_name) throw new Error('wrong row planned');
      for (const [k, reason] of Object.entries({
        from_teg: 'from-teg',
        broken_row: 'broken',
        empty_row: 'empty',
        mirror_row: 'not-smartp',
      })) {
        if (plan.skipped[k] !== reason) throw new Error(`${k}: ${plan.skipped[k]} != ${reason}`);
      }
      return '1 write, 4 skip reasons';
    } finally {
      db.close();
    }
  });

  await check('writes: unchanged row is planned as no write', () => {
    const db = new SQL.Database(smartpBytes);
    try {
      const target = listCloudConfig(db)[0];
      const raw = JSON.parse(String(target.params));
      const plan = planSmartpWrites(
        db,
        { [target.config_name]: { meta: { _real: true, source: 'smartp' }, params: raw } },
        { [target.config_name]: raw },
      );
      if (plan.writes.length !== 0) throw new Error('planned a write for an unchanged row');
      if (plan.skipped[target.config_name] !== 'unchanged') throw new Error('reason: ' + plan.skipped[target.config_name]);
      return 'unchanged';
    } finally {
      db.close();
    }
  });

  await check('writes: applying the plan changes only the planned row', () => {
    const db = new SQL.Database(smartpBytes);
    try {
      const rows = listCloudConfig(db);
      const target = rows[0];
      const other = rows[1];
      const raw = JSON.parse(String(target.params));
      const otherRaw = JSON.stringify(JSON.parse(String(other.params)));
      const edited = { ...JSON.parse(JSON.stringify(raw)), __applied: true };
      const plan = planSmartpWrites(
        db,
        { [target.config_name]: { meta: { _real: true, source: 'smartp' }, params: edited } },
        { [target.config_name]: raw },
      );
      applySmartpWrites(db, plan.writes);
      const after = Object.fromEntries(listCloudConfig(db).map((r) => [r.config_name, String(r.params)]));
      if (!after[target.config_name].includes('__applied')) throw new Error('edit not written');
      if (after[other.config_name] !== otherRaw) throw new Error('sibling row was rewritten');
      return '1 row changed, sibling byte-identical';
    } finally {
      db.close();
    }
  });

  await check('writes: teg updates the newest revision and inserts a missing module', () => {
    const db = new SQL.Database(tegBytes);
    try {
      const existing = listRules(db)[0];
      const module = String(existing.rule_module);
      const rulesByModule = {
        [module]: [
          { content: { v: 1 }, meta: { _real: true, rule_version: 2 } },
          { content: { v: 3 }, meta: { _real: true, rule_version: 9 } },
        ],
        brand_new_module: [{ content: { hello: 1, version: 7 }, meta: { _real: true, rule_version: 42 } }],
        broken_module: [{ content: {}, meta: { _real: true, broken: true } }],
      };
      const plan = planTegWrites(db, rulesByModule);
      if (plan.updates.length !== 1) throw new Error('updates: ' + plan.updates.length);
      if (plan.updates[0].content !== JSON.stringify({ v: 3 })) throw new Error('picked the wrong revision');
      if (plan.inserts.length !== 1) throw new Error('inserts: ' + plan.inserts.length);
      if (plan.inserts[0].version !== 42) throw new Error('inserted version: ' + plan.inserts[0].version);
      if (plan.skipped.broken_module !== 'broken') throw new Error('broken module not skipped');
      applyTegWrites(db, plan);
      const modules = listRules(db).map((r) => String(r.rule_module));
      if (!modules.includes('brand_new_module')) throw new Error('insert did not land');
      return '1 update, 1 insert, broken skipped';
    } finally {
      db.close();
    }
  });

  await check('writes: a failed mirror insert throws instead of reporting success', () => {
    // SmartP has no `rules` table, so the insert has nowhere to land. The
    // planner cannot produce this plan on its own (it would throw earlier),
    // but applyTegWrites must not swallow a failed insert when it happens.
    const db = new SQL.Database(smartpBytes);
    try {
      try {
        applyTegWrites(db, {
          updates: [],
          inserts: [{ module: 'ghost_module', content: '{"a":1}', version: 1 }],
          skipped: {},
        });
      } catch (err: any) {
        if (!/teg 镜像行写入失败/.test(String(err?.message))) throw new Error('wrong error: ' + err?.message);
        return 'threw: ' + String(err.message).slice(0, 48);
      }
      throw new Error('insert silently succeeded');
    } finally {
      db.close();
    }
  });

  await check('writes: currentRuleRow picks the highest rule_version, not the last row', () => {
    const rows = [
      { content: 'a', meta: { rule_version: 2 } },
      { content: 'b', meta: { rule_version: 9 } },
      { content: 'c', meta: { rule_version: 5 } },
    ];
    const picked = currentRuleRow(rows);
    if (picked?.content !== 'b') throw new Error('picked ' + picked?.content);
    if (currentRuleRow([]) !== null) throw new Error('empty input must be null');
    return 'b (9)';
  });
}

async function runRuleMirrorTest(SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  console.log('\n=== teg mirror row insert ===');
  const sample = SAMPLES.find((s) => s.label.includes('Xiaomi 15'));
  if (!sample) return;
  const bytes = new Uint8Array(readFileSync(path.join(ROOT, sample.teg)));
  await check('rules: a failed insert is reported, not silently zero', () => {
    const empty = new SQL.Database();
    try {
      const r = insertRuleRow(empty, 'common_config', '{}', 1);
      if (r.inserted !== 0) throw new Error('inserted a row into a database with no tables');
      if (!r.error) throw new Error('failure carried no reason');
      return 'reported: ' + r.error.slice(0, 30);
    } finally {
      empty.close();
    }
  });

  await check('rules: insert a mirror row only when the module has none', () => {
    const db = new SQL.Database(bytes);
    try {
      // Drop every common_config row, then insert one as ensureCommonConfigMirror
      // would during a commit.
      db.run(`DELETE FROM rules WHERE rule_module = 'common_config'`);
      if (latestRuleIdForModule(db, 'common_config') !== null) {
        throw new Error('row should be gone');
      }
      const ins = insertRuleRow(db, 'common_config', JSON.stringify({ version: 2024010101, params: { a: 1 } }), 2024010101);
      if (ins.inserted !== 1) throw new Error('insert reported ' + ins.inserted + ': ' + (ins.error ?? ''));
      const id = latestRuleIdForModule(db, 'common_config');
      if (id === null) throw new Error('row not found after insert');
      const rows = listRules(db).filter((r) => r.rule_module === 'common_config');
      if (rows.length !== 1) throw new Error('expected exactly 1 row, got ' + rows.length);
      if (String(rows[0].rule_content).includes('"a":1') === false) throw new Error('content lost');
      return 'inserted 1 row, id=' + id;
    } finally {
      db.close();
    }
  });
  await check('rules: updating by id leaves sibling revisions untouched', () => {
    const db = new SQL.Database(bytes);
    try {
      const before = listRules(db).filter((r) => r.rule_module === 'booster_config');
      if (before.length < 2) return 'skipped (sample has <2 revisions)';
      const id = latestRuleIdForModule(db, 'booster_config');
      if (id === null) throw new Error('no target row');
      updateRuleContentById(db, id, JSON.stringify({ probe: true }));
      const after = listRules(db).filter((r) => r.rule_module === 'booster_config');
      const changed = after.filter((r, i) => String(r.rule_content) !== String(before[i].rule_content));
      if (changed.length !== 1) throw new Error('changed rows: ' + changed.length);
      if (after.length !== before.length) throw new Error('row count drifted');
      return `${before.length} revisions, exactly 1 rewritten`;
    } finally {
      db.close();
    }
  });
}

async function runSourcePickTest() {
  console.log('\n=== booster source pick ===');
  const smart = { meta: { version: 2025090351 }, params: { src: 'smartp', v: 2025090351 } };
  const tegRows = [
    { meta: { rule_version: 483381 }, content: { version: 2025031801, params: { src: 'teg', v: 2025031801 } } },
    { meta: { rule_version: 505464 }, content: { version: 2025041601, params: { src: 'teg', v: 2025041601 } } },
    { meta: { rule_version: 649438 }, content: { version: 2025120301, params: { src: 'teg', v: 2025120301 } } },
  ];
  await check('source: auto picks the higher envelope.version (latest teg row wins)', () => {
    const p = pickBoosterParams(smart, tegRows, 'auto');
    if (!p || p.source !== 'teg') throw new Error('expected teg, got ' + (p && p.source));
    if (p.version !== 2025120301) throw new Error('expected 2025120301, got ' + p.version);
    return 'teg latest envelope.version selected';
  });
  await check('source: smartp pref always keeps smartp', () => {
    const p = pickBoosterParams(smart, tegRows, 'smartp');
    if (!p || p.source !== 'smartp' || p.version !== 2025090351) throw new Error('smartp pref failed');
    return 'smartp forced';
  });
  await check('source: teg pref forces teg even when older', () => {
    const older = [{ meta: { rule_version: 1 }, content: { version: 2023010101, params: { x: 1 } } }];
    const p = pickBoosterParams(smart, older, 'teg');
    if (!p || p.source !== 'teg' || p.version !== 2023010101) throw new Error('teg forced failed');
    return 'teg forced (even when older)';
  });
  await check('source: auto picks smartp when smartp is newer', () => {
    const p = pickBoosterParams({ meta: { version: 2026012351 }, params: { src: 'smartp' } }, tegRows, 'auto');
    if (!p || p.source !== 'smartp') throw new Error('expected smartp, got ' + (p && p.source));
    return 'smartp newer -> smartp';
  });
  await check('source: common_config defaults to smartp', () => {
    if (getCommonSourcePref() !== 'smartp') throw new Error('common default should be smartp');
    return 'common_config source defaults to smartp';
  });
  await check('source: write target defaults to both', () => {
    if (getWriteTarget() !== 'both') throw new Error('write target should default to both');
    return 'write target defaults to both';
  });
  await check('source: teg rows without envelope.version never leak rule_version', () => {
    const rows = [
      { meta: { rule_version: 706918 }, content: { params: { x: 1 } } },
      { meta: { rule_version: 467472 }, content: { params: { y: 2 } } },
    ];
    const v = latestEnvelopeVersion(rows);
    if (v !== 0) throw new Error('rule_version leaked as version: ' + v);
    return 'rule_version isolated (0)';
  });
  await check('source: falls back to smartp when teg has no valid version', () => {
    const s = { meta: { version: 2026042590 }, params: { src: 'smartp' } };
    const rows = [{ meta: { rule_version: 706918 }, content: { params: { x: 1 } } }];
    const p = pickBoosterParams(s, rows, 'auto');
    if (!p || p.source !== 'smartp') throw new Error('expected smartp fallback, got ' + (p && p.source));
    return 'smartp fallback OK';
  });
  await check('source: missing smartp row yields null', () => {
    if (pickBoosterParams(undefined, tegRows, 'auto') !== null) throw new Error('expected null');
    return 'null when SmartP has no row';
  });
}

async function runPrefsTest() {
  console.log('\n=== preference persistence ===');
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
  try {
    await check('prefs: setters are readable back immediately', () => {
      setWriteTarget('teg');
      setCommonSourcePref('teg');
      if (getWriteTarget() !== 'teg') throw new Error('write target not applied');
      if (getCommonSourcePref() !== 'teg') throw new Error('common source not applied');
      return 'teg / teg';
    });

    await check('prefs: value survives clearing the WebView storage', () => {
      // The in-memory cache is what every getter reads, so a wiped
      // localStorage cannot drag the pickers back to the defaults.
      store.clear();
      if (getWriteTarget() !== 'teg') throw new Error('write target lost after storage clear');
      if (getCommonSourcePref() !== 'teg') throw new Error('common source lost after storage clear');
      return 'cache keeps teg / teg';
    });

    await check('prefs: common source accepts the auto (version compare) mode', () => {
      // Regression: the getter only allowed smartp/teg, so selecting "自动"
      // wrote the value and then read it back as SmartP on the next boot.
      setCommonSourcePref('auto');
      if (getCommonSourcePref() !== 'auto') throw new Error('common auto not applied');
      return 'auto';
    });

    await check('prefs: every write also mirrors into localStorage', () => {
      setWriteTarget('smartp');
      if (store.get('joyose-edit.writeTarget') !== 'smartp') {
        throw new Error('localStorage copy missing: ' + JSON.stringify([...store.keys()]));
      }
      return 'mirrored';
    });

    await check('prefs: resetAllPrefs restores the documented defaults', () => {
      resetAllPrefs();
      if (getWriteTarget() !== 'both') throw new Error('write target not reset');
      if (getCommonSourcePref() !== 'smartp') throw new Error('common source not reset');
      if (getBoosterSourcePref() !== 'auto') throw new Error('booster source not reset');
      if (store.size !== 0) throw new Error('localStorage entries left: ' + [...store.keys()].join(','));
      return 'both / smartp / auto';
    });
  } finally {
    delete (globalThis as any).localStorage;
  }
}

// ---------------------------------------------------------------------------
// Import package: untrusted JSON coming from a chat or a forum post.
// The validator has to reject anything that could write outside the declared
// domains, and applyImportPackage has to touch only what the package declared.
// ---------------------------------------------------------------------------

function validPackage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: IMPORT_SCHEMA,
    exported_at: 1763000000,
    source: { backend: 'mifisr', paths: [{ id: 'smartp', active: true, count: 1 }] },
    domains: ['enhance'],
    data: {
      cloudConfig: {
        booster_config: { params: { game_booster: { fisr_config: [{ pkg: 'a' }] } } },
      },
    },
    ...over,
  };
}

function expectReject(obj: unknown, label: string): string {
  const v = validateImportPackage(obj);
  if (v.ok) throw new Error(`${label}: 本应被拒绝，却通过了校验`);
  return v.err;
}

async function runImportPackageTest() {
  console.log('\n=== import package validation ===');

  await check('import: 最小合法包通过', () => {
    const v = validateImportPackage(validPackage());
    if (!v.ok) throw new Error('合法包被拒绝：' + v.err);
    return v.pkg.domains.join(',');
  });

  await check('import: schema 不匹配被拒绝', () => {
    expectReject(validPackage({ schema: 'joyose-edit.export/v0' }), 'schema');
    const err = expectReject(validPackage({ schema: undefined }), 'schema undefined');
    return err.slice(0, 24);
  });

  await check('import: 未知配置域被拒绝', () => {
    expectReject(validPackage({ domains: ['enhance', 'thermal_unlock'] }), 'unknown domain');
    return 'thermal_unlock rejected';
  });

  await check('import: domains 为空或重复被拒绝', () => {
    expectReject(validPackage({ domains: [] }), 'empty domains');
    expectReject(validPackage({ domains: ['enhance', 'enhance'] }), 'duplicate domains');
    return 'empty / duplicate rejected';
  });

  await check('import: 大小上限按 UTF-8 字节而不是字符数', () => {
    // 1.4 M CJK characters: 1.4 M UTF-16 code units, but 4.2 MB on disk. The
    // old `.length` check saw 1.4 M and let the package through; the limit is
    // documented in bytes and the device reads bytes.
    const blob = '中'.repeat(1_400_000);
    const err = expectReject(validPackage({ pad: blob }), 'cjk size');
    if (!/过大/.test(err)) throw new Error('rejected for the wrong reason: ' + err);
    return err.slice(0, 20);
  });

  await check('import: 只有 teg_freeze_hint 的包被拒绝（无可导入内容）', () => {
    expectReject(validPackage({ domains: ['teg_freeze_hint'] }), 'hint only');
    return 'hint-only rejected';
  });

  await check('import: __proto__ / constructor 出现在任意层级都被拒绝', () => {
    const proto = JSON.parse('{"game_booster":{"fisr_config":{"__proto__":{"polluted":1}}}}');
    expectReject(
      validPackage({
        data: { cloudConfig: { booster_config: { params: proto } } },
      }),
      '__proto__ deep',
    );
    const ctor = JSON.parse('{"game_list":[{"constructor":{"x":1}}]}');
    expectReject(
      validPackage({
        domains: ['gamelist'],
        data: { cloudConfig: { common_config: { params: ctor } } },
      }),
      'constructor deep',
    );
    return 'prototype keys rejected';
  });

  await check('import: 预览只比对包内涉及的配置，结果与全量一致', () => {
    const cloud = {
      booster_config: {
        meta: { version: 1 },
        params: {
          game_booster: {
            fisr_config: [{ pkg: 'com.a', enhance_policy_config: [{ feature: 'FI', strategy: 1 }] }],
          },
        },
      },
      common_config: { meta: {}, params: { game_list: ['com.a'] } },
      mivk_config: { meta: {}, params: { on: false } },
    };
    const pkg = validPackage({
      domains: ['enhance'],
      data: {
        cloudConfig: {
          booster_config: {
            params: {
              game_booster: {
                fisr_config: [{ pkg: 'com.b', enhance_policy_config: [{ feature: 'SR', strategy: 2 }] }],
              },
            },
          },
        },
      },
    });

    const full = JSON.parse(JSON.stringify(cloud));
    applyImportPackage(pkg, full);
    const fullDiff = diff(
      snapshotFromMaps({ cloudConfig: cloud, rulesByModule: {} }),
      snapshotFromMaps({ cloudConfig: full, rulesByModule: {} }),
    );

    const keys = Object.keys(pkg.data.cloudConfig);
    const before = pickCloudRowsForPreview(cloud, keys);
    const after = pickCloudRowsForPreview(cloud, keys);
    applyImportPackage(pkg, after);
    const subDiff = diff(
      snapshotFromMaps({ cloudConfig: before, rulesByModule: {} }),
      snapshotFromMaps({ cloudConfig: after, rulesByModule: {} }),
    );

    if (subDiff.length !== fullDiff.length) {
      throw new Error(`子集 diff ${subDiff.length} 条，全量 ${fullDiff.length} 条`);
    }
    const fmt = (rs: typeof subDiff) => rs.map((r) => `${r.kind}:${summarizeRecord(r)}`).join('|');
    if (fmt(subDiff) !== fmt(fullDiff)) throw new Error('子集 diff 与全量不一致');
    if (before.common_config || before.mivk_config) throw new Error('拷贝了无关配置');
    if ((cloud.booster_config.params as any).game_booster.fisr_config[0].pkg !== 'com.a') {
      throw new Error('原始状态被修改');
    }
    return `${subDiff.length} 条，与全量一致，仅拷贝 1 个配置`;
  });

  await check('import: 跨域写入被拒绝（只声明 enhance 却带 mivk_settings）', () => {
    const err = expectReject(
      validPackage({
        domains: ['enhance'],
        data: {
          cloudConfig: {
            booster_config: {
              params: { game_booster: { fisr_config: [], mivk_settings: { on: true } } },
            },
          },
        },
      }),
      'cross domain',
    );
    if (!err.includes('mivk_settings')) throw new Error('错误信息未点名字段：' + err);
    return err.slice(0, 30);
  });

  await check('import: 未声明的配置名被拒绝', () => {
    expectReject(
      validPackage({
        data: { cloudConfig: { thermal_config: { params: {} } } },
      }),
      'unknown config name',
    );
    return 'thermal_config rejected';
  });

  await check('import: common_config 未声明 gamelist 域被拒绝', () => {
    expectReject(
      validPackage({
        domains: ['enhance'],
        data: {
          cloudConfig: {
            booster_config: { params: { game_booster: { fisr_config: [] } } },
            common_config: { params: { game_list: ['a'] } },
          },
        },
      }),
      'common without gamelist',
    );
    return 'common needs gamelist';
  });

  await check('import: params 不是对象 / game_list 不是字符串数组被拒绝', () => {
    expectReject(
      validPackage({ data: { cloudConfig: { booster_config: { params: [] } } } }),
      'params array',
    );
    expectReject(
      validPackage({
        domains: ['gamelist'],
        data: { cloudConfig: { common_config: { params: { game_list: [1, 2] } } } },
      }),
      'game_list numbers',
    );
    return 'shape checks OK';
  });

  await check('import: 超过 4 MB 的包被拒绝', () => {
    const big = 'x'.repeat(4 * 1024 * 1024 + 16);
    const err = expectReject(
      validPackage({
        data: { cloudConfig: { booster_config: { params: { game_booster: { fisr_config: [big] } } } } },
      }),
      'oversize',
    );
    if (!err.includes('过大')) throw new Error('错误信息未说明体积：' + err.slice(0, 40));
    return err.slice(0, 24);
  });

  await check('import: 应用时只写声明域内的键，邻居键保持不变', () => {
    const v = validateImportPackage(
      validPackage({
        data: {
          cloudConfig: {
            booster_config: {
              params: { game_booster: { fisr_config: [{ pkg: 'new' }] } },
            },
          },
        },
      }),
    );
    if (!v.ok) throw new Error(v.err);
    const cc: Record<string, any> = {
      booster_config: {
        meta: { version: 7 },
        params: { game_booster: { fisr_config: [{ pkg: 'old' }], mivk_settings: { keep: 1 }, other: 'x' } },
      },
    };
    applyImportPackage(v.pkg as ImportPackage, cc);
    const gb = cc.booster_config.params.game_booster;
    if (gb.fisr_config[0].pkg !== 'new') throw new Error('声明域未写入');
    if (gb.mivk_settings?.keep !== 1) throw new Error('未声明的邻居键被删除或改写');
    if (gb.other !== 'x') throw new Error('无关键被改写');
    if (cc.booster_config.meta.version !== 7) throw new Error('meta 被覆盖');
    return 'only fisr_config written';
  });

  await check('import: 应用 common_config 时不动 game_booster', () => {
    const v = validateImportPackage(
      validPackage({
        domains: ['gamelist'],
        data: { cloudConfig: { common_config: { params: { game_list: ['com.a'] } } } },
      }),
    );
    if (!v.ok) throw new Error(v.err);
    const cc: Record<string, any> = {
      booster_config: { meta: {}, params: { game_booster: { fisr_config: [] } } },
    };
    applyImportPackage(v.pkg as ImportPackage, cc);
    if (!Array.isArray(cc.common_config.params.game_list)) throw new Error('game_list 未写入');
    if (cc.booster_config.params.game_booster.fisr_config.length !== 0) {
      throw new Error('booster_config 被意外修改');
    }
    return 'gamelist only';
  });

  await check('import: 应用后原始包对象未被修改（预览可复用同一份）', () => {
    const raw = validPackage({
      data: { cloudConfig: { booster_config: { params: { game_booster: { fisr_config: [{ pkg: 'a', n: 1 }] } } } } },
    });
    const v = validateImportPackage(raw);
    if (!v.ok) throw new Error(v.err);
    const before = JSON.stringify(raw);
    const cc: Record<string, any> = {};
    applyImportPackage(v.pkg as ImportPackage, cc);
    cc.booster_config.params.game_booster.fisr_config[0].n = 99;
    if (JSON.stringify(raw) !== before) throw new Error('导入包对象被写入方改动了');
    return 'package stays immutable';
  });
}

// ---- shell helper boundary ------------------------------------------------
// `_json_string` sits between an error message and the JSON the WebView
// parses, and `safe_name` sits between argv and a path. Both are input
// boundaries, so they get a real shell, not a reimplementation in TS.
function shellFunction(name: string): string {
  const src = readFileSync(path.join(ROOT, 'module/bin/joyose-edit.sh'), 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`function ${name} not found in helper`);
  let end = start;
  while (end < lines.length && lines[end] !== '}') end++;
  return lines.slice(start, end + 1).join('\n');
}

function shHasTools(): boolean {
  try {
    execFileSync('sh', ['-c', 'tr --version >/dev/null 2>&1 || true; command -v awk >/dev/null'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function runShellBoundaryTest() {
  console.log('\n=== shell helper boundaries ===');
  if (!shHasTools()) {
    await check('shell: 边界测试跳过（本机没有 sh/awk）', () => 'skipped');
    return;
  }
  const jsonFn = shellFunction('_json_string');
  const safeFn = shellFunction('safe_name');
  const json = (input: string) =>
    execFileSync('sh', ['-c', `${jsonFn}\n_json_string`], { input, encoding: 'utf8' });

  await check('shell: _json_string escapes quotes and backslashes', () => {
    const out = json('he said "hi" \\ bye');
    const parsed = JSON.parse(out);
    if (parsed !== 'he said "hi" \\ bye') throw new Error('round-trip mismatch: ' + out);
    return out;
  });
  await check('shell: _json_string keeps tabs, joins lines with \\n', () => {
    const parsed = JSON.parse(json('a\tb\nc'));
    if (parsed !== 'a\tb\nc') throw new Error('got ' + JSON.stringify(parsed));
    return JSON.stringify(parsed);
  });
  await check('shell: _json_string drops C0 controls instead of emitting bad JSON', () => {
    const raw = 'a\u0001b\u0007c\u001fd';
    const out = json(raw);
    const parsed = JSON.parse(out); // throws on invalid JSON
    if (parsed !== 'abcd') throw new Error('controls not dropped: ' + JSON.stringify(parsed));
    return 'parsed clean';
  });
  await check('shell: _json_string handles empty and very long input', () => {
    if (JSON.parse(json('')) !== '') throw new Error('empty string broken');
    const long = 'x'.repeat(10000);
    if (JSON.parse(json(long)) !== long) throw new Error('long string truncated');
    return '0 / 10000 chars';
  });
  await check('shell: safe_name rejects traversals, globs and control chars', () => {
    const bad = ['', '..', 'a/b', 'a\\b', 'a;b', 'a&b', 'a|b', 'a`b', 'a$b', 'a(b', 'a)b',
      'a<b', 'a>b', 'a*b', 'a?b', 'a[b', 'a]b', 'a\nb', 'a\u0001b'];
    const sh = `${safeFn}\nfor n in "$@"; do if safe_name "$n"; then echo "ACCEPT:$n"; else echo "REJECT:$n"; fi; done`;
    const out = execFileSync('sh', ['-c', sh, 'sh', ...bad], { encoding: 'utf8' });
    const accepted = out.split('\n').filter((l) => l.startsWith('ACCEPT:'));
    if (accepted.length) throw new Error('accepted unsafe names: ' + accepted.join(', '));
    return `${bad.length} rejected`;
  });
  await check('shell: safe_name accepts plain names, dots, dashes and CJK labels', () => {
    const good = ['push-smartp-m1', 'hist.abc123', '2026-11-13_20-00-00', '备份', 'note 1'];
    const sh = `${safeFn}\nfor n in "$@"; do if safe_name "$n"; then echo "ACCEPT:$n"; else echo "REJECT:$n"; fi; done`;
    const out = execFileSync('sh', ['-c', sh, 'sh', ...good], { encoding: 'utf8' });
    const rejected = out.split('\n').filter((l) => l.startsWith('REJECT:'));
    if (rejected.length) throw new Error('rejected valid names: ' + rejected.join(', '));
    return `${good.length} accepted`;
  });
}

// ---- restore planning (C3 / C4) -----------------------------------------
//
// The rollback scenarios from the plan, exercised on the pure decision
// function: replay itself, the file-level floor, digest drift, per-database
// scope, marker records, and a chain that no longer matches the live snapshot.

function snapOf(cc: Record<string, any>, rules: Record<string, any[]> = {}): ConfigSnapshot {
  return { smartp: { cloud_config: cc }, teg: { rules } };
}

function metaOf(recs: HistoryRecord[]): HistoryFileMeta[] {
  return recs
    .slice()
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({ name: `${r.timestamp}-${r.seq}.json`, timestamp: r.timestamp, seq: r.seq }));
}

async function runRestorePlanTest() {
  console.log('\n=== restore plan ===');

  const s0 = snapOf({ booster_config: { fps: 60 } });
  const s1 = snapOf({ booster_config: { fps: 90 } });
  const s2 = snapOf({ booster_config: { fps: 120 } });
  const r1 = buildRecord({ seq: 1, timestamp: 1, delta: diff(s0, s1) });
  const r2 = buildRecord({ seq: 2, timestamp: 2, delta: diff(s1, s2) });
  const fps = (s: ConfigSnapshot) => (s.smartp.cloud_config.booster_config as any).fps;
  const same = (a: string | null, b: string | null) => ({ smartp: a, teg: b });

  await check('restore: 连续提交后回到中间那条', () => {
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([r1, r2]),
      newerRecords: [r2],
      targetRecord: r1,
      anchorDigest: same('aa', null),
      nowDigest: same('aa', null),
      current: s2,
    });
    if (!out.ok) throw new Error('refused: ' + out.message);
    if (fps(out.snapshot) !== 90) throw new Error('expected 90, got ' + fps(out.snapshot));
    return 'seq 2 undone, fps=90';
  });

  await check('restore: 三条记录一次退回第一条', () => {
    const s3 = snapOf({ booster_config: { fps: 144 } });
    const r3 = buildRecord({ seq: 3, timestamp: 3, delta: diff(s2, s3) });
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([r1, r2, r3]),
      newerRecords: [r3, r2],
      targetRecord: r1,
      anchorDigest: same('aa', null),
      nowDigest: same('aa', null),
      current: s3,
    });
    if (!out.ok) throw new Error('refused: ' + out.message);
    if (fps(out.snapshot) !== 90) throw new Error('expected 90, got ' + fps(out.snapshot));
    return 'two deltas undone, fps=90';
  });

  await check('restore: 撤销 teg 提交时保留前一条的 SmartP 改动', () => {
    // seq 1 edits SmartP, seq 2 edits teg. Rolling back to seq 1 must undo the
    // teg edit and KEEP the SmartP edit from seq 1 — not rewind both.
    const c0 = snapOf({ x: 1 }, { booster_config: [{ v: 1 }] });
    const c1 = snapOf({ x: 2 }, { booster_config: [{ v: 1 }] });
    const c2 = snapOf({ x: 2 }, { booster_config: [{ v: 2 }] });
    const rc1 = buildRecord({ seq: 1, timestamp: 1, delta: diff(c0, c1) });
    const rc2 = buildRecord({ seq: 2, timestamp: 2, delta: diff(c1, c2) });
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([rc1, rc2]),
      newerRecords: [rc2],
      targetRecord: rc1,
      anchorDigest: null,
      nowDigest: null,
      current: c2,
    });
    if (!out.ok) throw new Error('refused: ' + out.message);
    if ((out.snapshot.smartp.cloud_config as any).x !== 2) throw new Error('SmartP edit was lost');
    if ((out.snapshot.teg.rules as any).booster_config[0].v !== 1) throw new Error('teg not undone');
    return 'SmartP kept, teg reverted';
  });

  await check('restore: 撤销 SmartP 提交时保留前一条的 teg 改动', () => {
    const d0 = snapOf({ y: 1 }, { booster_config: [{ v: 9 }] });
    const d1 = snapOf({ y: 1 }, { booster_config: [{ v: 8 }] });
    const d2 = snapOf({ y: 2 }, { booster_config: [{ v: 8 }] });
    const rd1 = buildRecord({ seq: 1, timestamp: 1, delta: diff(d0, d1) });
    const rd2 = buildRecord({ seq: 2, timestamp: 2, delta: diff(d1, d2) });
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([rd1, rd2]),
      newerRecords: [rd2],
      targetRecord: rd1,
      anchorDigest: null,
      nowDigest: null,
      current: d2,
    });
    if (!out.ok) throw new Error('refused: ' + out.message);
    if ((out.snapshot.teg.rules as any).booster_config[0].v !== 8) throw new Error('teg edit was lost');
    if ((out.snapshot.smartp.cloud_config as any).y !== 1) throw new Error('SmartP not undone');
    return 'teg kept, SmartP reverted';
  });

  await check('restore: 文件级回滚之后的旧记录被拒绝', () => {
    const out = planRestore({
      targetSeq: 3,
      floor: 5,
      meta: metaOf([r1, r2]),
      newerRecords: [r2],
      targetRecord: r1,
      anchorDigest: null,
      nowDigest: null,
      current: s2,
    });
    if (out.ok) throw new Error('accepted a record below the floor');
    if (out.code !== 'floor') throw new Error('wrong code: ' + out.code);
    return 'floor=5 refuses seq=3';
  });

  await check('restore: 云端在提交后改过库 → 拒绝', () => {
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([r1, r2]),
      newerRecords: [r2],
      targetRecord: r1,
      anchorDigest: same('aa', 'bb'),
      nowDigest: same('zz', 'bb'),
      current: s2,
    });
    if (out.ok) throw new Error('replayed onto a moved base');
    if (out.code !== 'drift') throw new Error('wrong code: ' + out.code);
    if (!out.message.includes('SmartP.db')) throw new Error('did not name the drifted file');
    return 'SmartP.db drift refused';
  });

  await check('restore: 摘要读不到时拒绝，而不是当作没漂移', () => {
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([r1, r2]),
      newerRecords: [r2],
      targetRecord: r1,
      anchorDigest: same('aa', 'bb'),
      nowDigest: null,
      current: s2,
    });
    if (out.ok) throw new Error('replayed onto an unverifiable base');
    if (out.code !== 'unknown') throw new Error('wrong code: ' + out.code);
    return 'unknown digest refused';
  });

  await check('restore: 旧记录没有摘要时仍然允许回滚', () => {
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([r1, r2]),
      newerRecords: [r2],
      targetRecord: r1,
      anchorDigest: null,
      nowDigest: null,
      current: s2,
    });
    if (!out.ok) throw new Error('legacy history blocked: ' + out.message);
    return 'no anchor, no block';
  });

  await check('restore: 只有 teg 漂移时只报 teg', () => {
    const drift = digestDrift(same('aa', 'bb'), same('aa', 'cc'));
    if (drift.join() !== 'teg_config.db') throw new Error('wrong drift set: ' + drift.join());
    return 'teg only';
  });

  await check('restore: 备份锚点不是回滚目标', () => {
    const marker = buildRecord({ seq: 9, timestamp: 9, source: 'backup', note: 'b1', delta: [] });
    if (marker.canRevert !== false) throw new Error('marker is marked revertible');
    const out = planRestore({
      targetSeq: 9,
      floor: 0,
      meta: metaOf([marker]),
      newerRecords: [],
      targetRecord: marker,
      anchorDigest: null,
      nowDigest: null,
      current: s0,
    });
    if (out.ok) throw new Error('accepted an empty marker');
    if (out.code !== 'no-delta') throw new Error('wrong code: ' + out.code);
    return 'marker refused';
  });

  await check('restore: 路径在当前快照里不存在时整体拒绝', () => {
    // seq 2's delta points into `gone`, a row that was removed afterwards
    // (cloud clear / manual reset). Rolling back to seq 1 must replay that
    // delta, find no parent to land on, and stop instead of writing a partial
    // state.
    const target = buildRecord({ seq: 1, timestamp: 1, delta: diff(s0, s1) });
    const bad = buildRecord({
      seq: 2,
      timestamp: 2,
      delta: [{ path: ['smartp', 'cloud_config', 'gone', 'deep'], kind: 'added', after: 1 }],
    });
    const out = planRestore({
      targetSeq: 1,
      floor: 0,
      meta: metaOf([target, bad]),
      newerRecords: [bad],
      targetRecord: target,
      anchorDigest: null,
      nowDigest: null,
      current: snapOf({}),
    });
    if (out.ok) throw new Error('replayed into a missing parent');
    if (out.code !== 'replay') throw new Error('wrong code: ' + out.code);
    return 'missing path refused';
  });

  await check('history: 记录带 dbKind / 前后摘要 / canRevert', () => {
    const rec = buildRecord({
      seq: 7,
      timestamp: 7,
      delta: diff(s0, s1),
      dbKind: 'both',
      beforeDigest: same('11', '22'),
      afterDigest: same('33', '44'),
    });
    const back = JSON.parse(JSON.stringify(rec)) as HistoryRecord;
    if (back.dbKind !== 'both') throw new Error('dbKind lost');
    if (back.beforeDigest?.smartp !== '11' || back.afterDigest?.teg !== '44') throw new Error('digest lost');
    if (back.canRevert !== true) throw new Error('revertible record marked otherwise');
    return 'both / 11→33 / 22→44';
  });

  await check('history: 旧记录没有新字段仍可回滚', () => {
    // A record written before v1.2.0: no dbKind, no digests, no canRevert.
    // Rolling back TO it must not be blocked by the missing fields.
    const legacy: HistoryRecord = {
      version: 2,
      seq: 4,
      timestamp: 4,
      source: 'webui',
      note: '',
      delta: diff(s0, s1),
    };
    const newer = buildRecord({ seq: 5, timestamp: 5, delta: diff(s1, s2) });
    const out = planRestore({
      targetSeq: 4,
      floor: 0,
      meta: metaOf([legacy, newer]),
      newerRecords: [newer],
      targetRecord: legacy,
      anchorDigest: null,
      nowDigest: null,
      current: s2,
    });
    if (!out.ok) throw new Error('legacy record refused: ' + out.message);
    if (fps(out.snapshot) !== 90) throw new Error('expected 90, got ' + fps(out.snapshot));
    return 'v2 record replayed onto by a newer record';
  });
}

// ---- unified operation result (F3) --------------------------------------
//
// Every mutating action now returns one shape. The interesting part is the
// ordering of the commit codes: two things can go wrong at once, and the
// user must be told the one they can act on.

async function runOperationResultTest() {
  console.log('\n=== operation result ===');

  const base = {
    stopConfirmed: true,
    restartAttempted: true,
    startedAfter: true,
    rebased: false,
  };

  await check('result: 提交成功走 written', () => {
    if (commitCode(base) !== 'written') throw new Error('not written: ' + commitCode(base));
    return 'written';
  });

  await check('result: 合并过云端更新时先说 rebased', () => {
    if (commitCode({ ...base, rebased: true }) !== 'written-rebased') throw new Error('rebased lost');
    return 'written-rebased';
  });

  await check('result: Joyose 没停住时优先报 stop-failed', () => {
    const code = commitCode({ ...base, stopConfirmed: false });
    if (code !== 'written-stop-failed') throw new Error('got ' + code);
    // Rebased is a lesser fact: it must not mask a Joyose still holding the
    // old config.
    const both = commitCode({ ...base, stopConfirmed: false, rebased: true });
    if (both !== 'written-stop-failed') throw new Error('rebased masked stop failure: ' + both);
    return 'stop-failed wins over rebased';
  });

  await check('result: 重启失败/历史失败优先于其它一切', () => {
    if (commitCode({ ...base, restartError: 'x' }) !== 'written-restart-failed') throw new Error('restart');
    if (commitCode({ ...base, historyError: 'y' }) !== 'written-no-history') throw new Error('history');
    const both = commitCode({ ...base, historyError: 'y', restartError: 'x' });
    if (both !== 'written-no-history') throw new Error('history must outrank restart: ' + both);
    return 'no-history > restart-failed > stop-failed';
  });

  await check('result: 重启未确认与已停住分开表示', () => {
    if (commitCode({ ...base, startedAfter: false }) !== 'written-stopped') throw new Error('stopped');
    if (commitCode({ ...base, startedAfter: null }) !== 'written-reload-unconfirmed') throw new Error('unconfirmed');
    // No restart attempted: do not claim it is stopped either.
    if (commitCode({ ...base, restartAttempted: false, startedAfter: null }) !== 'written') throw new Error('no-restart');
    return 'stopped / unconfirmed / plain';
  });

  await check('result: 默认字段不撒谎', () => {
    const r = makeResult({ code: 'backed-up' });
    if (!r.ok) throw new Error('backup not ok');
    if (r.databaseChanged) throw new Error('backup claimed a DB change');
    if (r.joyoseStopped !== null) throw new Error('backup invented a process state');
    if (r.joyoseRestarted !== null) throw new Error('backup invented a restart');
    if (!r.message) throw new Error('empty message');
    return 'nulls, not false';
  });

  await check('result: 只有 failed 不是 ok', () => {
    const codes = [
      'written', 'written-rebased', 'written-reload-unconfirmed', 'written-stop-failed',
      'written-restart-failed', 'written-stopped', 'written-no-history', 'no-change',
      'out-of-scope', 'backed-up', 'reverted', 'reset', 'frozen', 'unfrozen',
    ] as const;
    for (const c of codes) {
      if (!makeResult({ code: c }).ok) throw new Error(c + ' should be ok');
      if (!defaultMessage(c)) throw new Error(c + ' has no message');
    }
    if (makeResult({ code: 'failed' }).ok) throw new Error('failed should not be ok');
    return '14 codes ok, failed is not';
  });
}

// ---- helper failure injection (G2) --------------------------------------
//
// The helper's failure paths — stop refused, backup failed, candidate corrupt,
// swap failed, disk full — used to be reachable only on a phone with a broken
// ROM. They run here against the real script: the dispatch block is cut off,
// the paths point at a temp dir, and fake pidof/am/cp/mv stand in for Android's.
// Every case asserts the live database is byte-identical afterwards, because
// "it printed an error" is not the property we care about.

interface HelperHarness {
  dir: string;
  dbDir: string;
  dataDir: string;
  fake: string;
  bin: string;
  /** Set when the test needs a PATH the helper cannot escape. */
  sysbin?: string;
}

function touchState(h: HelperHarness, name: string) {
  writeFileSync(path.join(h.fake, name), '');
}

function shaOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeFakeTools(bin: string, fake: string) {
  const tools: Record<string, string> = {
    // exit 0 while $FAKE/alive exists — "the process is running".
    pidof: `#!/bin/sh\n[ -f "$FAKE/alive" ] && { echo 4242; exit 0; }\nexit 1\n`,
    am: `#!/bin/sh
echo "am $*" >> "$FAKE/am.log"
case "$1" in
  force-stop)
    [ -f "$FAKE/stop-fails" ] && exit 0
    rm -f "$FAKE/alive"; exit 0 ;;
  start)
    [ -f "$FAKE/start-fails" ] && exit 1
    : > "$FAKE/alive"; exit 0 ;;
esac
exit 0
`,
    cp: `#!/bin/sh
if [ -f "$FAKE/cp-fails" ]; then printf 'cp: write error: No space left on device\\n' >&2; exit 1; fi
# Reports success but writes a short file — the shape of a copy that ran out of
# space on a filesystem that does not fail the write. Only used for rollback
# copies so the staging copy stays intact.
if [ -f "$FAKE/cp-truncates" ]; then
  for last; do :; done
  src=''
  for a in "$@"; do case "$a" in -*) ;; *) src="$a"; break ;; esac; done
  case "$last" in
    *.jedit.rb.*) /usr/bin/head -c 4096 "$src" > "$last"; exit 0 ;;
  esac
fi
exec /usr/bin/cp "$@"
`,
    mv: `#!/bin/sh
if [ -f "$FAKE/mv-fails" ]; then
  for last; do :; done
  case "$last" in
    *SmartP.db|*teg_config.db) printf 'mv: cannot replace %s\\n' "$last" >&2; exit 1 ;;
  esac
fi
# Fails only on teg, so the pair path can be tested with the first swap landing.
if [ -f "$FAKE/mv-fails-teg" ]; then
  for last; do :; done
  case "$last" in *teg_config.db) printf 'mv: cannot replace %s\\n' "$last" >&2; exit 1 ;; esac
fi
# Kills the helper between the two renames: the one failure no error handling
# inside the process can undo, so it is the only honest way to prove the
# crash-recovery record works.
if [ -f "$FAKE/mv-kills-on-teg" ]; then
  for last; do :; done
  case "$last" in
    *teg_config.db) kill -9 "$PPID" 2>/dev/null; sleep 1; exit 1 ;;
  esac
fi
exec /usr/bin/mv "$@"
`,
    // Prints 0 by default. A ROM where the relabel fails is the branch that
    // `restorecon ... || true` used to hide.
    restorecon: `#!/bin/sh
[ -f "$FAKE/restorecon-fails" ] && exit 1
exit 0
`,
  };
  for (const [name, body] of Object.entries(tools)) {
    const f = path.join(bin, name);
    writeFileSync(f, body);
    chmodSync(f, 0o755);
  }
  writeFileSync(path.join(bin, '.fake-dir'), fake);
}

function newHarness(
  opts: { sqlite3?: 'corrupt' | 'absent' | 'ok'; without?: string[] } = {},
): HelperHarness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'joyose-helper-'));
  const dbDir = path.join(dir, 'db');
  const dataDir = path.join(dir, 'data');
  const fake = path.join(dir, 'state');
  const bin = path.join(dir, 'bin');
  for (const d of [dbDir, dataDir, fake, bin]) mkdirSync(d, { recursive: true });
  // Two different, both valid sample databases: "same bytes" and "different
  // bytes" have to be distinguishable for the assertions below.
  writeFileSync(path.join(dbDir, 'SmartP.db'), readFileSync(path.join(ROOT, 'tests/Xiaomi 15/SmartP.db')));
  writeFileSync(path.join(dbDir, 'new.db'), readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/SmartP.db')));
  writeFakeTools(bin, fake);
  // A ROM is defined by which tools it lacks. Excluding a tool means rebuilding
  // PATH out of symlinks to everything else, because the binary normally lives
  // next to sh/cp/mv, which the helper needs.
  const exclude = [
    ...(opts.sqlite3 === 'absent' ? ['sqlite3'] : []),
    ...(opts.without ?? []),
  ];
  const sysbin = exclude.length
    ? mirrorPathWithout(path.join(dir, 'sysbin'), exclude)
    : undefined;
  if (opts.sqlite3 === 'corrupt') {
    // A ROM that has sqlite3, and a file whose PRAGMA quick_check fails even
    // though the 16-byte header is intact.
    const f = path.join(bin, 'sqlite3');
    writeFileSync(f, '#!/bin/sh\nprintf "corruption\\n"\n');
    chmodSync(f, 0o755);
  } else if (opts.sqlite3 === 'ok') {
    // A ROM whose sqlite3 is fine. Answering by SQL keeps the stub honest:
    // quick_check says ok, the table count query succeeds.
    const f = path.join(bin, 'sqlite3');
    writeFileSync(f, `#!/bin/sh
case "$2" in
  *quick_check*) printf 'ok\\n' ;;
  *sqlite_master*) printf '3\\n' ;;
  *) printf 'ok\\n' ;;
esac
exit 0
`);
    chmodSync(f, 0o755);
  }
  return { dir, dbDir, dataDir, fake, bin, sysbin };
}

/** Recreate the real PATH as one directory of symlinks, minus `exclude`.
 *
 *  Used to prove a "tool is not installed" branch on a machine where the tool
 *  is installed. Filtering PATH string-wise cannot work — the binary usually
 *  lives in /usr/bin next to sh, cp and mv, which the helper needs.
 */
function mirrorPathWithout(dir: string, exclude: string[]): string {
  mkdirSync(dir, { recursive: true });
  const skip = new Set(exclude);
  const done = new Set<string>();
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (!entry) continue;
    let names: string[];
    try {
      names = readdirSync(entry);
    } catch {
      continue;
    }
    for (const name of names) {
      if (skip.has(name) || done.has(name)) continue;
      const target = path.join(entry, name);
      try {
        if (!statSync(target).isFile()) continue;
      } catch {
        continue;
      }
      try {
        symlinkSync(target, path.join(dir, name));
        done.add(name);
      } catch {
        /* a later PATH entry already provided this name */
      }
    }
  }
  return dir;
}

function harnessScript(h: HelperHarness, driver: string): string {
  const src = readFileSync(path.join(ROOT, 'module/bin/joyose-edit.sh'), 'utf8');
  const cut = src.indexOf('# ---- dispatch');
  if (cut < 0) throw new Error('# ---- dispatch not found in helper');
  const body = src
    .slice(0, cut)
    .replace(/^DATA_ROOT=.*$/m, `DATA_ROOT=${h.dataDir}`)
    .replace(/^DB_DIR=.*$/m, `DB_DIR=${h.dbDir}`);
  return [
    '#!/bin/sh',
    body,
    `DB=${h.dbDir}`,
    h.sysbin ? `export PATH="${h.bin}:${h.sysbin}"` : `export PATH="${h.bin}:$PATH"`,
    `export FAKE="${h.fake}"`,
    'set +e',
    driver,
  ].join('\n');
}

function runHarness(h: HelperHarness, driver: string, env: Record<string, string> = {}) {
  const file = path.join(h.dir, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, harnessScript(h, driver));
  const r = spawnSync('sh', [file], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ...env,
      ...(h.sysbin ? { PATH: `${h.bin}:${h.sysbin}` } : {}),
      FAKE: h.fake,
    },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function cleanupHarness(h: HelperHarness) {
  try {
    rmSync(h.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function jettison(h: HelperHarness): string[] {
  return readdirSync(h.dbDir).filter((f) => f.includes('.jedit.'));
}

async function runHelperFailureTest() {
  console.log('\n=== helper failure injection ===');
  if (!shHasTools()) {
    await check('helper: 故障注入跳过（本机没有 sh）', () => 'skipped');
    return;
  }

  // Push `new.db` over `SmartP.db`, report the helper's exit code.
  const push = `B64=$(base64 -w0 "$DB/new.db")
( cmd_push smartp "$B64" "$(stat -c %s "$DB/new.db")" "" )
echo "EXIT=$?"`;

  await check('helper: Joyose 停不下来时拒绝替换数据库', () => {
    const h = newHarness();
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    touchState(h, 'alive');
    touchState(h, 'stop-fails');
    const r = runHarness(h, push);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    const left = jettison(h);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('push did not fail: ' + r.out);
    if (!same) throw new Error('database changed despite a failed stop');
    if (!/still running/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    if (left.length) throw new Error('left temp files: ' + left.join(','));
    return 'refused, db untouched';
  });

  await check('helper: 备份失败时数据库不变且目录不残留', () => {
    const h = newHarness();
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    touchState(h, 'alive');
    touchState(h, 'cp-fails');
    const r = runHarness(h, `( cmd_backup test )\necho "EXIT=$?"`);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    const backups = readdirSync(path.join(h.dataDir, 'backup'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('backup did not fail');
    if (!same) throw new Error('database changed');
    if (backups.length) throw new Error('partial backup left behind: ' + backups.join(','));
    if (!/disk full/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    return 'no partial dir, db untouched';
  });

  await check('helper: 截断的候选库被拒（头正确不足以为证）', () => {
    // A real sqlite3 would also reject this, but the property under test is
    // the helper's own geometry check — the one that has to work when the ROM
    // ships no sqlite3. Force that branch so the assertion means what it says.
    const h = newHarness({ sqlite3: 'absent' });
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    const r = runHarness(h, `head -c 4096 "$DB/new.db" > "$DB/trunc.db"
B64=$(base64 -w0 "$DB/trunc.db")
( cmd_push smartp "$B64" "$(stat -c %s "$DB/trunc.db")" "" )
echo "EXIT=$?"`);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('truncated db accepted');
    if (!same) throw new Error('database replaced by a truncated file');
    if (!/integrity/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    return 'rejected before the swap';
  });

  await check('helper: quick_check 报损坏时拒绝写入', () => {
    const h = newHarness({ sqlite3: 'corrupt' });
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    const r = runHarness(h, push);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('corrupt db accepted');
    if (!same) throw new Error('database replaced');
    return 'sqlite3 says corruption -> refused';
  });

  await check('helper: 没有 sqlite3 时好库仍然可写（geometry 校验）', () => {
    const h = newHarness({ sqlite3: 'absent' });
    // Assert the setup, not just the outcome: if PATH still resolves sqlite3
    // the helper silently takes the other branch and this test proves nothing.
    const probe = spawnSync('sh', ['-c', 'command -v sqlite3'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${h.bin}:${h.sysbin}` },
    });
    if (probe.status === 0) {
      cleanupHarness(h);
      throw new Error('harness still resolves sqlite3 at ' + probe.stdout.trim());
    }
    const expected = shaOf(path.join(h.dbDir, 'new.db'));
    const r = runHarness(h, push);
    const after = shaOf(path.join(h.dbDir, 'SmartP.db'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write refused: ' + r.err.slice(0, 200));
    if (!r.out.includes('"verified":"geometry"')) throw new Error('did not report the fallback');
    if (after !== expected) throw new Error('bytes on disk are not the ones we sent');
    return 'geometry fallback, exact bytes';
  });
  await check('helper: 有 sqlite3 且 quick_check 通过时走完整校验', () => {
    const h = newHarness({ sqlite3: 'ok' });
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    const r = runHarness(h, push);
    const after = shaOf(path.join(h.dbDir, 'SmartP.db'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write refused: ' + r.err.slice(0, 200));
    if (!r.out.includes('"verified":"sqlite3"')) throw new Error('did not use the real check');
    if (after === before) throw new Error('database was not written');
    return 'quick_check path, written';
  });
  await check('helper: 文件级恢复保留原库的属主与权限', () => {
    // The restored bytes are useless if the file ends up owned by root:root or
    // with a mode Joyose cannot open. The staging copy is created by us, so
    // without an explicit chown/chmod the attributes silently change.
    const h = newHarness();
    const live = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    writeFileSync(teg, readFileSync(path.join(ROOT, 'tests/Xiaomi 15/teg_config.db')));
    // chown needs root. On a CI runner running as a normal user the ownership
    // half cannot be exercised; the mode half still can, and both go through
    // the same helper.
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      chownSync(live, 1000, 1000);
      chownSync(teg, 1000, 1000);
    }
    chmodSync(live, 0o640);
    chmodSync(teg, 0o600);

    const b = runHarness(h, '( cmd_backup test )');
    const line = b.out.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}';
    const dir = JSON.parse(line).dir as string | undefined;
    if (!dir) throw new Error('backup did not report a directory: ' + b.out.slice(0, 200));

    // Pretend Joyose rewrote the database after the backup.
    writeFileSync(live, 'changed');

    const r = runHarness(h, `( cmd_revert ${path.basename(dir)} )\necho "EXIT=$?"`);
    const stLive = statSync(live);
    const stTeg = statSync(teg);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('revert failed: ' + r.out.slice(0, 300) + r.err.slice(0, 300));
    if ((stLive.mode & 0o777) !== 0o640) {
      throw new Error('SmartP mode changed: ' + (stLive.mode & 0o777).toString(8));
    }
    if ((stTeg.mode & 0o777) !== 0o600) {
      throw new Error('teg mode changed: ' + (stTeg.mode & 0o777).toString(8));
    }
    if (isRoot && (stLive.uid !== 1000 || stLive.gid !== 1000)) {
      throw new Error(`SmartP owner changed: ${stLive.uid}:${stLive.gid}`);
    }
    if (isRoot && (stTeg.uid !== 1000 || stTeg.gid !== 1000)) {
      throw new Error(`teg owner changed: ${stTeg.uid}:${stTeg.gid}`);
    }
    return isRoot ? 'uid/gid + mode preserved' : 'mode preserved (not root)';
  });

  await check('helper: 没有 sha256 时截断的回滚副本按大小拦下', () => {
    // No digest tool means the only remaining guard is size. Skipping it (the
    // old behaviour) accepted a 4 KB rollback copy as a valid restore point.
    const h = newHarness({ without: ['sha256sum'] });
    const live = path.join(h.dbDir, 'SmartP.db');
    const before = shaOf(live);
    const b = runHarness(h, '( cmd_backup test )');
    const line = b.out.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}';
    const dir = JSON.parse(line).dir as string | undefined;
    if (!dir) throw new Error('backup did not report a directory');
    touchState(h, 'cp-truncates');
    const r = runHarness(h, `( cmd_revert ${path.basename(dir)} )\necho "EXIT=$?"`);
    const same = shaOf(live) === before;
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) {
      throw new Error('truncated rollback copy was accepted: ' + r.out.slice(0, 300) + r.err.slice(0, 300));
    }
    if (!same) throw new Error('live database changed despite the abort');
    if (!/incomplete/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    return 'size mismatch refused';
  });

  await check('helper: 双库写入有一库失败时两库都回到原样', () => {
    // The failure this whole mechanism exists for: SmartP swaps fine, teg does
    // not. Two independent pushes would leave SmartP new and teg old while the
    // user is told the commit failed.
    const h = newHarness();
    const sp = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    writeFileSync(teg, readFileSync(path.join(ROOT, 'tests/Xiaomi 15/teg_config.db')));
    const beforeSp = shaOf(sp);
    const beforeTeg = shaOf(teg);
    const stageDir = path.join(h.dataDir, 'stage');
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(
      path.join(stageDir, 'sp'),
      readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/SmartP.db')).toString('base64'),
    );
    writeFileSync(
      path.join(stageDir, 'teg'),
      readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/teg_config.db')).toString('base64'),
    );
    touchState(h, 'mv-fails-teg');
    const r = runHarness(
      h,
      `( cmd_push_pair_from_stage sp teg "" "" "" "" "" "" )\necho "EXIT=$?"`,
    );
    const afterSp = shaOf(sp);
    const afterTeg = shaOf(teg);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('pair write "succeeded": ' + r.out.slice(0, 300));
    if (afterSp !== beforeSp) throw new Error('SmartP stayed on the new bytes (half commit)');
    if (afterTeg !== beforeTeg) throw new Error('teg changed');
    if (!/restore failed on teg/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 300));
    return 'both databases back to their previous contents';
  });

  await check('helper: 双库写入成功时两库同时是新的', () => {
    const h = newHarness();
    const sp = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    writeFileSync(teg, readFileSync(path.join(ROOT, 'tests/Xiaomi 15/teg_config.db')));
    const stageDir = path.join(h.dataDir, 'stage');
    mkdirSync(stageDir, { recursive: true });
    const newSp = readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/SmartP.db'));
    const newTeg = readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/teg_config.db'));
    writeFileSync(path.join(stageDir, 'sp'), newSp.toString('base64'));
    writeFileSync(path.join(stageDir, 'teg'), newTeg.toString('base64'));
    const r = runHarness(
      h,
      `( cmd_push_pair_from_stage sp teg "" "" "" "" "" "" )\necho "EXIT=$?"`,
    );
    const gotSp = readFileSync(sp);
    const gotTeg = readFileSync(teg);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('pair write failed: ' + r.out.slice(0, 300) + r.err.slice(0, 300));
    if (!gotSp.equals(newSp)) throw new Error('SmartP is not the candidate');
    if (!gotTeg.equals(newTeg)) throw new Error('teg is not the candidate');
    if (!r.out.includes('"atomic":true')) throw new Error('did not report the transaction');
    return 'both databases on the new bytes';
  });

  await check('helper: 替换失败时原库保持且不留副本', () => {
    const h = newHarness();
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    touchState(h, 'mv-fails');
    const r = runHarness(h, push);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    const left = jettison(h);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('swap "succeeded"');
    if (!same) throw new Error('database changed');
    if (left.length) throw new Error('redundant rollback copy left: ' + left.join(','));
    if (!/cannot replace/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    return 'original kept, no leftovers';
  });

  await check('helper: 磁盘满（回滚副本创建失败）时中止并恢复进程', () => {
    const h = newHarness();
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    touchState(h, 'alive');
    touchState(h, 'cp-fails');
    const r = runHarness(h, push);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    const log = readFileSync(path.join(h.fake, 'am.log'), 'utf8');
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('write continued without a restore point');
    if (!same) throw new Error('database changed');
    if (!/rollback copy/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    if (!/start /.test(log)) throw new Error('Joyose was not restarted after the abort');
    return 'aborted, process restored';
  });

  await check('helper: 临时文件写入失败（坏 base64）不碰数据库', () => {
    const h = newHarness();
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    const r = runHarness(h, `( cmd_push smartp "!!!not-base64!!!" "" )\necho "EXIT=$?"`);
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('bad payload accepted');
    if (!same) throw new Error('database changed');
    return 'decode failure, db untouched';
  });

  await check('helper: 重启失败单独报告，不冒充写入失败', () => {
    const h = newHarness();
    touchState(h, 'alive');
    touchState(h, 'start-fails');
    const r = runHarness(h, `${push}
( cmd_restart )
echo "RESTART=$?"`);
    const after = shaOf(path.join(h.dbDir, 'SmartP.db'));
    const expected = shaOf(path.join(h.dbDir, 'new.db'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write itself failed: ' + r.err.slice(0, 200));
    if (after !== expected) throw new Error('bytes were not written');
    if (!/"started":false/.test(r.out)) throw new Error('restart failure not reported: ' + r.out.slice(-200));
    return 'write ok, started=false';
  });

  await check('helper: 刚建好但还没写 owner 的锁不会被抢走', () => {
    // The window between `mkdir` and writing `owner` is a few microseconds.
    // A waiter that treats an owner-less directory as dead moves it away while
    // the first writer is still initialising — both then believe they hold it.
    const h = newHarness();
    const r = runHarness(
      h,
      `mkdir -p "$LOCK_DIR"
( _acquire_lock push && echo "GOT_LOCK" )
echo "EXIT=$?"`,
      { LOCK_WAIT_TICKS: '3' },
    );
    cleanupHarness(h);
    if (r.out.includes('GOT_LOCK')) throw new Error('stole a lock that was still initialising');
    if (!r.out.includes('EXIT=1')) throw new Error('acquire did not fail: ' + r.out);
    if (!/device is busy/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    return 'waited instead of stealing';
  });

  await check('helper: 确实死掉的锁（无 owner 且很旧）可以接管', () => {
    const h = newHarness();
    const r = runHarness(
      h,
      `mkdir -p "$LOCK_DIR"
touch -d "@$(( $(date +%s) - 10 ))" "$LOCK_DIR"
( _acquire_lock push && echo "GOT_LOCK" )
echo "EXIT=$?"`,
      { LOCK_WAIT_TICKS: '5' },
    );
    cleanupHarness(h);
    if (!r.out.includes('GOT_LOCK')) throw new Error('a stale lock was never reclaimed: ' + r.out + r.err.slice(0, 200));
    return 'stale lock reclaimed';
  });

  await check('helper: 并发写入被设备锁挡住', () => {
    const h = newHarness();
    const before = shaOf(path.join(h.dbDir, 'SmartP.db'));
    // The harness calls cmd_push directly, so the lock has to be asked for
    // explicitly — the dispatch block that normally does it is cut off.
    const r = runHarness(
      h,
      `mkdir -p "$LOCK_DIR"
printf '%s %s %s %s %s\\n' "$$" "$(date +%s)" "$(_proc_start "$$")" "held" "push" > "$LOCK_DIR/owner"
( _acquire_lock push && echo "GOT_LOCK" )
echo "EXIT=$?"`,
      { LOCK_WAIT_TICKS: '3' },
    );
    const same = shaOf(path.join(h.dbDir, 'SmartP.db')) === before;
    cleanupHarness(h);
    if (r.out.includes('GOT_LOCK')) throw new Error('second writer entered the critical section');
    if (!r.out.includes('EXIT=1')) throw new Error('acquire did not fail: ' + r.out);
    if (!same) throw new Error('database changed under a held lock');
    if (!/device is busy/.test(r.err)) throw new Error('wrong error: ' + r.err.slice(0, 200));
    return 'refused in ~0.6 s';
  });

  await check('helper: system-info 在缺 getprop/dumpsys 时仍输出可解析 JSON', () => {
    const h = newHarness();
    const r = runHarness(h, `( cmd_system_info )\necho "EXIT=$?"`);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('cmd_system_info crashed: ' + r.err.slice(0, 200));
    const line = r.out.split('\n').find((l) => l.startsWith('{"ok":true'));
    if (!line) throw new Error('no JSON line: ' + r.out);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const k of ['android', 'hyperos', 'joyose', 'module']) {
      if (typeof parsed[k] !== 'string') throw new Error(`${k} is not a string`);
    }
    return 'four string fields, no crash';
  });
}

// ---- device-side transaction, metadata and crash recovery ----------------
//
// Four claims that only a real shell can prove, because each one is about what
// survives a process that is no longer running:
//
//   * a backup directory is either complete or refused, never half-restored;
//   * a failed SELinux relabel is reported instead of swallowed;
//   * a write that could not be digest-checked says so;
//   * a swap interrupted between its two renames is repaired on the next run.

async function runTransactionTest() {
  console.log('\n=== transaction, metadata and crash recovery ===');
  if (!shHasTools()) {
    await check('tx: 故障注入跳过（本机没有 sh）', () => 'skipped');
    return;
  }

  const push = `B64=$(base64 -w0 "$DB/new.db")
( cmd_push smartp "$B64" "$(stat -c %s "$DB/new.db")" "" )
echo "EXIT=$?"`;

  // A device with both databases, and both candidates staged for a pair write.
  const seedPair = (h: HelperHarness) => {
    const stageDir = path.join(h.dataDir, 'stage');
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(
      path.join(stageDir, 'sp'),
      readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/SmartP.db')).toString('base64'),
    );
    writeFileSync(
      path.join(stageDir, 'teg'),
      readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/teg_config.db')).toString('base64'),
    );
    writeFileSync(
      path.join(h.dbDir, 'teg_config.db'),
      readFileSync(path.join(ROOT, 'tests/Xiaomi 15/teg_config.db')),
    );
  };
  const pairWrite = `( cmd_push_pair_from_stage sp teg "" "" "" "" "" "" )
echo "EXIT=$?"`;
  // Any mutating command takes the lock, and taking the lock is where a
  // leftover transaction record is resolved.
  const takeLock = `( _acquire_lock probe )
echo "EXIT=$?"`;

  await check('备份：完整才写 COMPLETE，缺一个库的备份拒绝回滚', () => {
    const h = newHarness();
    seedPair(h);
    const r1 = runHarness(h, `( cmd_backup --no-restore )\necho "EXIT=$?"`);
    const names = readdirSync(path.join(h.dataDir, 'backup')).sort();
    const dir = path.join(h.dataDir, 'backup', names[0] ?? 'missing');
    const marked = existsSync(path.join(dir, 'COMPLETE'));
    const sp = path.join(h.dbDir, 'SmartP.db');
    const before = shaOf(sp);
    // The shape of a run killed between its two `cp` calls: SmartP landed,
    // teg never did.
    rmSync(path.join(dir, 'teg_config.db'), { force: true });
    const r2 = runHarness(h, `( cmd_revert ${names[0]} )\necho "EXIT=$?"`);
    const after = shaOf(sp);
    cleanupHarness(h);
    if (!r1.out.includes('EXIT=0')) throw new Error('backup failed: ' + r1.err.slice(0, 300));
    if (!marked) throw new Error('backup directory has no completeness marker');
    if (!r2.out.includes('EXIT=1')) throw new Error('half backup was restored');
    if (!/incomplete-backup/.test(r2.err)) throw new Error('wrong code: ' + r2.err.slice(0, 300));
    if (after !== before) throw new Error('live database changed on a refused revert');
    return 'marker written, half backup refused';
  });

  await check('备份：内容与生成时的摘要不符时拒绝回滚', () => {
    const h = newHarness();
    seedPair(h);
    const r1 = runHarness(h, `( cmd_backup --no-restore )\necho "EXIT=$?"`);
    const name = readdirSync(path.join(h.dataDir, 'backup'))[0] ?? '';
    const dir = path.join(h.dataDir, 'backup', name);
    // A different but perfectly valid database: the integrity check passes, so
    // only the marker can tell that this is not what was snapshotted.
    writeFileSync(
      path.join(dir, 'SmartP.db'),
      readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/SmartP.db')),
    );
    const sp = path.join(h.dbDir, 'SmartP.db');
    const before = shaOf(sp);
    const r2 = runHarness(h, `( cmd_revert ${name} )\necho "EXIT=$?"`);
    const after = shaOf(sp);
    cleanupHarness(h);
    if (!r1.out.includes('EXIT=0')) throw new Error('backup failed: ' + r1.err.slice(0, 300));
    if (!r2.out.includes('EXIT=1')) throw new Error('tampered backup was restored');
    if (!/backup-corrupt/.test(r2.err)) throw new Error('wrong code: ' + r2.err.slice(0, 300));
    if (after !== before) throw new Error('live database changed');
    return 'tampered snapshot refused';
  });

  await check('备份：旧版本没有标记时仍然可回滚，但结果标成 legacy', () => {
    const h = newHarness();
    seedPair(h);
    runHarness(h, `( cmd_backup --no-restore )\necho "EXIT=$?"`);
    const name = readdirSync(path.join(h.dataDir, 'backup'))[0] ?? '';
    rmSync(path.join(h.dataDir, 'backup', name, 'COMPLETE'), { force: true });
    const r = runHarness(h, `( cmd_revert ${name} )\necho "EXIT=$?"`);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('legacy backup refused: ' + r.err.slice(0, 300));
    if (!/"legacy":true/.test(r.out)) throw new Error('did not report legacy: ' + r.out.slice(0, 300));
    return 'legacy backup restored and flagged';
  });

  await check('标签：restorecon 失败时写入仍成功，但报告 failed', () => {
    const h = newHarness();
    touchState(h, 'restorecon-fails');
    const r = runHarness(h, push);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write failed: ' + r.err.slice(0, 300));
    if (!/"labelRestored":"failed"/.test(r.out)) throw new Error('failure not reported: ' + r.out.slice(0, 300));
    return 'label failure reported, write kept';
  });

  await check('标签：没有 restorecon 的 ROM 报 unsupported', () => {
    const h = newHarness();
    unlinkSync(path.join(h.bin, 'restorecon'));
    const r = runHarness(h, push);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write failed: ' + r.err.slice(0, 300));
    if (!/"labelRestored":"unsupported"/.test(r.out)) throw new Error('wrong label state: ' + r.out.slice(0, 300));
    return 'unsupported, not failed';
  });

  await check('摘要：无法计算时报告 verifiedBy=length 且未复核在库文件', () => {
    const h = newHarness();
    const r = runHarness(h, push);
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write failed: ' + r.err.slice(0, 300));
    if (!/"verifiedBy":"length"/.test(r.out)) throw new Error('downgrade not reported: ' + r.out.slice(0, 300));
    if (!/"liveChecked":false/.test(r.out)) throw new Error('live re-check claimed: ' + r.out.slice(0, 300));
    return 'length-only write says so';
  });

  await check('摘要：带摘要时报告 verifiedBy=sha256', () => {
    const h = newHarness();
    const r = runHarness(
      h,
      `B64=$(base64 -w0 "$DB/new.db")
SHA=$(sha256sum "$DB/new.db" | cut -d' ' -f1)
CUR=$(sha256sum "$DB/SmartP.db" | cut -d' ' -f1)
( cmd_push smartp "$B64" "$(stat -c %s "$DB/new.db")" "$SHA" "$CUR" )
echo "EXIT=$?"`,
    );
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('write failed: ' + r.err.slice(0, 300));
    if (!/"verifiedBy":"sha256"/.test(r.out)) throw new Error('digest not reported: ' + r.out.slice(0, 300));
    if (!/"liveChecked":true/.test(r.out)) throw new Error('live check not reported: ' + r.out.slice(0, 300));
    return 'sha256 + live check';
  });

  await check('崩溃：第二次换库前被杀，下次加锁时两库回滚到旧的一代', () => {
    const h = newHarness();
    seedPair(h);
    const sp = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    const beforeSp = shaOf(sp);
    const beforeTeg = shaOf(teg);
    touchState(h, 'mv-kills-on-teg');
    const dead = runHarness(h, pairWrite);
    const halfSp = shaOf(sp);
    const halfTeg = shaOf(teg);
    const recorded = existsSync(path.join(h.dataDir, '.pending-pair'));
    unlinkSync(path.join(h.fake, 'mv-kills-on-teg'));
    const r2 = runHarness(h, takeLock);
    const afterSp = shaOf(sp);
    const afterTeg = shaOf(teg);
    const stillRecorded = existsSync(path.join(h.dataDir, '.pending-pair'));
    const note = existsSync(path.join(h.dataDir, '.pending-pair.note'))
      ? readFileSync(path.join(h.dataDir, '.pending-pair.note'), 'utf8')
      : '';
    cleanupHarness(h);
    // The driver runs the write in a subshell, so the kill lands there: the
    // subshell dies with 137 and the outer script keeps going. That is a closer
    // model of a phone losing the writer mid-swap than "no output at all".
    if (!dead.out.includes('EXIT=137')) {
      throw new Error('the write was not killed between swaps: ' + (dead.out || dead.err).slice(0, 200));
    }
    if (halfSp === beforeSp) throw new Error('SmartP was not swapped before the kill (test did not reach the window)');
    if (halfTeg !== beforeTeg) throw new Error('teg changed before the kill');
    if (!recorded) throw new Error('no transaction record was written before the swap');
    if (!r2.out.includes('EXIT=0')) throw new Error('recovery refused: ' + r2.err.slice(0, 300));
    if (afterSp !== beforeSp) throw new Error('SmartP was not rolled back');
    if (afterTeg !== beforeTeg) throw new Error('teg moved during recovery');
    if (stillRecorded) throw new Error('transaction record was not cleared');
    if (!/rolled-back/.test(note)) throw new Error('recovery not recorded: ' + note);
    return 'half-applied pair rolled back on next lock';
  });

  await check('回滚：设备上少了一个库时，只恢复另一个并报告 skipped', () => {
    const h = newHarness();
    seedPair(h);
    runHarness(h, `( cmd_backup --no-restore )\necho "EXIT=$?"`);
    const name = readdirSync(path.join(h.dataDir, 'backup'))[0] ?? '';
    // The device lost teg_config.db entirely. Restoring SmartP is still the
    // useful thing to do, but the result must say the pair is incomplete.
    rmSync(path.join(h.dbDir, 'teg_config.db'), { force: true });
    const r = runHarness(h, `( cmd_revert ${name} )\necho "EXIT=$?"`);
    const tegBack = existsSync(path.join(h.dbDir, 'teg_config.db'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('revert failed: ' + r.err.slice(0, 300));
    if (!/teg_config\.db/.test(r.out)) throw new Error('skipped database not reported: ' + r.out.slice(0, 300));
    if (tegBack) throw new Error('a database the device no longer had was recreated');
    return 'partial restore reported';
  });

  await check('崩溃：回滚副本丢失时拒绝写入，而不是猜', () => {
    const h = newHarness();
    seedPair(h);
    const sp = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    const oldSp = shaOf(sp);
    // SmartP already swapped, teg not, and the rollback copy is gone: there is
    // no evidence-backed way to put SmartP back.
    writeFileSync(sp, readFileSync(path.join(ROOT, 'tests/Xiaomi 17 Ultra/SmartP.db')));
    const lines = [
      'created=1',
      'sp_rb=/nonexistent/sp.rb',
      'teg_rb=/nonexistent/teg.rb',
      `sp_old=${oldSp}`,
      `teg_old=${shaOf(teg)}`,
      `sp_new=${shaOf(sp)}`,
      `teg_new=deadbeef`,
      `sp_old_size=1`,
      `teg_old_size=1`,
      `sp_new_size=${statSync(sp).size}`,
      `teg_new_size=0`,
      'sp_used=true',
      'teg_used=true',
      'was_running=false',
    ].join('\n');
    writeFileSync(path.join(h.dataDir, '.pending-pair'), lines + '\n');
    const r = runHarness(h, takeLock);
    const kept = existsSync(path.join(h.dataDir, '.pending-pair'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=1')) throw new Error('recovery guessed instead of refusing');
    if (!/recovery-required/.test(r.err)) throw new Error('wrong code: ' + r.err.slice(0, 300));
    if (!kept) throw new Error('evidence was deleted on an undecidable state');
    return 'refused, record kept';
  });

  await check('崩溃：两库都已写入时只清理记录，不回滚', () => {
    const h = newHarness();
    seedPair(h);
    const sp = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    // State after both swaps landed and the process died before clearing the
    // record: the digests say "committed", and rolling back would throw away a
    // finished write.
    const sha = (f: string) => shaOf(f);
    const lines = [
      'created=1',
      'sp_rb=/nonexistent/sp.rb',
      'teg_rb=/nonexistent/teg.rb',
      'sp_old=0000000000000000000000000000000000000000000000000000000000000000',
      'teg_old=1111111111111111111111111111111111111111111111111111111111111111',
      `sp_new=${sha(sp)}`,
      `teg_new=${sha(teg)}`,
      `sp_old_size=1`,
      `teg_old_size=1`,
      `sp_new_size=${statSync(sp).size}`,
      `teg_new_size=${statSync(teg).size}`,
      'sp_used=true',
      'teg_used=true',
      'was_running=false',
    ].join('\n');
    writeFileSync(path.join(h.dataDir, '.pending-pair'), lines + '\n');
    const beforeSp = sha(sp);
    const r = runHarness(h, takeLock);
    const afterSp = sha(sp);
    const gone = !existsSync(path.join(h.dataDir, '.pending-pair'));
    const note = existsSync(path.join(h.dataDir, '.pending-pair.note'))
      ? readFileSync(path.join(h.dataDir, '.pending-pair.note'), 'utf8')
      : '';
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('recovery refused: ' + r2msg(r));
    if (!gone) throw new Error('record kept after a committed transaction');
    if (afterSp !== beforeSp) throw new Error('a committed transaction was rolled back');
    if (!/committed/.test(note)) throw new Error('wrong note: ' + note);
    return 'committed record discarded, data kept';
  });

  await check('崩溃：还没换库就断电时只清理，不碰数据库', () => {
    const h = newHarness();
    seedPair(h);
    const sp = path.join(h.dbDir, 'SmartP.db');
    const teg = path.join(h.dbDir, 'teg_config.db');
    const beforeSp = shaOf(sp);
    const lines = [
      'created=1',
      'sp_rb=/nonexistent/sp.rb',
      'teg_rb=/nonexistent/teg.rb',
      `sp_old=${shaOf(sp)}`,
      `teg_old=${shaOf(teg)}`,
      'sp_new=deadbeef',
      'teg_new=deadbeef',
      `sp_old_size=${statSync(sp).size}`,
      `teg_old_size=${statSync(teg).size}`,
      'sp_new_size=0',
      'teg_new_size=0',
      'sp_used=true',
      'teg_used=true',
      'was_running=false',
    ].join('\n');
    writeFileSync(path.join(h.dataDir, '.pending-pair'), lines + '\n');
    const r = runHarness(h, takeLock);
    const afterSp = shaOf(sp);
    const gone = !existsSync(path.join(h.dataDir, '.pending-pair'));
    cleanupHarness(h);
    if (!r.out.includes('EXIT=0')) throw new Error('recovery refused: ' + r.err.slice(0, 300));
    if (!gone) throw new Error('record kept after a transaction that never started');
    if (afterSp !== beforeSp) throw new Error('database touched');
    return 'nothing to repair, record cleared';
  });

  await check('锁：owner 刚创建还没来得及写完时不算死锁', () => {
    const h = newHarness();
    // The window the 20-writer test hit on a slower machine: `printf > owner`
    // creates the file before filling it, and a waiter that read it in between
    // saw "no owner" on a lock that was about to be held.
    mkdirSync(path.join(h.dataDir, 'lock'), { recursive: true });
    writeFileSync(path.join(h.dataDir, 'lock', 'owner'), '');
    const r = runHarness(h, `( _lock_stale )\necho "STALE=$?"`);
    cleanupHarness(h);
    if (!r.out.includes('STALE=1')) throw new Error('an initialising lock was judged stale: ' + r.out.trim());
    return 'grace period covers an unreadable owner';
  });

  // CONC_WRITERS lets the suite be stressed locally (40/60 on one core) without
  // changing what CI runs.
  await check(`锁：${Number(process.env.CONC_WRITERS ?? 20)} 个写入者并发抢锁，临界区始终只有一个`, () => {
    const h = newHarness();
    const n = Number(process.env.CONC_WRITERS ?? 20);
    const script = Array.from({ length: n }, () =>
      `( _acquire_lock c; echo in >> "$FAKE/conc.log"; sleep 0.02; echo out >> "$FAKE/conc.log"; _release_lock ) &`,
    );
    script.push('wait');
    const t0 = Date.now();
    const r = runHarness(h, script.join('\n'));
    const took = Date.now() - t0;
    const seq = readFileSync(path.join(h.fake, 'conc.log'), 'utf8').trim().split('\n');
    cleanupHarness(h);
    if (seq.length !== n * 2) throw new Error(`expected ${n * 2} entries, got ${seq.length}: ` + r.err.slice(0, 200));
    // Strictly alternating is the whole assertion: two "in" lines in a row mean
    // two writers held the lock at the same time.
    for (let i = 0; i < seq.length; i++) {
      const want = i % 2 === 0 ? 'in' : 'out';
      if (seq[i] !== want) throw new Error(`interleaved at ${i}: ${seq.slice(0, i + 1).join(',')}`);
    }
    return `${n} writers serialised in ${took} ms`;
  });
}

function r2msg(r: { out: string; err: string }): string {
  return (r.err || r.out).slice(0, 300);
}

// ---- compatibility matrix (G3) ------------------------------------------
//
// The matrix is the one place that answers "has this been proven on a phone?".
// These checks keep it honest: every row needs evidence, and the set of
// device-verified rows must match README (only MIFISR today). Upgrading a row
// is fine — upgrading it without the README change, or without the hardware,
// is not.

async function runCompatMatrixTest() {
  console.log('\n=== compatibility matrix ===');

  await check('compat: 页面 ID 无重复', () => {
    const seen = new Set<string>();
    for (const id of VIEW_IDS) {
      if (seen.has(id)) throw new Error('duplicate view id: ' + id);
      seen.add(id);
    }
    if (!seen.has('diagnosis')) throw new Error('diagnosis page not registered');
    return `${seen.size} pages`;
  });

  await check('compat: 每一行都有证据和合法级别', () => {
    const levels = new Set(Object.keys(VERIFICATION_LABEL));
    for (const c of CAPABILITIES) {
      if (!c.id || !c.label) throw new Error('row without id/label');
      if (!c.evidence.trim()) throw new Error(`${c.id} has no evidence`);
      if (!levels.has(c.verification)) throw new Error(`${c.id} has unknown level ${c.verification}`);
    }
    return `${CAPABILITIES.length} rows, ${levels.size} levels`;
  });

  await check('compat: 实机验证项与 README 一致（只有 MIFISR）', () => {
    const device = CAPABILITIES.filter((c) => c.verification === 'device').map((c) => c.id);
    if (device.length !== 1 || device[0] !== 'mifisr') {
      throw new Error('device-verified set drifted from README: ' + device.join(','));
    }
    return 'only mifisr claims device verification';
  });
}

// ---------------------------------------------------------------------------
// Property tests for the delta engine.
//
// The unit cases in runDiffTest each cover one shape. These assert the two
// laws the whole history system rests on, over a fixed corpus and a
// deterministic random sweep:
//
//   applyDelta(before, diff(before, after))            === after
//   applyDelta(after,  invertDelta(diff(before, after))) === before
//
// A single reverse sweep used to violate both for arrays: multiple insertions
// landed in the wrong order, and undoing several deletions produced
// [A,B,D,C] instead of [A,B,C,D].

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function runDiffPropertyTest() {
  console.log('\n=== diff / invert properties ===');
  const clone = (v: any) => JSON.parse(JSON.stringify(v));
  const same = (x: any, y: any) => JSON.stringify(x) === JSON.stringify(y);

  const round = (name: string, before: any, after: any) => {
    const d = diff(before, after);
    const forward = applyDelta(clone(before), d);
    if (!same(forward, after)) {
      throw new Error(`${name}: forward replay mismatch ${JSON.stringify(forward)} != ${JSON.stringify(after)}`);
    }
    const back = applyDelta(clone(after), invertDelta(d));
    if (!same(back, before)) {
      throw new Error(`${name}: inverse replay mismatch ${JSON.stringify(back)} != ${JSON.stringify(before)}`);
    }
  };

  await check('diff: 数组增删改重排的前向与逆向都能复原', () => {
    const cases: [string, any, any][] = [
      ['multiple inserts', { l: [{ id: 'A' }, { id: 'D' }] }, { l: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }] }],
      ['multiple removals', { l: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }] }, { l: [{ id: 'A' }, { id: 'D' }] }],
      ['non-adjacent removals', { l: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }] }, { l: [{ id: 'A' }, { id: 'C' }, { id: 'E' }] }],
      ['reorder only', { l: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }, { l: [{ id: 'C' }, { id: 'A' }, { id: 'B' }] }],
      ['reorder + field edit', { l: [{ id: 'A', v: 1 }, { id: 'B', v: 2 }, { id: 'C', v: 3 }] }, { l: [{ id: 'C', v: 3 }, { id: 'A', v: 1 }, { id: 'B', v: 9 }] }],
      ['insert + remove', { l: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }, { l: [{ id: 'A' }, { id: 'C' }, { id: 'D' }] }],
      ['remove all', { l: [{ id: 'A' }, { id: 'B' }] }, { l: [] }],
      ['from empty', { l: [] }, { l: [{ id: 'A' }, { id: 'B' }] }],
    ];
    for (const [name, before, after] of cases) round(name, before, after);
    return `${cases.length} shapes, both directions`;
  });

  await check('diff: 随机数组变换 200 组都能复原', () => {
    const rnd = lcg(20261114);
    for (let n = 0; n < 200; n++) {
      const size = Math.floor(rnd() * 7);
      const pool = Array.from({ length: size }, (_, i) => ({
        id: `k${i}`,
        v: Math.floor(rnd() * 5),
      }));
      const kept = pool.filter(() => rnd() > 0.35);
      const afterArr = kept.map((el) => (rnd() > 0.6 ? { ...el, v: Math.floor(rnd() * 5) } : { ...el }));
      for (let i = afterArr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [afterArr[i], afterArr[j]] = [afterArr[j], afterArr[i]];
      }
      round(`random #${n}`, { l: pool }, { l: afterArr });
    }
    return '200 random cases';
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});