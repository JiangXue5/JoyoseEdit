// Parser / serializer for the MIFISR (Mi Frame Insertion + Super Resolution)
// per-game string format, as observed in 17 Ultra cloud:
//
//   booster_config.params.game_booster.customize_game_params.game_mifisr_config
//
// Format: <pkg>_<minFps>#<targetFps>#<srcFpsList>#<T1>#<T2>#<T3>#<T4>
//
// Examples (verbatim from 17 Ultra):
//   com.miHoYo.Yuanshen_-1#-1#45,60#47#45#44#42
//   com.miHoYo.hkrpg_-1#-1#60#47#45#44#42
//
// Field separators: pkg separated from field body by the FIRST underscore, then
// fields separated by `#`. srcFpsList is a comma-separated list allowing one or
// more source fps values. minFps / targetFps accept `-1` to mean "driver auto".
//
// Note: this is a different delimiter scheme than the 15 Pro AFME/FRC/FSR
// `frc_game_params` format (11 underscore-delimited fields). Both formats
// require the package name to not contain `_`.

export interface MifisrParams {
  pkg: string;
  /** -1 = driver auto; otherwise >= 0 */
  minFps: number;
  /** -1 = driver auto; otherwise >= 0 */
  targetFps: number;
  /** Source fps list (1 or more values). Comma-delimited on disk. */
  srcFps: number[];
  t1: number;
  t2: number;
  t3: number;
  t4: number;
}

/** Parse a single mifisr string into its 7 fields. Throws on malformed input. */
export function parseMifisr(raw: string): MifisrParams {
  if (typeof raw !== 'string') throw new TypeError('mifisr: not a string');
  const us = raw.indexOf('_');
  if (us <= 0) throw new Error(`mifisr: missing package delimiter: ${raw}`);
  const pkg = raw.slice(0, us);
  const body = raw.slice(us + 1);
  const parts = body.split('#');
  if (parts.length !== 7) {
    throw new Error(`mifisr: expected 7 #-delimited fields, got ${parts.length}: ${raw}`);
  }
  const [minFps, targetFps, srcFpsList, t1, t2, t3, t4] = parts;
  if (!pkg) throw new Error('mifisr: empty package');
  return {
    pkg,
    minFps: numOrAuto(minFps, 'minFps'),
    targetFps: numOrAuto(targetFps, 'targetFps'),
    srcFps: parseSrcFpsList(srcFpsList),
    t1: num(t1, 't1'),
    t2: num(t2, 't2'),
    t3: num(t3, 't3'),
    t4: num(t4, 't4'),
  };
}

/** Round-trip to the canonical on-disk form. */
export function serializeMifisr(p: MifisrParams): string {
  if (p.pkg.includes('_')) {
    throw new Error(`mifisr: package "${p.pkg}" contains underscore — format uses _ between pkg and fields`);
  }
  if (!p.srcFps || p.srcFps.length === 0) {
    throw new Error('mifisr: srcFps list must have at least one value');
  }
  const srcFpsStr = p.srcFps.map(fmt).join(',');
  const body = [fmtAuto(p.minFps), fmtAuto(p.targetFps), srcFpsStr, fmt(p.t1), fmt(p.t2), fmt(p.t3), fmt(p.t4)].join('#');
  return `${p.pkg}_${body}`;
}

export interface MifisrValidationIssue {
  field: keyof MifisrParams | 'relation' | 'srcFps';
  message: string;
  /** non-fatal hints (e.g. low-fps sources) shown as info, not errors */
  severity?: 'error' | 'warn';
}

export function validateMifisr(p: MifisrParams): MifisrValidationIssue[] {
  const issues: MifisrValidationIssue[] = [];

  if (!p.pkg || p.pkg.includes('_')) {
    issues.push({ field: 'pkg', message: 'package name must be non-empty and contain no underscore' });
  } else if (p.pkg.startsWith('com.example.')) {
    // The "add game" button inserts this placeholder. Writing it to the device
    // creates a MIFISR route that no installed app can ever match.
    issues.push({ field: 'pkg', message: 'placeholder package name — replace it with the real one' });
  }

  for (const k of ['minFps', 'targetFps'] as const) {
    const v = p[k];
    if (v !== -1 && (!Number.isFinite(v) || v < 0)) {
      issues.push({ field: k, message: 'must be -1 (auto) or a non-negative number' });
    }
  }

  for (const k of ['t1', 't2', 't3', 't4'] as const) {
    if (!Number.isFinite(p[k]) || p[k] < 0) {
      issues.push({ field: k, message: 'must be a non-negative number' });
    }
  }

  if (p.srcFps?.length === 0) {
    issues.push({ field: 'srcFps', message: 'must have at least one source fps value' });
  } else {
    for (const s of p.srcFps) {
      if (!Number.isFinite(s) || s <= 0) {
        issues.push({ field: 'srcFps', message: `invalid source fps ${s} (must be > 0)` });
      } else if (s < 45) {
        issues.push({
          field: 'srcFps',
          message: `source fps ${s} is below 45 — MIFISR may not activate on low-fps sources on 8 Elite 2`,
          severity: 'warn',
        });
      }
    }
  }

  // T1 >= T2 >= T3 >= T4 (thermal downshift; higher = hotter = earlier trigger).
  if (p.t1 > 0 && p.t2 > 0 && p.t3 > 0 && p.t4 > 0) {
    if (!(p.t1 >= p.t2 && p.t2 >= p.t3 && p.t3 >= p.t4)) {
      issues.push({
        field: 'relation',
        message: 'thermal thresholds should be non-increasing: T1 >= T2 >= T3 >= T4',
      });
    }
  }

  // When both min/target are explicit (not -1), target should be >= min.
  if (p.minFps !== -1 && p.targetFps !== -1 && p.targetFps < p.minFps) {
    issues.push({
      field: 'relation',
      message: `targetFps (${p.targetFps}) should be >= minFps (${p.minFps})`,
    });
  }

  return issues;
}

export function blankMifisr(pkg = ''): MifisrParams {
  return {
    pkg,
    minFps: -1,
    targetFps: -1,
    srcFps: [60],
    t1: 47,
    t2: 45,
    t3: 44,
    t4: 42,
  };
}

function num(v: string, label: string): number {
  if (v === '' || v == null) throw new Error(`mifisr: ${label} is empty`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`mifisr: ${label} "${v}" is not a finite number`);
  return n;
}

function numOrAuto(v: string, label: string): number {
  if (v === '-1') return -1;
  return num(v, label);
}

function parseSrcFpsList(v: string): number[] {
  if (v === '' || v == null) throw new Error('mifisr: srcFps list is empty');
  if (/\s/.test(v)) throw new Error(`mifisr: srcFps list "${v}" must not contain whitespace`);
  const parts = v.split(',');
  return parts.map((p, i) => {
    if (p === '') throw new Error(`mifisr: srcFps item ${i} is empty in "${v}"`);
    const n = Number(p);
    if (!Number.isFinite(n)) throw new Error(`mifisr: srcFps item "${p}" is not a number`);
    return n;
  });
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

function fmtAuto(n: number): string {
  if (n === -1) return '-1';
  return fmt(n);
}
