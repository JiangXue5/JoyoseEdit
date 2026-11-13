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
 * Every known key is materialised. `JSON.stringify` drops `undefined`, so an
 * envelope that came in missing (or with an empty) `config_name` /
 * `group_name` used to be written back as `{ version, params }` only — Joyose
 * then could not match the mirror back to its module.
 *
 * Unknown keys are carried over untouched: Joyose's own writer may add fields
 * we have never seen, and rebuilding the object from a fixed key list would
 * silently drop them on the next save. The known keys are the only ones we
 * are allowed to change.
 *
 * `fallbackName` supplies config_name / group_name when the source envelope
 * has neither (a brand-new mirror row). */
export function refreshEnvelope<T>(
  envelope: RuleEnvelope<unknown> | null | undefined,
  params: T,
  version?: number,
  fallbackName?: string,
): RuleEnvelope<T> & Record<string, unknown> {
  const base: Record<string, unknown> = envelope ? { ...envelope } : {};
  const name =
    typeof base.config_name === 'string' && base.config_name !== ''
      ? (base.config_name as string)
      : fallbackName ?? (envelope ? '' : '__unknown__');
  const group =
    typeof base.group_name === 'string' && base.group_name !== ''
      ? (base.group_name as string)
      : name;
  const outVersion =
    typeof version === 'number'
      ? version
      : typeof base.version === 'number'
        ? base.version
        : 0;
  return {
    ...base,
    config_name: name,
    group_name: group,
    enable: typeof base.enable === 'boolean' ? base.enable : true,
    version: outVersion,
    with_model: typeof base.with_model === 'boolean' ? base.with_model : false,
    params,
  };
}
