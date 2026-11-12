// teg_config.rules.rule_content wraps a cloud_config row's `params` in an
// envelope. The shape is stable across samples we inspected — Joyose treats
// this mirror as a fallback when cloud_config is missing, so we need to keep
// it in perfect sync with cloud_config whenever we mutate params / version.

export interface RuleEnvelope<T = unknown> {
  config_name: string;
  group_name: string;
  enable: boolean;
  version: number;
  with_model: boolean;
  params: T;
}

export function buildRuleEnvelope<T>(
  configName: string,
  params: T,
  version: number,
): RuleEnvelope<T> {
  return {
    config_name: configName,
    group_name: configName,
    enable: true,
    version,
    with_model: false,
    params,
  };
}

/** Given a freshly parsed `rule_content` envelope, substitute fresh `params`
 * (and optionally bump `version`). Returns a new object; the original stays
 * untouched so diffs remain meaningful.
 *
 * Every key is materialised. `JSON.stringify` drops `undefined`, so an
 * envelope that came in missing (or with an empty) `config_name` /
 * `group_name` used to be written back as `{ version, params }` only — Joyose
 * then could not match the mirror back to its module.
 *
 * `fallbackName` supplies config_name / group_name when the source envelope
 * has neither (a brand-new mirror row). */
export function refreshEnvelope<T>(
  envelope: RuleEnvelope<unknown> | null | undefined,
  params: T,
  version?: number,
  fallbackName?: string,
): RuleEnvelope<T> {
  const base = envelope
    ? { ...envelope }
    : buildRuleEnvelope(fallbackName ?? '__unknown__', params, version ?? 0);
  const name =
    typeof base.config_name === 'string' && base.config_name !== ''
      ? base.config_name
      : fallbackName ?? '';
  const group =
    typeof base.group_name === 'string' && base.group_name !== ''
      ? base.group_name
      : name;
  return {
    config_name: name,
    group_name: group,
    enable: typeof base.enable === 'boolean' ? base.enable : true,
    version: typeof version === 'number' ? version : base.version,
    with_model: typeof base.with_model === 'boolean' ? base.with_model : false,
    params,
  };
}
