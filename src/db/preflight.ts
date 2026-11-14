// Checks that run before a commit leaves the app.
//
// The one rule here exists because the "new entry" button has to start
// somewhere, and all three of them start with `com.example.newgame`. That
// template is harmless while it sits in the working copy; it becomes a silent
// no-op the moment it is written into the database, because Joyose matches
// games by package name and no game is called `com.example.newgame`. The user
// then reports "the toggle did nothing" and nothing in the UI said why.
//
// Deliberately narrow: only package names that cannot be anybody's game are
// rejected. Guessing at anything else (case, underscores, length) would block
// real apps on some ROMs.
//
// IMPORTANT — the paths below are the *live* state shape, not a convenient
// one. Every per-game list lives under
//   state.cloudConfig.booster_config.params.game_booster
// and the entries are serialized strings, not objects:
//   customize_game_params.game_mifisr_config  "com.a_45_90_..."  (MIFISR)
//   frc_game_params                           "com.a_45_90_..."  (FRC)
//   novatek_game_params                       "com.a_..."        (Novatek)
// An earlier version of this file read `cloudConfig.game_mifisr_config`,
// which never exists, so the check silently passed everything. The test
// fixture repeated the same wrong shape, which is why it looked green.

import { parseMifisr } from '@/parsers/mifisr-string';
import { parseFrc } from '@/parsers/frc-string';
import { parseNovatek } from '@/parsers/novatek-string';

export interface PreflightIssue {
  /** Config that carries the problem, for the message. */
  where: string;
  message: string;
}

const PLACEHOLDER_EXACT = new Set([
  'com.example.newgame',
  'com.example.game',
  'com.example.app',
  'com.example',
  'your.package.name',
  'your.app',
  'yourcompany.game',
]);

/** True for template/empty package names. Real apps never match these. */
export function isPlaceholderPkg(pkg: string): boolean {
  const p = pkg.trim().toLowerCase();
  if (!p) return true;
  if (PLACEHOLDER_EXACT.has(p)) return true;
  // com.example.* is reserved by the Android docs for samples.
  if (/^com\.example(\.|$)/.test(p)) return true;
  // Leftovers from copy-pasted snippets.
  if (/^your\.(package|app|company)(\.|$)/.test(p)) return true;
  return false;
}

/** The container every per-game list hangs off. */
function gameBooster(cloudConfig: Record<string, any> | null | undefined): any {
  return cloudConfig?.booster_config?.params?.game_booster ?? null;
}

interface Domain {
  label: string;
  /** Human-readable field name used in the message. */
  where: string;
  list: unknown;
  pkgOf: (raw: string) => string;
}

/** Issues that must be fixed before writing to the device. Empty means clear. */
export function preflightCloudConfig(
  cloudConfig: Record<string, any> | null | undefined,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const gb = gameBooster(cloudConfig);
  if (!gb || typeof gb !== 'object') return issues;

  const domains: Domain[] = [
    {
      label: 'MIFISR',
      where: 'game_mifisr_config',
      list: gb?.customize_game_params?.game_mifisr_config,
      pkgOf: (raw) => parseMifisr(raw).pkg,
    },
    {
      label: 'FRC',
      where: 'frc_game_params',
      list: gb?.frc_game_params,
      pkgOf: (raw) => parseFrc(raw).pkg,
    },
    {
      label: 'Novatek',
      where: 'novatek_game_params',
      list: gb?.novatek_game_params,
      pkgOf: (raw) => parseNovatek(raw).pkg,
    },
  ];

  for (const d of domains) {
    if (!Array.isArray(d.list)) continue;
    const seen = new Set<string>();
    for (const raw of d.list) {
      if (typeof raw !== 'string') continue;
      let pkg = '';
      try {
        pkg = d.pkgOf(raw);
      } catch {
        issues.push({
          where: d.where,
          message: `${d.label} 有一条条目无法解析，提交后 Joyose 会忽略它（${raw.slice(0, 32)}…）`,
        });
        continue;
      }
      if (!isPlaceholderPkg(pkg)) continue;
      const key = `${d.where}:${pkg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        where: d.where,
        message: `${d.label} 的包名 "${pkg || '(空)'}" 是占位值，Joyose 不会把它匹配到任何游戏`,
      });
    }
  }
  return issues;
}
