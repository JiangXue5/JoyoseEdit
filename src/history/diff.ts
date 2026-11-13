// A compact JSON diff used by the edit-history view.
//
// Goals:
//  * Stable, dependency-free, small enough to inline in the bundle.
//  * Safe to apply: a delta produced from (before → after) must reproduce
//    `after` when applied to `before`, or fail loudly.
//
// Output: a flat list of change records:
//   { path, kind: 'added' | 'removed' | 'changed', before?, after? }
//
// `path` is an ARRAY of segments, not a dot-joined string:
//   * string  — object key (may itself contain dots, which is why the string
//               form was never safe);
//   * number  — array index;
//   * { byKey, value } — an element identified by a stable key, not by its
//               position. Array insertion/deletion shifts every index after it,
//               so index-based deltas used to mis-apply on replay.
//
// Records written by older versions have a string path; `normalizePath()` reads
// them, so existing history files keep working.

export type DiffKind = 'added' | 'removed' | 'changed';

/** An element of an array, identified by a key that is unique within it. */
export interface KeyedSegment {
  byKey: string;
  value: string | number;
}

export type PathSegment = string | number | KeyedSegment;

export interface DiffRecord {
  path: PathSegment[];
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
  /** For keyed array add/remove: the position in the source array. Needed to
   *  replay an insertion at the right place — a key alone says which element,
   *  not where it goes. */
  index?: number;
}

/** Shape found in history files written before the structured-path change. */
export interface LegacyDiffRecord {
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
}

export interface DiffOptions {
  /** Maximum recursion depth — safety-net against cyclic inputs. */
  maxDepth?: number;
}

const DEFAULT_OPTS: Required<DiffOptions> = {
  maxDepth: 200,
};

export function diff(
  before: unknown,
  after: unknown,
  options: DiffOptions = {},
): DiffRecord[] {
  const opts = { ...DEFAULT_OPTS, ...options };
  const records: DiffRecord[] = [];
  walk(before, after, [], 0, opts, records);
  return records;
}

function walk(
  a: unknown,
  b: unknown,
  path: PathSegment[],
  depth: number,
  opts: Required<DiffOptions>,
  out: DiffRecord[],
): void {
  if (depth > opts.maxDepth) return;
  if (a === b) return;
  if (isPrimitive(a) || isPrimitive(b)) {
    if (!deepEqual(a, b)) {
      out.push({ path, kind: 'changed', before: a, after: b });
    }
    return;
  }
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) {
    out.push({ path, kind: 'changed', before: a, after: b });
    return;
  }
  if (aIsArr && bIsArr) {
    diffArray(a, b, path, depth, opts, out);
    return;
  }
  // objects
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    const p = [...path, k];
    const hasA = Object.prototype.hasOwnProperty.call(ao, k);
    const hasB = Object.prototype.hasOwnProperty.call(bo, k);
    if (!hasA) out.push({ path: p, kind: 'added', after: bo[k] });
    else if (!hasB) out.push({ path: p, kind: 'removed', before: ao[k] });
    else walk(ao[k], bo[k], p, depth + 1, opts, out);
  }
}

/** Keys that identify an element well enough to match across two arrays.
 *  Ordered by specificity: an object with a real `id` should not be matched by
 *  its display `name`. */
const ID_CANDIDATES = ['id', 'key', 'pkg', 'package', 'name', 'feature'];

function isKeyable(v: unknown): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

function uniqueByKey(arr: unknown[], key: string): boolean {
  const seen = new Set<string>();
  for (const el of arr) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
    const v = (el as Record<string, unknown>)[key];
    if (!isKeyable(v)) return false;
    const s = String(v);
    if (seen.has(s)) return false;
    seen.add(s);
  }
  return true;
}

/** The first key that is present, keyable and unique in BOTH arrays, or null
 *  when the arrays have no usable identity and must be replaced wholesale. */
export function commonIdKey(a: unknown[], b: unknown[]): string | null {
  if (!a.length && !b.length) return null;
  for (const k of ID_CANDIDATES) {
    if (a.length && !uniqueByKey(a, k)) continue;
    if (b.length && !uniqueByKey(b, k)) continue;
    if ((a.length && uniqueByKey(a, k)) || (b.length && uniqueByKey(b, k))) return k;
  }
  return null;
}

function diffArray(
  a: unknown[],
  b: unknown[],
  path: PathSegment[],
  depth: number,
  opts: Required<DiffOptions>,
  out: DiffRecord[],
): void {
  if (deepEqual(a, b)) return;

  const key = commonIdKey(a, b);
  if (!key) {
    // No stable identity: replace the array as one record. Per-index records
    // would mis-apply the moment an element is inserted or removed.
    out.push({ path, kind: 'changed', before: a, after: b });
    return;
  }

  const start = out.length;
  const bByKey = new Map(b.map((el) => [String((el as any)[key]), el]));
  const aByKey = new Map(a.map((el) => [String((el as any)[key]), el]));

  a.forEach((el, i) => {
    const k = String((el as any)[key]);
    const other = bByKey.get(k);
    const seg: PathSegment[] = [...path, { byKey: key, value: (el as any)[key] }];
    if (other === undefined) {
      out.push({ path: seg, kind: 'removed', before: el, index: i });
    } else {
      walk(el, other, seg, depth + 1, opts, out);
    }
  });
  b.forEach((el, i) => {
    const k = String((el as any)[key]);
    if (!aByKey.has(k)) {
      out.push({
        path: [...path, { byKey: key, value: (el as any)[key] }],
        kind: 'added',
        after: el,
        index: i,
      });
    }
  });

  // Same elements, different order: no field-level record was produced, but the
  // arrays are not equal. Emit one whole-array record so a replay cannot land
  // on the wrong order (order is meaningful for policy lists).
  if (out.length === start) {
    out.push({ path, kind: 'changed', before: a, after: b });
  }
}

function isPrimitive(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'boolean' ||
    typeof v === 'number' ||
    typeof v === 'string' ||
    typeof v === 'undefined'
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPrimitive(a) || isPrimitive(b)) return false;
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Parse a LEGACY dot path into structured segments.
 *  Object keys are strings; array indices are numbers. Kept for reading history
 *  files written before paths became arrays. */
export function parsePath(path: string): PathSegment[] {
  if (!path || path === '/') return [];
  const segs: PathSegment[] = [];
  for (const part of path.split('.')) {
    const m = /^([^\[]*)((?:\[\d+\])*)$/.exec(part);
    const name = m?.[1] ?? part;
    const brackets = m?.[2] ?? '';
    if (name) segs.push(name);
    for (const im of brackets.matchAll(/\[(\d+)\]/g)) segs.push(Number(im[1]));
  }
  return segs;
}

/** Accept both the current array form and the legacy string form. */
export function normalizePath(path: PathSegment[] | string): PathSegment[] {
  return Array.isArray(path) ? path : parsePath(path);
}

/** Render a path for display only — never parse this back. */
export function formatPath(path: PathSegment[] | string): string {
  const segs = normalizePath(path);
  let out = '';
  for (const s of segs) {
    if (typeof s === 'number') {
      out += `[${s}]`;
    } else if (typeof s === 'string') {
      out += out ? `.${s}` : s;
    } else {
      out += `[${s.byKey}=${String(s.value)}]`;
    }
  }
  return out || '/';
}

export interface ApplyReport<T> {
  value: T;
  /** Paths that could not be resolved. A non-empty list means the snapshot does
   *  not match the delta's base — the caller must not pretend the replay was
   *  complete (that is how a partial rollback used to look like a success). */
  missing: PathSegment[][];
}

/** Resolve one segment against a container. */
function step(container: any, seg: PathSegment): unknown {
  if (container == null) return undefined;
  if (typeof seg === 'object') {
    if (!Array.isArray(container)) return undefined;
    const idx = container.findIndex(
      (el: any) => el && String(el[seg.byKey]) === String(seg.value),
    );
    return idx < 0 ? undefined : container[idx];
  }
  return container[seg];
}

/** Apply a forward delta (produced by `diff(before, after)`) to a clone of
 *  `snap` and report which paths could not be resolved. Deltas are applied in
 *  REVERSE order so trailing array operations compose correctly. */
export function applyDeltaReport<T>(snap: T, delta: DiffRecord[]): ApplyReport<T> {
  const out = JSON.parse(JSON.stringify(snap)) as T;
  const missing: PathSegment[][] = [];
  for (let i = delta.length - 1; i >= 0; i--) {
    const d = delta[i];
    const segs = normalizePath(d.path);
    if (segs.length === 0) {
      missing.push(segs);
      continue;
    }
    let parent: any = out;
    let ok = true;
    for (const s of segs.slice(0, -1)) {
      const next = step(parent, s);
      if (next === undefined) {
        ok = false;
        break;
      }
      parent = next;
    }
    if (!ok || parent == null) {
      missing.push(segs);
      continue;
    }
    const last = segs[segs.length - 1];

    if (typeof last === 'object') {
      // Keyed element: locate it now, because its position may have moved.
      if (!Array.isArray(parent)) {
        missing.push(segs);
        continue;
      }
      if (d.kind === 'added') {
        // The element does not exist yet: insert at the recorded position.
        const at =
          typeof d.index === 'number'
            ? Math.max(0, Math.min(d.index, parent.length))
            : parent.length;
        parent.splice(at, 0, d.after);
        continue;
      }
      const idx = parent.findIndex(
        (el: any) => el && String(el[last.byKey]) === String(last.value),
      );
      if (idx < 0) {
        missing.push(segs);
        continue;
      }
      if (d.kind === 'removed') parent.splice(idx, 1);
      else parent[idx] = d.after;
      continue;
    }

    if (Array.isArray(parent) && typeof last === 'number') {
      if (d.kind === 'removed') parent.splice(last, 1);
      else parent[last] = d.after;
    } else if (d.kind === 'removed') {
      delete parent[last];
    } else {
      parent[last] = d.after;
    }
  }
  return { value: out, missing };
}

/** Backwards-compatible form: returns the value and drops the report. Callers
 *  that replay history should use `applyDeltaReport()` and surface `missing`. */
export function applyDelta<T>(snap: T, delta: DiffRecord[]): T {
  return applyDeltaReport(snap, delta).value;
}

/** Invert a delta: applying `invertDelta(d)` after applying `d` yields the
 *  original state. DiffRecord is invertible by construction (added ↔ removed,
 *  changed swaps before/after). */
export function invertDelta(delta: DiffRecord[]): DiffRecord[] {
  return delta.map((d) => {
    switch (d.kind) {
      case 'added':
        return {
          path: normalizePath(d.path),
          kind: 'removed' as const,
          before: d.after,
          index: d.index,
        };
      case 'removed':
        return {
          path: normalizePath(d.path),
          kind: 'added' as const,
          after: d.before,
          index: d.index,
        };
      case 'changed':
        return {
          path: normalizePath(d.path),
          kind: 'changed' as const,
          before: d.after,
          after: d.before,
        };
    }
  });
}

/** Abbreviate a DiffRecord for compact list display. Leaves long values
 *  truncated with an ellipsis. */
export function summarizeRecord(r: DiffRecord, maxLen = 60): string {
  const render = (v: unknown) => {
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return s && s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : (s ?? 'undefined');
  };
  const p = formatPath(r.path);
  switch (r.kind) {
    case 'added':
      return `+ ${p} = ${render(r.after)}`;
    case 'removed':
      return `- ${p} (was ${render(r.before)})`;
    case 'changed':
      return `~ ${p}: ${render(r.before)} → ${render(r.after)}`;
  }
}
