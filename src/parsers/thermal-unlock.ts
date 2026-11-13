// "去除插帧温度限制" feature — lift every thermal-threshold group in the
// booster tree to ~90 °C so FI/SR/MIFISR never down-shifts due to heat.
//
// Joyose encodes thermal down-shift thresholds as short runs of delimited
// numbers between 30..60 °C, e.g. novatek `...#45#43#43#41...` (`#`-fields
// inside `_`-separated sets), frc `..._47_46.5_43_41` (all `_`), mifisr
// `..._45,60#47#45#44#42` (`#`).
//
// IMPORTANT (user correction): in the complex multi-block novatek format a
// temperature run may be immediately followed by the NEXT block's FPS head
// using `&`, e.g. `45#43#41.5#40&41#120` means:
//     temps 45, 43, 41.5, 40   &   next-block minFps=41 # targetFps=120
// So `40&41` is NOT a temperature combo — `&` separates the T4 temperature
// from the next block's minFps. The lift must only touch the part BEFORE `&`;
// the `&41#120` FPS head must stay untouched.
//
// Group membership rules:
//   · ≥2 CONSECUTIVE temperature atoms joined by the SAME delimiter (#/_).
//   · `_` and `|` are section boundaries — a group never crosses them.
//   · A 3-digit number (120/144/…) breaks a group, so FPS heads stay safe.
//
// The lift maps the tens digit 3..5 -> 9 within the temperature part:
//  45→95, 43→93, 41.5→91.5, 40&41→90&41 (41 preserved), 46.7→96.7.

// String.raw: in a normal string literal `\.` collapses to `.`, which turned
// the decimal point into "any character" and matched things like `451`.
const TEMP_ATOM = String.raw`(?:[3-5][0-9](?:\.[0-9])?)`;
const ATOM_RE = new RegExp(`^${TEMP_ATOM}$`);

/** Fields that are KNOWN to carry temperature runs. Everything else is only
 *  previewed: "lift every number that looks like 30–59 somewhere in the tree"
 *  would rewrite unknown cloud fields the day Xiaomi reuses the same shape for
 *  something else. Paths are relative to `game_booster`. */
export const THERMAL_FIELDS: readonly string[][] = [
  ['novatek_game_params'],
  ['novatek_extend_config', 'novatek_non_playing_config'],
  ['novatek_extend_config', 'novatek_game_params_ext'],
  ['frc_game_params'],
  ['customize_game_params', 'game_mifisr_config'],
];

/** True when a string's location is inside one of the known thermal carriers.
 *  Tolerant of the `game_booster` wrapper and of element properties such as
 *  `frc_game_params[].raw`. */
export function isKnownThermalPath(segments: string[]): boolean {
  const clean = segments.filter((s) => !/^\[\d+\]$/.test(s));
  return THERMAL_FIELDS.some((p) => {
    if (clean.length < p.length) return false;
    // The carrier may sit at any depth inside `params` (with or without the
    // `game_booster` wrapper) and the string may be a property of the array
    // element (`frc_game_params[].raw`). Match the field path as a contiguous
    // run rather than requiring it at the exact tail.
    for (let off = 0; off + p.length <= clean.length; off++) {
      if (p.every((k, i) => k === clean[off + i])) return true;
    }
    return false;
  });
}

function isTempAtom(t: string): boolean {
  return ATOM_RE.test(t);
}

/** Lift the tens digit of a temperature atom. `splitParts()` already treats
 *  `&` as a delimiter, so an atom never carries the next block's FPS head —
 *  the old `&` handling here was unreachable. */
function liftAtom(t: string): string {
  return t.replace(/[3-5](?=\d)/g, () => '9');
}

/** Display helper (kept for callers that print a temp atom). */
export function tempDisplay(t: string): string {
  return t;
}

interface Part {
  /** Delimiter immediately before this token; '' at string start. */
  lead: string;
  tok: string;
  /** Character offset within the string. */
  offset: number;
}

function splitParts(s: string): Part[] {
  const parts: Part[] = [];
  let lead = '';
  let cur = '';
  let curStart = 0;
  const flush = () => {
    if (cur !== '') parts.push({ lead, tok: cur, offset: curStart });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '#' || c === '_' || c === '|' || c === '&') {
      flush();
      lead = c;
      cur = '';
      curStart = i + 1;
    } else {
      if (cur === '') curStart = i;
      cur += c;
    }
  }
  flush();
  return parts;
}

export interface TempGroup {
  /** Char offsets (token-wise) within the string. */
  start: number;
  end: number;
  /** The single delimiter joining the group's atoms. */
  delim: string;
  /** Temperature atoms in order (may contain `&` FPS heads). */
  temps: string[];
  /** Raw slice (includes the in-group delimiters). */
  raw: string;
}

/** Find temperature groups. Requires ≥2 consecutive atoms joined by the SAME
 *  delimiter, never crossing `_`/`|` section boundaries. */
export function findTempGroups(s: string): TempGroup[] {
  const parts = splitParts(s);
  const out: TempGroup[] = [];
  let i = 0;
  while (i < parts.length) {
    if (isTempAtom(parts[i].tok)) {
      const run = [parts[i]];
      let j = i;
      const delimBase = i + 1 < parts.length ? parts[i + 1].lead : '';
      while (j + 1 < parts.length && isTempAtom(parts[j + 1].tok)) {
        if (parts[j + 1].lead !== delimBase) break;
        run.push(parts[j + 1]);
        j++;
      }
      if (run.length >= 2) {
        const start = run[0].offset;
        const end = run[run.length - 1].offset + run[run.length - 1].tok.length;
        out.push({
          start,
          end,
          delim: delimBase,
          temps: run.map((p) => p.tok),
          raw: s.slice(start, end),
        });
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Replace every temperature group in `s` with lifted (9x) temperatures.
 *  Returns the new string and how many groups were hit. Safe: FPS numbers
 *  (next-set minFps after `&`, targetFps 120/144) are never touched. */
export function liftTempGroupsInString(s: string): { out: string; count: number } {
  const groups = findTempGroups(s);
  if (groups.length === 0) return { out: s, count: 0 };
  let out = '';
  let last = 0;
  let count = 0;
  for (const g of groups) {
    out += s.slice(last, g.start);
    const atoms = g.raw.split(g.delim);
    const liftedRaw = atoms.map((a) => liftAtom(a)).join(g.delim);
    if (liftedRaw !== g.raw) count++;
    out += liftedRaw;
    last = g.end;
  }
  out += s.slice(last);
  return { out, count };
}

export interface ThermalScan {
  /** String values that contain at least one temperature group. */
  fieldsAffected: number;
  /** Total temperature groups across those values (same unit as apply). */
  groupsTotal: number;
  /** Field-key (last property name) → number of matching strings. */
  byField: Record<string, number>;
  /** Values OUTSIDE the known thermal fields. Previewed, never rewritten. */
  unknownFields: number;
  /** One example per field for the UI preview. */
  examples: { field: string; path: string; temps: string[]; known: boolean }[];
}

export interface ThermalUnlockResult {
  fieldsAffected: number;
  groupsTotal: number;
  /** field key → number of temperature groups lifted. */
  liftedByField: Record<string, number>;
  /** Whether anything changed. */
  changed: boolean;
}

interface Hit {
  path: string[];
  temps: string[];
  groups: number;
  known: boolean;
}

function collectStringHits(node: unknown, pathArr: string[], out: Hit[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectStringHits(node[i], [...pathArr, `[${i}]`], out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectStringHits(v, [...pathArr, k], out);
    }
    return;
  }
  if (typeof node === 'string') {
    const groups = findTempGroups(node);
    if (groups.length > 0) {
      out.push({
        path: pathArr,
        temps: groups.flatMap((g) => g.temps.map((t) => tempDisplay(t))),
        groups: groups.length,
        known: isKnownThermalPath(pathArr),
      });
    }
  }
}

/** Inspect a parsed booster_config.params tree: count temperature groups.
 *  Pure, does not mutate. */
export function scanThermalUnlock(params: unknown): ThermalScan {
  const hits: Hit[] = [];
  collectStringHits(params, [], hits);

  const byField: Record<string, number> = {};
  const examples: ThermalScan['examples'] = [];
  let groupsTotal = 0;
  let unknownFields = 0;
  for (const h of hits) {
    groupsTotal += h.groups;
    if (!h.known) unknownFields++;
    const segs = h.path.filter((s) => !/^\[\d+\]$/.test(s));
    const field = segs[segs.length - 1] ?? '';
    byField[field] = (byField[field] ?? 0) + 1;
    if (examples.length < 8) {
      examples.push({
        field,
        path: h.path.join('.'),
        temps: h.temps.slice(0, 8),
        known: h.known,
      });
    }
  }
  return {
    fieldsAffected: hits.length,
    groupsTotal,
    byField,
    unknownFields,
    examples,
  };
}

/** Apply "去除插帧温度限制" in place: lift every temperature group in every
 *  string value of the booster tree to ~9x. Idempotent. Mutates the reactive
 *  object in place. Array elements inherit the hosting property name. */
export function applyThermalUnlock(params: unknown): ThermalUnlockResult {
  const liftedByField: Record<string, number> = {};
  let groupsTotal = 0;
  let fieldsAffected = 0;

  // `pathArr` is relative to `game_booster`, mirroring scanThermalUnlock().
  const walk = (node: unknown, pathArr: string[]): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const p = pathArr.length ? pathArr : [];
        const el = node[i];
        if (typeof el === 'string') {
          // Only the known thermal carriers are rewritten. An unknown string
          // that happens to contain 45#43#41 is left untouched.
          if (!isKnownThermalPath(p)) continue;
          const { out, count } = liftTempGroupsInString(el);
          if (count > 0) {
            node[i] = out;
            groupsTotal += count;
            fieldsAffected++;
            const field = p[p.length - 1] ?? '';
            liftedByField[field] = (liftedByField[field] ?? 0) + count;
          }
        } else if (el && typeof el === 'object') {
          walk(el, p);
        }
      }
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const p = [...pathArr, k];
        if (typeof obj[k] === 'string') {
          if (!isKnownThermalPath(p)) continue;
          const { out, count } = liftTempGroupsInString(obj[k]);
          if (count > 0) {
            obj[k] = out;
            groupsTotal += count;
            fieldsAffected++;
            liftedByField[k] = (liftedByField[k] ?? 0) + count;
          }
        } else if (obj[k] && typeof obj[k] === 'object') {
          walk(obj[k], p);
        }
      }
    }
  };

  // Callers pass `game_booster`, so paths start empty.
  walk(params, []);

  return {
    fieldsAffected,
    groupsTotal,
    liftedByField,
    changed: groupsTotal > 0,
  };
}
/** Distinct temperature groups that `applyThermalUnlock()` would actually lift,
 *  with the value each becomes. Unknown fields are excluded on purpose, so the
 *  preview cannot show a rewrite that will not happen. */export function knownTempGroups(params: unknown): { raw: string; lifted: string }[] {
  const seen = new Map<string, string>();
  const walk = (node: unknown, pathArr: string[]): void => {
    if (Array.isArray(node)) {
      for (const el of node) walk(el, pathArr);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, [...pathArr, k]);
      }
      return;
    }
    if (typeof node !== 'string' || !isKnownThermalPath(pathArr)) return;
    for (const g of findTempGroups(node)) {
      if (!seen.has(g.raw)) seen.set(g.raw, liftTempGroupsInString(g.raw).out);
    }
  };
  walk(params, []);
  return [...seen.entries()].map(([raw, lifted]) => ({ raw, lifted }));
}

export interface ThermalChange {
  /** Last property name of the carrier, e.g. `fps_threshold`. */
  field: string;
  /** Full path from the booster params root, for disambiguation. */
  path: string;
  before: string;
  after: string;
}

/** Every string the lift would rewrite, with the field that owns it.
 *
 *  `knownTempGroups()` answers "what values change"; this answers "where".
 *  The confirmation dialog needs the second one: two different fields can
 *  carry the same `45#43#41`, and a user who sees only the values cannot tell
 *  whether the change lands in the game they meant.
 *
 *  Pure: works on a deep copy, never touches the caller's tree. */
export function previewThermalUnlock(params: unknown): ThermalChange[] {
  if (!params || typeof params !== 'object') return [];
  const clone = JSON.parse(JSON.stringify(params)) as unknown;
  const result = applyThermalUnlock(clone);
  if (!result.changed) return [];

  const before: { path: string; value: string }[] = [];
  const after: { path: string; value: string }[] = [];
  flattenStrings(params, [], before);
  flattenStrings(clone, [], after);

  const rows: ThermalChange[] = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    if (before[i].path !== after[i].path) break; // shapes diverged: stop, do not guess
    if (before[i].value === after[i].value) continue;
    const segs = before[i].path.split('.').filter((s) => !/^\[\d+\]$/.test(s));
    rows.push({
      field: segs[segs.length - 1] ?? '',
      path: before[i].path,
      before: before[i].value,
      after: after[i].value,
    });
  }
  return rows;
}

function flattenStrings(
  node: unknown,
  pathArr: string[],
  out: { path: string; value: string }[],
): void {
  if (Array.isArray(node)) {
    node.forEach((el, i) => flattenStrings(el, [...pathArr, `[${i}]`], out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flattenStrings(v, [...pathArr, k], out);
    }
    return;
  }
  if (typeof node === 'string') out.push({ path: pathArr.join('.'), value: node });
}
