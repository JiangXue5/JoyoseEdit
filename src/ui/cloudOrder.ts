/** 云控配置的展示顺序。
 *
 *  `state.cloudConfig` 的键序取决于后端拼 JSON 时谁先被读到，同一份数据换个
 *  机型就可能翻过来；页面上又有多处并排展示这两块配置，顺序飘一次就变成
 *  「上面一个样、下面一个样」，对照着读很费劲。这里把顺序定死：
 *  booster_config 在上、common_config 在下，与「来源与写入」的选择项一致。
 */

const CFG_ORDER = ['booster_config', 'common_config'];

export interface CloudCfgRow {
  name: string;
  cfg: Record<string, any>;
}

/** 已知配置按固定次序在前，其它（将来新增的）保持后端给的相对次序跟在后头。 */
export function orderedCloudConfig(cc: Record<string, any>): CloudCfgRow[] {
  const rank = (n: string) => {
    const i = CFG_ORDER.indexOf(n);
    return i < 0 ? CFG_ORDER.length : i;
  };
  return Object.entries(cc)
    .map(([name, cfg]) => ({ name, cfg: cfg as Record<string, any> }))
    .sort((a, b) => rank(a.name) - rank(b.name));
}
