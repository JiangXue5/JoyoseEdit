<template>
  <div class="stack">
    <PageHeader title="去除锁帧" kicker="frame cap"
      desc="Joyose 通过 cgame_enable、dynamic_fps* 与 PID_* 曲线限制游戏帧率。这里提供两种力度：整层去掉，或只把降帧温度往后推。">
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
          <h2>当前状态 <small>全树扫描</small></h2>
        </div>

        <div class="kpi-grid">
          <div class="kpi">
            <span class="kpi-label">cgame_enable</span>
            <span class="kpi-value sm" :class="scan.cgameEnables ? 'warn-text' : 'ok-text'">
              {{ scan.cgameEnables === null ? '不存在' : scan.cgameEnables ? '开启' : '已关闭' }}
            </span>
            <span class="kpi-sub">云控游戏总开关</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">dynamic_fps_global</span>
            <span class="kpi-value sm" :class="scan.hasDynamicFpsGlobal ? 'warn-text' : 'ok-text'">
              {{ scan.hasDynamicFpsGlobal ? '存在' : '不存在' }}
            </span>
            <span class="kpi-sub">全局动态帧率曲线</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">锁帧字段</span>
            <span class="kpi-value" :class="scan.totalKeys > 0 ? 'warn-text' : 'ok-text'">
              {{ scan.totalKeys }}
            </span>
            <span class="kpi-sub">PID_* / dynamic_fps*</span>
          </div>
        </div>

        <div v-if="keySummary" class="hint mono" style="margin-top: 12px">{{ keySummary }}</div>
        <div v-if="scan.unknownKeys" class="banner warn" style="margin-top: 12px">
          <strong>另有 {{ scan.unknownKeys }} 个同名字段不在已知位置</strong>
          <span>它们不在 game_booster / booster_config / ovrride_config 下，可能是别的用途。本次只会显示，不会删除。</span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>处理方式</h2>
        </div>

        <div class="action-list">
          <div class="action-card">
            <div class="action-head">
              <div class="action-title">
                <strong>去除锁帧</strong>
                <span class="pill" :class="hasLockContent ? 'warn' : 'ok'">
                  {{ hasLockContent ? '可处理' : '已干净' }}
                </span>
              </div>
              <button class="primary sm" @click="doApply"
                :disabled="state.loading || !hasLockContent">
                执行
              </button>
            </div>
            <p class="hint">
              关闭 <code class="mono">cgame_enable</code>，删除 <code class="mono">dynamic_fps_global</code>
              以及整棵树里的 <code class="mono">PID_*</code> / <code class="mono">dynamic_fps*</code>。
              力度最大：设备不再按云控曲线治理帧率。
            </p>
          </div>

          <div class="action-card">
            <div class="action-head">
              <div class="action-title">
                <strong>抬高降帧阈值</strong>
                <span class="pill" :class="hasLiftContent ? 'warn' : 'ok'">
                  {{ hasLiftContent ? '可处理' : '无曲线' }}
                </span>
              </div>
              <button class="sm" @click="doLift" :disabled="state.loading || !hasLiftContent">
                执行
              </button>
            </div>
            <p class="hint">
              保留 <code class="mono">dynamic_fps*</code> 曲线，只把温度段 3x–5x 抬到 9x
              （46.5→96.5、48→98），<code class="mono">PID_*</code> 仍然删除。
              力度较轻：曲线还在，只是设备基本不会因发热而降帧。
            </p>
          </div>
        </div>

        <div class="banner warn" style="margin-top: 14px">
          <strong>硬件风险提示</strong>
          <span>两种方式都会让设备在高温下继续以高帧率运行。长时间重载游戏时，请留意机身温度；
            这不会解除系统级温控保护，但会显著推迟降帧。</span>
        </div>

        <p class="hint" style="margin-top: 12px">
          点击后只在内存中生效，需要在底部提交条点「提交到设备」写入。提交前会自动备份，可在「编辑历史」回滚。
        </p>
      </section>

      <section v-if="scan.entries.length" class="panel">
        <div class="panel-header">
          <h2>携带锁帧字段的游戏 <small>{{ scan.entries.length }} 条</small></h2>
        </div>
        <div class="data-list">
          <div v-for="e in scan.entries" :key="e.name" class="data-row">
            <div class="data-main">
              <strong class="mono">{{ e.name }}</strong>
            </div>
            <span class="pill off">{{ e.keys.length }} 项</span>
            <div class="data-note mono">{{ e.keys.join('、') }}</div>
          </div>
        </div>
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
  scanFpsLock,
  applyUnlockFps,
  applyLiftThermalFps,
  type FpsLockScan,
} from '@/parsers/fpslock';

/** Work on the reconciled working copy (whatever the source policy selected),
 *  so "auto" edits the same content the other pages show. */
const boosterSource = computed(() => state.cloudConfig.booster_config?.params ?? null);
const hasBooster = computed(() => sourceUsable('booster_config'));

const scan = computed<FpsLockScan>(() =>
  boosterSource.value !== null ? scanFpsLock(boosterSource.value) : emptyScan(),
);

const hasLockContent = computed(
  () => scan.value.totalKeys > 0 || scan.value.hasDynamicFpsGlobal,
);

/** Lifting only makes sense when a dynamic_fps* curve exists; PID_* alone is
 *  the "remove" button's job. */
const hasLiftContent = computed(() => {
  let dyn = 0;
  for (const [k, n] of Object.entries(scan.value.countByKey)) {
    if (k.startsWith('dynamic_fps')) dyn += n ?? 0;
  }
  return dyn > 0;
});

const keySummary = computed(() =>
  Object.entries(scan.value.countByKey)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join('  '),
);

function emptyScan(): FpsLockScan {
  return {
    cgameEnables: null,
    hasDynamicFpsGlobal: false,
    totalKeys: 0,
    countByKey: {},
    unknownKeys: 0,
    unknownByKey: {},
    entries: [],
  };
}

function rescan() {
  toast.info('已重新扫描', `共 ${scan.value.totalKeys} 个锁帧字段`);
}

function doApply() {
  if (!state.cloudConfig.booster_config) return;
  const result = applyUnlockFps(state.cloudConfig.booster_config.params);
  markDirty();
  if (!result.changed) {
    toast.info('未发现可清除的锁帧内容', '当前云控已经很干净了');
    return;
  }
  const parts: string[] = [];
  if (result.cgameDisabled) parts.push('cgame_enable → false');
  if (result.globalDfRemoved) parts.push('dynamic_fps_global 已删除');
  const keySummary = Object.entries(result.removedByKey)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(' ');
  if (keySummary) parts.push(keySummary);
  toast.success(
    '已去除锁帧（待提交）',
    `影响 ${result.entriesAffected} 个游戏条目 · ${parts.join('；')}`,
  );
}

function doLift() {
  if (!state.cloudConfig.booster_config) return;
  const result = applyLiftThermalFps(state.cloudConfig.booster_config.params);
  markDirty();
  if (!result.changed) {
    toast.info('无可提温 / 删除内容', '未发现 dynamic_fps* 或 PID_* 字段');
    return;
  }
  const parts: string[] = [];
  if (result.liftedKeys.length) parts.push(`提温 ${result.liftedKeys.length} 个 dynamic_fps 字段`);
  const keySummary = Object.entries(result.removedByKey)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(' ');
  if (keySummary) parts.push(keySummary);
  toast.success('已抬高降帧阈值（待提交）', parts.join('；'));
}
</script>

<style scoped>
.action-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.action-card {
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
}

.action-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.action-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.action-title strong {
  font-size: 13.5px;
  font-weight: 600;
}

.action-card .hint {
  margin: 8px 0 0;
}

.ok-text {
  color: var(--ok);
}

.warn-text {
  color: var(--warn);
}
</style>
