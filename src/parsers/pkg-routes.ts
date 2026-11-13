// Per-game routes that live outside `fisr_config`.
//
// A game can be referenced from six different places in game_booster. Deleting
// it from `game_mifisr_config` used to clean fisr_config, mqs_enhance_list and
// dp_fi_config only, so the leftover `support_highfps_app` entry kept a frame
// rate override alive for a game the user had just removed.
//
// Deletion is deliberately split in two:
//   * removed  — routes whose only purpose is this game's enhancement;
//   * kept     — routes that are a standalone setting (a gex fps cap, an FRC
//                string). They are reported, not silently deleted: "delete the
//                game entry" is not the same instruction as "drop my fps cap".

import { removePkg, isFisrConfig, type FisrConfig } from './fisr-config';

export interface RouteHit {
  /** Key under game_booster. */
  key: string;
  /** What the user sees. */
  label: string;
  /** How many entries reference this package. */
  count: number;
}

export interface CleanResult {
  removed: RouteHit[];
  kept: RouteHit[];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Entries are prefixed with the package (`pkg:fps`, `pkg_45_90_…`), so the
 *  prefix doubles as the package boundary — `com.a` must not match `com.ab`. */
function countMatching(list: unknown[], prefix: string): number {
  return list.filter((e) => typeof e === 'string' && e.startsWith(prefix)).length;
}

/** Every route entry that mentions `pkg`, whether or not it is safe to drop. */
export function findPkgRoutes(gb: Record<string, any>, pkg: string): RouteHit[] {
  if (!gb || !pkg) return [];
  const out: RouteHit[] = [];

  const cfg = gb.fisr_config;
  if (isFisrConfig(cfg)) {
    const hits = cfg.enhance_config.filter((g) => g.game_list.includes(pkg)).length;
    if (hits) out.push({ key: 'fisr_config', label: '策略路由（fisr_config）', count: hits });
  }
  const mqs = countMatching(asArray(gb.mqs_enhance_list), `${pkg}:`);
  if (mqs) out.push({ key: 'mqs_enhance_list', label: 'MQS 增强名单', count: mqs });
  const dpfi = countMatching(asArray(gb.customize_game_params?.dp_fi_config), `${pkg}_`);
  if (dpfi) out.push({ key: 'customize_game_params.dp_fi_config', label: 'DMI 路由（dp_fi_config）', count: dpfi });
  const highfps = countMatching(asArray(gb.support_highfps_app), `${pkg}:`);
  if (highfps) out.push({ key: 'support_highfps_app', label: '高帧放行（support_highfps_app）', count: highfps });
  const gex = countMatching(asArray(gb.novatek_gex_fps_limit), `${pkg}:`);
  if (gex) out.push({ key: 'novatek_gex_fps_limit', label: '独显帧率上限（novatek_gex_fps_limit）', count: gex });
  // `pkg_minFps_targetFps_...` — 12 underscore-delimited fields.
  const frc = countMatching(asArray(gb.frc_game_params), `${pkg}_`);
  if (frc) out.push({ key: 'frc_game_params', label: 'FRC 参数（frc_game_params）', count: frc });
  return out;
}

/** Drop the enhancement routes for `pkg`; report the rest.
 *
 *  Mutates `gb` in place (the working copy) and returns what happened so the
 *  caller can tell the user exactly what was cleaned. */
export function removePkgRoutes(gb: Record<string, any>, pkg: string): CleanResult {
  const result: CleanResult = { removed: [], kept: [] };
  if (!gb || !pkg) return result;

  const before = findPkgRoutes(gb, pkg);

  const cfg = gb.fisr_config;
  if (isFisrConfig(cfg)) removePkg(cfg as FisrConfig, pkg);

  if (Array.isArray(gb.mqs_enhance_list)) {
    gb.mqs_enhance_list = gb.mqs_enhance_list.filter(
      (s: unknown) => !(typeof s === 'string' && s.startsWith(`${pkg}:`)),
    );
  }
  const dpfi = gb.customize_game_params?.dp_fi_config;
  if (Array.isArray(dpfi)) {
    gb.customize_game_params.dp_fi_config = dpfi.filter(
      (s: unknown) => !(typeof s === 'string' && s.startsWith(`${pkg}_`)),
    );
  }
  if (Array.isArray(gb.support_highfps_app)) {
    gb.support_highfps_app = gb.support_highfps_app.filter(
      (s: unknown) => !(typeof s === 'string' && s.startsWith(`${pkg}:`)),
    );
  }

  const KEEP = new Set(['novatek_gex_fps_limit', 'frc_game_params']);
  for (const hit of before) {
    if (KEEP.has(hit.key)) result.kept.push(hit);
    else result.removed.push(hit);
  }
  return result;
}

/** Android package name, plus the placeholder rule: `com.example.*` is what
 *  the "add game" button inserts, and writing it to the device would create a
 *  route that can never match an installed app. */
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
export function isValidPkgName(pkg: string): boolean {
  return PKG_RE.test(pkg) && !pkg.startsWith('com.example.');
}

export interface RenameResult {
  ok: boolean;
  reason?: 'invalid' | 'conflict';
  error?: string;
  /** Routes that were rewritten from the old package to the new one. */
  migrated: RouteHit[];
}

/** Rename a package everywhere it is referenced.
 *
 *  Editing the package name in the MIFISR list used to rewrite only the entry
 *  string: `fisr_config`'s `game_list`, `mqs_enhance_list`, `dp_fi_config` and
 *  `support_highfps_app` kept the old name, so the game lost its strategy or
 *  the old name kept a route alive for an app that no longer exists. This is
 *  the atomic version: all six routes move together, or nothing does. */
export function renamePkgRoutes(
  gb: Record<string, any>,
  from: string,
  to: string,
): RenameResult {
  if (!gb || !from || !to) {
    return { ok: false, reason: 'invalid', error: '包名不能为空', migrated: [] };
  }
  if (from === to) return { ok: true, migrated: [] };
  if (!isValidPkgName(to)) {
    return {
      ok: false,
      reason: 'invalid',
      error: `"${to}" 不是合法的包名${to.startsWith('com.example.') ? '（com.example.* 是占位值）' : ''}`,
      migrated: [],
    };
  }

  // Refuse if another game already owns this package: merging two games into
  // one would silently hand the target's routes to the newly renamed entry.
  const conflicts: string[] = [];
  const cfg = gb.fisr_config;
  if (isFisrConfig(cfg)) {
    if (cfg.enhance_config.some((g) => g.game_list.includes(to) && !g.game_list.includes(from))) {
      conflicts.push('策略路由（fisr_config）');
    }
  }
  if (asArray(gb.mqs_enhance_list).some((e) => typeof e === 'string' && e.startsWith(`${to}:`))) {
    conflicts.push('MQS 增强名单');
  }
  if (
    asArray(gb.customize_game_params?.dp_fi_config).some(
      (e) => typeof e === 'string' && e.startsWith(`${to}_`),
    )
  ) {
    conflicts.push('DMI 路由（dp_fi_config）');
  }
  if (asArray(gb.support_highfps_app).some((e) => typeof e === 'string' && e.startsWith(`${to}:`))) {
    conflicts.push('高帧放行（support_highfps_app）');
  }
  if (conflicts.length) {
    return {
      ok: false,
      reason: 'conflict',
      error: `${to} 已被另一款游戏占用：${conflicts.join('、')}`,
      migrated: [],
    };
  }

  const before = findPkgRoutes(gb, from);
  const migrated: RouteHit[] = [];

  if (isFisrConfig(cfg)) {
    for (const group of cfg.enhance_config) {
      if (group.game_list.includes(from)) {
        group.game_list = group.game_list.map((p) => (p === from ? to : p));
      }
    }
  }
  const renameList = (list: unknown, sep: string): unknown => {
    if (!Array.isArray(list)) return list;
    return list.map((e) =>
      typeof e === 'string' && e.startsWith(`${from}${sep}`)
        ? `${to}${sep}${e.slice(from.length + sep.length)}`
        : e,
    );
  };
  if (Array.isArray(gb.mqs_enhance_list)) {
    gb.mqs_enhance_list = renameList(gb.mqs_enhance_list, ':');
  }
  if (Array.isArray(gb.customize_game_params?.dp_fi_config)) {
    gb.customize_game_params.dp_fi_config = renameList(
      gb.customize_game_params.dp_fi_config,
      '_',
    );
  }
  if (Array.isArray(gb.support_highfps_app)) {
    gb.support_highfps_app = renameList(gb.support_highfps_app, ':');
  }
  if (Array.isArray(gb.novatek_gex_fps_limit)) {
    gb.novatek_gex_fps_limit = renameList(gb.novatek_gex_fps_limit, ':');
  }
  if (Array.isArray(gb.frc_game_params)) {
    gb.frc_game_params = renameList(gb.frc_game_params, '_');
  }

  for (const hit of before) {
    // fisr_config is always touched (the group's game_list); the rest only if
    // an entry actually existed for the old name.
    if (hit.key === 'fisr_config' || findPkgRoutes(gb, to).some((h) => h.key === hit.key)) {
      migrated.push(hit);
    }
  }
  return { ok: true, migrated };
}
