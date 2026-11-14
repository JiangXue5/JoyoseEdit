// What has actually been checked, and how.
//
// The audit's last item is a matrix that tells a user which promises hold on
// their phone. It is deliberately a hand-written table rather than something
// derived from the running device: the question "has this been verified on
// real hardware?" cannot be answered by the hardware. The only honest sources
// are the sample corpus and the devices the maintainer has actually run.
//
// Keep this in sync with the table in README.md ("实测情况"). If a path is
// upgraded from samples to hardware, change it here *and* in the README in the
// same commit — a page that overstates verification is worse than no page.

export type Verification = 'device' | 'sample' | 'untested';

export interface Capability {
  id: string;
  label: string;
  /** Best evidence available for this path. */
  verification: Verification;
  /** What that evidence is, in one line. */
  evidence: string;
  /** Backend this path belongs to, when it is backend-specific. */
  backend?: 'mifisr' | 'qualcomm' | 'novatek';
}

export const VERIFICATION_LABEL: Record<Verification, string> = {
  device: '已实机验证',
  sample: '已样本验证',
  untested: '未验证',
};

export const CAPABILITIES: Capability[] = [
  {
    id: 'mifisr',
    label: 'MIFISR 插帧 / 超分',
    verification: 'device',
    evidence: 'Xiaomi 17 Pro Max 实机；其余机型仅样本',
    backend: 'mifisr',
  },
  {
    id: 'qualcomm',
    label: '高通 AFME / FRC',
    verification: 'sample',
    evidence: 'Xiaomi 15 / 15 Pro 样本 round-trip，未上机',
    backend: 'qualcomm',
  },
  {
    id: 'novatek',
    label: 'Novatek NT# 策略',
    verification: 'sample',
    evidence: 'Redmi K90 Pro Max 样本 round-trip，未上机',
    backend: 'novatek',
  },
  {
    id: 'thermal',
    label: '温控阈值抬升',
    verification: 'sample',
    evidence: '五个样本库的字段扫描 + 未知字段不动',
  },
  {
    id: 'fpslock',
    label: '去除锁帧',
    verification: 'sample',
    evidence: '前缀匹配单测；容器外同名键不误删',
  },
  {
    id: 'write',
    label: '数据库写入事务',
    verification: 'sample',
    evidence: '假 am/cp/mv 注入十种失败 + 属主/权限继承 + 双库同写同弃；真机 SELinux context 未验',
  },
  {
    id: 'history',
    label: '历史回滚',
    verification: 'sample',
    evidence: 'delta 链单测（含重排 / 多次插入往返）+ 缺基准摘要即拒绝；真机回滚未验',
  },
  {
    id: 'freeze',
    label: 'teg 云控冻结',
    verification: 'sample',
    evidence: '原值保存/回读单测；真机云端下发拦截未验',
  },
  {
    id: 'import',
    label: '配置导入',
    verification: 'sample',
    evidence: '域白名单与原型污染单测；未用真实导出包做过跨机型迁移',
  },
];
