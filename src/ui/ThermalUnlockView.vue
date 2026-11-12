<template>
  <div class="stack">
    <PageHeader title="温度解锁" kicker="thermal lift"
      desc="Joyose 的插帧 / 超分配置里写死了温度降档阈值（常见 45#43#43#41）。这里把温度段整体抬到 9x，帧率数字不动。">
      <button class="ghost" @click="rescan" :disabled="!hasBooster">
        <AppIcon name="refresh" /> 重新扫描
      </button>
    </PageHeader>

    <div v-if="!hasBooster" class="banner warn">
      <strong>未读取到 booster_config</strong>
      <span>先在概览页点「刷新」拉取本机云控。如果 SmartP 里确实没有这条配置，可在概览页开启 teg 兜底。</span>
    </div>

    <template v-else>
      <section class="panel">
        <div class="panel-header">
          <h2>扫描结果 <small>只认连续温度组</small></h2>
        </div>

        <div class="kpi-grid">
          <div class="kpi">
            <span class="kpi-label">命中字段</span>
            <span class="kpi-value" :class="scan.fieldsAffected ? 'warn-text' : 'ok-text'">
              {{ scan.fieldsAffected }}
            </span>
            <span class="kpi-sub">含温度组的字符串</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">温度组</span>
            <span class="kpi-value">{{ scan.groupsTotal }}</span>
            <span class="kpi-sub">可抬升的组数</span>
          </div>
        </div>

        <div v-if="!scan.fieldsAffected" class="hint" style="margin-top: 12px">
          云控里没有可识别的温度组 —— 要么已处理过，要么这套配置不含插帧温控。
        </div>
        <div v-else class="hint mono" style="margin-top: 12px">{{ fieldSummary }}</div>
      </section>

      <section v-if="uniqueGroups.length" class="panel">
        <div class="panel-header">
          <h2>本机温度组 <small>去重预览</small></h2>
        </div>
        <div class="group-list">
          <div v-for="(g, i) in uniqueGroups" :key="i" class="group-chip mono">
            <span class="group-raw">{{ g.raw }}</span>
            <span class="group-arrow">→</span>
            <span class="group-out mono">{{ g.lifted }}</span>
          </div>
        </div>
        <p class="hint" style="margin-top: 10px">
          显示前 12 组。规则：只改由 <code class="mono">#</code> 或 <code class="mono">_</code>
          连续连接的温度原子，<code class="mono">&amp;</code> 之后的下一段 minFps 与 120/144 这类三位帧率一律不动。
        </p>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>执行</h2>
        </div>
        <div class="banner warn">
          <strong>硬件风险</strong>
          <span>温度阈值被抬到 90 ℃ 以上后，设备基本不会因发热而降档。这不解除系统温控，但会显著推迟降帧；
            长时间重载游戏请自行留意机身温度与续航。</span>
        </div>
        <div class="btn-row" style="margin-top: 14px">
          <button class="primary" @click="doApply" :disabled="state.loading || !scan.fieldsAffected">
            {{ scan.fieldsAffected ? `抬升全部 ${scan.groupsTotal} 组温度` : '（未发现温度限制）' }}
          </button>
        </div>
        <p class="hint" style="margin-top: 10px">
          点击后只在内存中生效，需要在底部提交条点「提交到设备」写入。提交前会自动备份，可在「编辑历史」回滚。
        </p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state, markDirty, sourceUsable } from '@/state/session';
import { toast } from '@/state/toast';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import {
  scanThermalUnlock,
  applyThermalUnlock,
  findTempGroups,
  liftTempGroupsInString,
  type ThermalScan,
} from '@/parsers/thermal-unlock';

const boosterSource = computed(() => state.cloudConfig.booster_config?.params ?? null);
const hasBooster = computed(() => sourceUsable('booster_config'));

const scan = computed<ThermalScan>(() =>
  boosterSource.value !== null ? scanThermalUnlock(boosterSource.value) : emptyScan(),
);

function emptyScan(): ThermalScan {
  return { fieldsAffected: 0, groupsTotal: 0, byField: {}, examples: [] };
}

/** Every distinct temperature group in the tree, with the value it would
 *  become, so the user sees exactly what a 90 °C lift means before applying. */
const uniqueGroups = computed<{ raw: string; lifted: string }[]>(() => {
  const seen = new Map<string, string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node as Record<string, unknown>).forEach(walk);
    } else if (typeof node === 'string') {
      for (const g of findTempGroups(node)) {
        if (!seen.has(g.raw)) seen.set(g.raw, liftTempGroupsInString(g.raw).out);
      }
    }
  };
  if (boosterSource.value) walk(boosterSource.value);
  return [...seen.entries()].slice(0, 12).map(([raw, lifted]) => ({ raw, lifted }));
});

const fieldSummary = computed(() =>
  Object.entries(scan.value.byField)
    .map(([k, n]) => `${k}×${n}`)
    .join('  '),
);

function rescan() {
  toast.info('已重新扫描', `命中 ${scan.value.fieldsAffected} 个字段`);
}

function doApply() {
  if (!state.cloudConfig.booster_config) return;
  const result = applyThermalUnlock(state.cloudConfig.booster_config.params);
  markDirty();
  if (!result.changed) {
    toast.info('未发现可抬升的温度组', '当前云控已经很凉快了');
    return;
  }
  const parts = Object.entries(result.liftedByField)
    .map(([k, n]) => `${k}×${n}`)
    .join(' ');
  toast.success('已抬升温度阈值（待提交）', `${result.groupsTotal} 组 · ${parts}`);
}
</script>

<style scoped>
.group-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  font-size: 12px;
  flex-wrap: wrap;
}

.group-raw {
  color: var(--text-muted);
}

.group-arrow {
  color: var(--text-faint);
}

.group-out {
  color: var(--ok);
  font-weight: 600;
}

.ok-text {
  color: var(--ok);
}

.warn-text {
  color: var(--warn);
}
</style>
