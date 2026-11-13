// Import package validation and application.
//
// An import file is untrusted input: it arrives from a chat, a forum post or a
// file manager. Before this module existed the view only checked the top-level
// shape and then copied every key it found into the working state, so a
// package could write configuration domains it never declared (and could use
// `__proto__` to change the target object's prototype).
//
// Rules enforced here:
//   * schema must match exactly;
//   * domains must be a non-empty, duplicate-free subset of the known list;
//   * data.cloudConfig may only contain booster_config / common_config;
//   * booster content may only use keys owned by a declared domain;
//   * common content may only use game_list / support_app (declared gamelist);
//   * no __proto__ / prototype / constructor anywhere in the tree;
//   * the package has a size ceiling.
//
// The same applyImportPackage() is used for the preview and for the real
// import, so what the diff shows is what lands in the working state.

export const IMPORT_SCHEMA = 'joyose-edit.export/v1';

export const DOMAIN_IDS = ['enhance', 'render', 'gamelist', 'teg_freeze_hint', 'raw'] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

/** Keys under booster_config.params.game_booster owned by each visual domain.
 *  Shared with the export side so the two cannot drift apart. */
export const DOMAIN_GB_KEYS: Record<'enhance' | 'render', string[]> = {
  enhance: [
    'fisr_config',
    'fisr_mqs_v2',
    'mqs_enhance_list',
    'customize_game_params',
    'frc_game_params',
    'novatek_game_params',
    'novatek_extend_config',
    'novatek_black_app',
    'novatek_gex_fps_limit',
    'support_highfps_app',
  ],
  render: ['mivk_settings', 'migl_settings'],
};

/** Keys under common_config.params owned by the gamelist domain. */
export const COMMON_DOMAIN_KEYS = ['game_list', 'support_app'] as const;

export const CONFIG_NAMES = ['booster_config', 'common_config'] as const;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** 4 MB of pretty-printed JSON is already far above a real package. */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export interface ImportPackage {
  schema: string;
  exported_at: number;
  source: { backend?: string | null; paths?: unknown };
  domains: DomainId[];
  data: {
    cloudConfig: Record<string, { params: Record<string, unknown> }>;
  };
  note?: string;
}

export type ImportValidation =
  | { ok: true; pkg: ImportPackage }
  | { ok: false; err: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when any object in the tree uses a key that can mutate a prototype. */
function hasForbiddenKey(v: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbiddenKey(x, depth + 1));
  if (!isPlainObject(v)) return false;
  for (const [k, child] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k)) return true;
    if (hasForbiddenKey(child, depth + 1)) return true;
  }
  return false;
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateImportPackage(obj: unknown): ImportValidation {
  if (!isPlainObject(obj)) return { ok: false, err: '不是有效的 JSON 对象' };
  if (obj.schema !== IMPORT_SCHEMA) {
    return { ok: false, err: `schema 不匹配，期望 ${IMPORT_SCHEMA}，实际 ${String(obj.schema)}` };
  }
  let size = 0;
  try {
    size = JSON.stringify(obj).length;
  } catch {
    return { ok: false, err: '导入包无法序列化' };
  }
  if (size > MAX_IMPORT_BYTES) {
    return { ok: false, err: `导入包过大（${size} 字节，上限 ${MAX_IMPORT_BYTES}）` };
  }
  if (hasForbiddenKey(obj)) {
    return { ok: false, err: '导入包包含危险键（__proto__ / prototype / constructor）' };
  }

  const domains = obj.domains;
  if (!Array.isArray(domains) || domains.length === 0) {
    return { ok: false, err: '缺少 domains，或 domains 为空' };
  }
  if (new Set(domains).size !== domains.length) {
    return { ok: false, err: 'domains 中有重复项' };
  }
  for (const d of domains) {
    if (!DOMAIN_IDS.includes(d as DomainId)) {
      return { ok: false, err: `未知的配置域：${String(d)}` };
    }
  }
  const has = (d: DomainId) => domains.includes(d);
  if (!has('enhance') && !has('render') && !has('gamelist') && !has('raw')) {
    return { ok: false, err: 'domains 中没有可导入的配置域' };
  }

  if (!isPlainObject(obj.data)) return { ok: false, err: '缺少 data 字段' };
  const cc = obj.data.cloudConfig;
  if (!isPlainObject(cc)) return { ok: false, err: '缺少 data.cloudConfig' };

  for (const [name, body] of Object.entries(cc)) {
    if (!(CONFIG_NAMES as readonly string[]).includes(name)) {
      return { ok: false, err: `不允许导入的配置名：${name}` };
    }
    if (!isPlainObject(body)) return { ok: false, err: `${name} 不是对象` };
    const params = (body as Record<string, unknown>).params;
    if (!isPlainObject(params)) return { ok: false, err: `${name}.params 不是对象` };
    // A params array would be a different shape entirely; reject instead of
    // silently treating indices as keys.
    if (Array.isArray(params)) return { ok: false, err: `${name}.params 不能是数组` };

    if (name === 'booster_config') {
      const gb = params.game_booster;
      if (gb !== undefined && !isPlainObject(gb)) {
        return { ok: false, err: 'booster_config.params.game_booster 不是对象' };
      }
      if (gb === undefined) continue;
      const extraTop = Object.keys(params).filter((k) => k !== 'game_booster');
      if (extraTop.length) {
        return { ok: false, err: `booster_config 不支持导入的键：${extraTop.join(', ')}` };
      }
      const allowed = new Set<string>([
        ...(has('enhance') ? DOMAIN_GB_KEYS.enhance : []),
        ...(has('render') ? DOMAIN_GB_KEYS.render : []),
        ...(has('raw') ? Object.keys(gb as Record<string, unknown>) : []),
      ]);
      for (const k of Object.keys(gb as Record<string, unknown>)) {
        if (!allowed.has(k)) {
          return {
            ok: false,
            err: `未声明的配置项：game_booster.${k}（domain 只声明了 ${domains.join(', ')}）`,
          };
        }
        if (has('enhance') && !has('raw') && !DOMAIN_GB_KEYS.enhance.includes(k)
            && DOMAIN_GB_KEYS.render.includes(k) && !has('render')) {
          return { ok: false, err: `渲染项 ${k} 未在 domains 中声明` };
        }
        if (has('render') && !has('raw') && !DOMAIN_GB_KEYS.render.includes(k)
            && DOMAIN_GB_KEYS.enhance.includes(k) && !has('enhance')) {
          return { ok: false, err: `画质项 ${k} 未在 domains 中声明` };
        }
      }
    } else {
      // common_config
      const extra = Object.keys(params).filter(
        (k) => !(COMMON_DOMAIN_KEYS as readonly string[]).includes(k),
      );
      if (extra.length) {
        return { ok: false, err: `common_config 不支持导入的键：${extra.join(', ')}` };
      }
      if (!has('gamelist') && !has('raw')) {
        return { ok: false, err: 'common_config 需要声明 gamelist 域' };
      }
      for (const k of COMMON_DOMAIN_KEYS) {
        const v = params[k];
        if (v !== undefined && !isStringArray(v)) {
          return { ok: false, err: `${k} 必须是字符串数组` };
        }
      }
    }
  }

  return { ok: true, pkg: obj as unknown as ImportPackage };
}

/** Apply the package to a working-state map. Only declared domains and their
 *  own keys are written; everything else is left untouched. */
export function applyImportPackage(
  pkg: ImportPackage,
  cc: Record<string, any>,
): void {
  const has = (d: DomainId) => pkg.domains.includes(d);
  for (const [name, body] of Object.entries(pkg.data.cloudConfig)) {
    const params = body.params ?? {};
    if (!cc[name]) cc[name] = { meta: {}, params: {} };
    if (!cc[name].params) cc[name].params = {};
    const target = cc[name].params as Record<string, any>;

    if (name === 'booster_config') {
      if (!has('enhance') && !has('render') && !has('raw')) continue;
      const srcGb = (params.game_booster ?? {}) as Record<string, unknown>;
      if (!target.game_booster) target.game_booster = {};
      const allowed = new Set<string>([
        ...(has('enhance') ? DOMAIN_GB_KEYS.enhance : []),
        ...(has('render') ? DOMAIN_GB_KEYS.render : []),
        ...(has('raw') ? Object.keys(srcGb) : []),
      ]);
      for (const [k, v] of Object.entries(srcGb)) {
        if (allowed.has(k)) target.game_booster[k] = clone(v);
      }
    } else if (has('gamelist') || has('raw')) {
      for (const k of COMMON_DOMAIN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(params, k)) {
          target[k] = clone(params[k]);
        }
      }
    }
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Deep copy of just the named `cloud_config` rows, keeping their
 * `{ meta, params }` shape so `applyImportPackage` sees the same input it gets
 * on a real import.
 *
 * The import preview used to clone the whole config tree (twice) for a package
 * that touches one or two rows, and cloned `rulesByModule` that it never read.
 * Only the rows named in the package can change, so only those are copied.
 */
export function pickCloudRowsForPreview(
  source: Record<string, any> | null | undefined,
  names: string[],
): Record<string, any> {
  const out: Record<string, any> = {};
  if (!source) return out;
  for (const name of names) {
    const row = source[name];
    if (!row) continue;
    out[name] = {
      meta: row.meta ? clone(row.meta) : {},
      params: row.params !== undefined ? clone(row.params) : {},
    };
  }
  return out;
}
