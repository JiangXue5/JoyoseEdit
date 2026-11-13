// Checks that run before a commit leaves the app.
//
// The one rule here exists because the "new entry" button has to start
// somewhere, and it starts with `com.example.newgame`. That template is
// harmless while it sits in the working copy; it becomes a silent no-op the
// moment it is written into the database, because Joyose matches games by
// package name and no game is called `com.example.newgame`. The user then
// reports "the toggle did nothing" and nothing in the UI said why.
//
// Deliberately narrow: only package names that cannot be anybody's game are
// rejected. Guessing at anything else (case, underscores, length) would block
// real apps on some ROMs.

import { parseMifisr } from '@/parsers/mifisr-string';

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

/** Issues that must be fixed before writing to the device. Empty means clear. */
export function preflightCloudConfig(
  cloudConfig: Record<string, any> | null | undefined,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const list = cloudConfig?.game_mifisr_config?.params?.game_mifisr_config;
  if (!Array.isArray(list)) return issues;

  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    let pkg = '';
    try {
      pkg = parseMifisr(raw).pkg;
    } catch {
      issues.push({
        where: 'game_mifisr_config',
        message: `有一条条目无法解析，提交后 Joyose 会忽略它（${raw.slice(0, 32)}…）`,
      });
      continue;
    }
    if (!isPlaceholderPkg(pkg)) continue;
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    issues.push({
      where: 'game_mifisr_config',
      message: `包名 "${pkg || '(空)'}" 是占位值，Joyose 不会把它匹配到任何游戏`,
    });
  }
  return issues;
}
