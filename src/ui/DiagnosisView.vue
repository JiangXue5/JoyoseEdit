<template>
  <div class="stack">
    <PageHeader title="兼容性诊断" kicker="diagnosis"
      desc="这台设备上实际读到了什么，以及每条能力被验证到了哪一步。真机未验的路径会明确标出来，不会因为「代码里有」就算支持。">
      <button class="ghost" @click="refresh" :disabled="busy">
        <AppIcon name="refresh" /> {{ busy ? '读取中…' : '重新读取' }}
      </button>
      <button class="ghost" @click="copyReport">复制报告</button>
    </PageHeader>

    <div v-if="error" class="banner warn">
      <strong>读取不完整</strong>
      <span>{{ error }}</span>
    </div>

    <div v-if="stat?.pending" class="banner warn">
      <strong>存在未完成的双库写入</strong>
      <span>
        设备上留着一次被中断的事务记录。下一次写入前会自动回滚到写入前的状态；
        如果这条一直存在，说明回滚副本不足以证明原状，需要手动处理。
      </span>
    </div>
    <div v-else-if="recoveryNote" class="banner">
      <strong>已自动处理上次中断的写入</strong>
      <span>{{ recoveryNote }}<template v-if="recoveryAt">（{{ recoveryAt }}）</template></span>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2>系统与模块</h2>
      </div>
      <div class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">Android</span>
          <span class="kpi-value sm mono">{{ sys?.android || '未知' }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">HyperOS / MIUI</span>
          <span class="kpi-value sm mono">{{ sys?.hyperos || '未知' }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Joyose</span>
          <span class="kpi-value sm mono">{{ sys?.joyose || '未知' }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">模块</span>
          <span class="kpi-value sm mono">{{ sys?.module || '未知' }}</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>数据库</h2>
        <span class="muted tiny">摘要取前 12 位</span>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>文件</th>
            <th>状态</th>
            <th>大小</th>
            <th>SHA-256</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in dbRows" :key="row.key">
            <td class="mono">{{ row.label }}</td>
            <td>{{ row.exists ? '存在' : '缺失' }}</td>
            <td class="mono">{{ row.size }}</td>
            <td class="mono tiny">{{ row.sha }}</td>
          </tr>
        </tbody>
      </table>
      <div class="kpi-grid" style="margin-top: var(--space-3)">
        <div class="kpi">
          <span class="kpi-label">云控配置</span>
          <span class="kpi-value">{{ configCount }}</span>
          <span class="kpi-sub">cloud_config 行</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">规则模块</span>
          <span class="kpi-value">{{ ruleCount }}</span>
          <span class="kpi-sub">rules 行</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">解析告警</span>
          <span class="kpi-value">{{ state.parseIssues.length }}</span>
          <span class="kpi-sub">坏行已隔离</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>运行状态</h2>
      </div>
      <div class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">识别到的通路</span>
          <span class="kpi-value sm">{{ backendLabel }}</span>
          <span class="kpi-sub">{{ state.paths.length }} 条路径候选</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">teg 云控</span>
          <span class="kpi-value sm">{{ teg ? (teg.frozen ? '已冻结' : '未冻结') : '未知' }}</span>
          <span class="kpi-sub">{{ teg?.exists ? `版本 ${teg.pref_local_max_version}` : 'SDK 尚未初始化' }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">备份 / 历史</span>
          <span class="kpi-value">{{ stat?.backup_count ?? 0 }} / {{ stat?.history_count ?? 0 }}</span>
          <span class="kpi-sub">各保留 10 份</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">厂商开关</span>
          <span class="kpi-value sm">{{ visionLabel }}</span>
          <span class="kpi-sub">FRC / SR 属性</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>能力矩阵 <small>验证级别</small></h2>
      </div>
      <div class="hint">
        「已实机验证」= 维护者在真机上跑通并观察到效果；「已样本验证」= 只对仓库里的样本库做过
        round-trip 与单测；「未验证」= 两者都没有。样本通过不等于真机可用。
      </div>
      <table class="table" style="margin-top: var(--space-3)">
        <thead>
          <tr>
            <th>能力</th>
            <th>验证</th>
            <th>依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in CAPABILITIES" :key="c.id">
            <td>
              {{ c.label }}
              <span v-if="c.backend && c.backend === state.activeBackend" class="pill">本机路径</span>
            </td>
            <td>
              <span class="pill" :class="verifyClass(c.verification)">
                {{ VERIFICATION_LABEL[c.verification] }}
              </span>
            </td>
            <td class="muted tiny">{{ c.evidence }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, ref } from 'vue';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import * as bridge from '@/root/bridge';
import { state } from '@/state/session';
import { toast } from '@/state/toast';
import { CAPABILITIES, VERIFICATION_LABEL, type Verification } from '@/compat/matrix';

const sys = ref<bridge.SystemInfo | null>(null);
const stat = ref<bridge.StatResult | null>(null);
const digest = ref<{ smartp: string | null; teg: string | null } | null>(null);
const teg = ref<bridge.TegStatus | null>(null);
const vision = ref<bridge.VisionStatus | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

const BACKEND_LABEL: Record<string, string> = {
  mifisr: 'MIFISR（小米 17 系）',
  qualcomm: '高通 AFME / FRC',
  novatek: 'Novatek 独显',
};

const backendLabel = computed(() => {
  const b = state.activeBackend;
  return b ? (BACKEND_LABEL[b] ?? b) : '未识别';
});

const configCount = computed(() => Object.keys(state.cloudConfig).length);
const ruleCount = computed(() =>
  Object.values(state.rulesByModule).reduce((n, rows) => n + rows.length, 0),
);

/** What the helper did with the leftover transaction record, in plain words. */
const recoveryNote = computed(() => {
  const r = stat.value?.recovery;
  if (!r) return '';
  switch (r.kind) {
    case 'rolled-back': return '两份数据库已回滚到写入前的状态，可以直接继续使用。';
    case 'committed': return '两份数据库都已写入新内容，只是上次没来得及清理记录。';
    case 'discarded': return '写入还没开始就中断了，未改动任何数据库。';
    default: return '';
  }
});

const recoveryAt = computed(() => {
  const at = stat.value?.recovery?.at;
  return at ? new Date(at * 1000).toLocaleString() : '';
});

const visionLabel = computed(() => {
  if (!vision.value) return '未知';
  const frc = vision.value.frc_support === 'true';
  const sr = vision.value.sr_support === 'true';
  if (frc && sr) return '都已开启';
  if (frc) return '仅 FRC';
  if (sr) return '仅 SR';
  return '都未声明';
});

const dbRows = computed(() => {
  const s = stat.value;
  const d = digest.value;
  const one = (key: 'smartp' | 'teg', label: string) => {
    const e = s?.[key];
    return {
      key,
      label,
      exists: !!e?.exists,
      size: e?.exists ? `${(e.size ?? 0).toLocaleString()} B` : '—',
      sha: d?.[key] ? d[key]!.slice(0, 12) : (d ? '读不到' : '—'),
    };
  };
  return [one('smartp', 'SmartP.db'), one('teg', 'teg_config.db')];
});

function verifyClass(v: Verification): string {
  return `verify-${v}`;
}

async function refresh() {
  busy.value = true;
  error.value = null;
  const [s, st, dg, tg, vi] = await Promise.allSettled([
    bridge.systemInfo(),
    bridge.stat(),
    bridge.digest(),
    bridge.tegStatus(),
    bridge.visionStatus(),
  ]);
  if (s.status === 'fulfilled') sys.value = s.value;
  if (st.status === 'fulfilled') stat.value = st.value;
  if (dg.status === 'fulfilled') digest.value = { smartp: dg.value.smartp, teg: dg.value.teg };
  if (tg.status === 'fulfilled') teg.value = tg.value;
  if (vi.status === 'fulfilled') vision.value = vi.value;

  // Partial success is the normal case on an odd ROM: say which part is
  // missing instead of blanking the whole page.
  const failed: string[] = [];
  if (s.status === 'rejected') failed.push('系统信息');
  if (st.status === 'rejected') failed.push('文件状态');
  if (dg.status === 'rejected') failed.push('摘要');
  if (tg.status === 'rejected') failed.push('teg 状态');
  if (vi.status === 'rejected') failed.push('厂商开关');
  if (failed.length) {
    error.value = `以下项目读取失败：${failed.join('、')}。其余信息仍然可用。`;
  }
  busy.value = false;
}

onActivated(() => {
  void refresh();
});

function buildReport(): string {
  const lines: string[] = [];
  lines.push('JoyoseEdit 兼容性报告');
  lines.push(`时间：${new Date().toISOString()}`);
  lines.push(`模块：${sys.value?.module || '未知'}`);
  lines.push(`Android：${sys.value?.android || '未知'}　HyperOS：${sys.value?.hyperos || '未知'}`);
  lines.push(`Joyose：${sys.value?.joyose || '未知'}`);
  lines.push(`通路：${backendLabel.value}`);
  for (const r of dbRows.value) {
    lines.push(`${r.label}：${r.exists ? r.size : '缺失'} ${r.sha}`);
  }
  lines.push(`云控配置 ${configCount.value} 行 / 规则 ${ruleCount.value} 行 / 解析告警 ${state.parseIssues.length}`);
  lines.push(`teg：${teg.value ? (teg.value.frozen ? '已冻结' : '未冻结') : '未知'}　备份 ${stat.value?.backup_count ?? 0} / 历史 ${stat.value?.history_count ?? 0}`);
  lines.push(`厂商开关：${visionLabel.value}`);
  if (stat.value?.pending) lines.push('未完成写入：存在残留事务记录');
  else if (recoveryNote.value) lines.push(`上次中断的写入：${recoveryNote.value}`);
  lines.push('能力矩阵：');
  for (const c of CAPABILITIES) {
    lines.push(`  - ${c.label}：${VERIFICATION_LABEL[c.verification]}（${c.evidence}）`);
  }
  return lines.join('\n');
}

async function copyReport() {
  const body = buildReport();
  try {
    await navigator.clipboard.writeText(body);
    toast.success('已复制诊断报告', `${body.length} 字符`);
  } catch {
    toast.warn('复制失败', '当前 WebView 不允许写剪贴板，可手动截图本页');
  }
}
</script>

<style scoped>
.pill.verify-device {
  color: var(--ok, #2e7d32);
  border-color: currentColor;
}
.pill.verify-sample {
  color: var(--warn, #b26a00);
  border-color: currentColor;
}
.pill.verify-untested {
  color: var(--muted, #888);
}
</style>
