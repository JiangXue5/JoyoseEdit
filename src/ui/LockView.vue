<template>
  <div class="stack">
    <PageHeader title="云控锁定" kicker="teg freeze"
      desc="Joyose 的配置来自 MIUI 云控，约每 13 分钟拉取一次并覆盖本地。冻结后设备端永远声称「已是最新」，改动才能长期保留。">
      <button class="ghost" @click="refresh" :disabled="busy">
        <AppIcon name="refresh" /> 刷新状态
      </button>
    </PageHeader>

    <section class="panel freeze" :class="{ 'is-on': tegState.frozen }">
      <div class="freeze-head">
        <div class="freeze-mark">
          <AppIcon name="shield" />
        </div>
        <div class="freeze-text">
          <div class="kpi-label">云控状态</div>
          <h2 class="freeze-title">
            {{ tegLoading ? '正在读取…' : tegState.frozen ? '已冻结 · 云端不会覆盖' : '未冻结 · 会按周期覆盖' }}
          </h2>
          <div class="hint">
            {{ tegState.frozen
              ? 'teg SDK 的本地版本被钉在最大值，云端下发的任何规则都会被丢弃。可随时解冻恢复云控。'
              : '冻结会先停一次 Joyose 再改写 SharedPreferences 缓存，之后所有走 teg 的模块都会停止更新。' }}
          </div>
        </div>
        <div class="freeze-action">
          <button v-if="!tegState.exists" class="primary" disabled>等待 Joyose 初始化</button>
          <button v-else-if="!tegState.frozen" class="primary" @click="doFreeze" :disabled="busy">
            {{ busy ? '处理中…' : '冻结云控' }}
          </button>
          <button v-else @click="doUnfreeze" :disabled="busy">
            {{ busy ? '处理中…' : '解冻（恢复云控）' }}
          </button>
        </div>
      </div>

      <div v-if="!tegLoading && !tegState.exists" class="banner warn" style="margin-top: 14px">
        <strong>云控 SDK 尚未初始化</strong>
        <span>先在概览页提交一次配置，或等 Joyose 启动后再回来冻结。</span>
      </div>

      <div v-else-if="tegState.exists" class="kpi-grid" style="margin-top: 14px">
        <div class="kpi">
          <span class="kpi-label">基准版本</span>
          <span class="kpi-value sm mono">{{ tegState.pref_local_max_version ?? '—' }}</span>
          <span class="kpi-sub">{{ tegState.frozen ? 'Long.MAX_VALUE' : '正常递增' }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">配置文件</span>
          <span class="kpi-value sm mono">{{ shortPath(tegState.path) }}</span>
          <span class="kpi-sub">com.xiaomi.joyose/shared_prefs</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>DB 版本锁 <small>辅助手段</small></h2>
      </div>
      <div class="hint">
        把 DB 里的版本字段改成 <span class="mono">2099</span> 开头。真正防覆盖的是上面的冻结云控，
        这里只作辅助：便于观察 version 分布，并应对少数旁路读取。
      </div>

      <table class="table" style="margin-top: var(--space-3)">
        <thead>
          <tr>
            <th>配置名</th>
            <th>云控版本</th>
            <th>参数头版本</th>
            <th>规则版本</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(cfg, name) in state.cloudConfig" :key="name">
            <td><strong class="mono">{{ name }}</strong></td>
            <td data-label="云控版本">
              <span class="pill" :class="isLocked(cfg.meta.version) ? 'warn' : ''">
                {{ cfg.meta.version ?? '—' }}
              </span>
            </td>
            <td class="mono muted" data-label="参数头版本">{{ cfg.params?.header?.version ?? '—' }}</td>
            <td class="mono muted" data-label="规则版本">{{ ruleVersions(String(name)) }}</td>
            <td class="num" data-label="操作">
              <button v-if="!isLocked(cfg.meta.version)" class="primary sm" @click="lock(String(name))"
                :disabled="state.loading">锁定</button>
              <button v-else class="ghost sm" @click="unlock(String(name))" :disabled="state.loading">还原</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="btn-row" style="margin-top: var(--space-3)">
        <button class="primary" @click="lockAll" :disabled="state.loading">全部锁定</button>
        <button @click="bumpOnly" :disabled="state.loading">仅刷大版本（保留后 4 位）</button>
      </div>
      <p class="hint" style="margin-top: var(--space-2)">
        「全部锁定」会把所有配置的版本前 4 位改成 <strong>2099</strong>。仅在内存中生效，需在底部提交条写入设备。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onActivated, reactive, ref } from 'vue';
import { state, lockCloudVersion, unlockCloudVersion, markDirty } from '@/state/session';
import { toast } from '@/state/toast';
import * as bridge from '@/root/bridge';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';

function isLocked(v: unknown): boolean {
  return typeof v === 'number' && String(v).startsWith('2099');
}

function ruleVersions(name: string): string {
  const rows = state.rulesByModule[name] ?? [];
  if (rows.length === 0) return '（rules 表为空）';
  const vs = rows.map((r) => r.meta.rule_version).filter(Boolean);
  return vs.join(', ') || '—';
}

function shortPath(p?: string): string {
  if (!p) return '—';
  return p.split('/').slice(-2).join('/');
}

function lock(name: string) {
  const newV = lockCloudVersion(name);
  markDirty();
  toast.success('已锁定（待提交到设备）', `${name} → version ${newV}`);
}

function unlock(name: string) {
  const cur = Number(state.cloudConfig[name]?.meta.version ?? 0);
  const restored = Number(`2024${String(cur).slice(4)}`);
  unlockCloudVersion(name, restored);
  markDirty();
  toast.warn('已还原版本（待提交）', `${name} → ${restored}；下一次云控下发可能覆盖`);
}

function lockAll() {
  for (const name of Object.keys(state.cloudConfig)) {
    lockCloudVersion(name);
  }
  markDirty();
  toast.success('全部配置版本已刷到 2099 开头（待提交）');
}

function bumpOnly() {
  lockAll();
}

const tegState = reactive<bridge.TegStatus>({ ok: true, exists: false, path: '' });
const tegLoading = ref(true);
const busy = ref(false);

async function refresh() {
  tegLoading.value = true;
  try {
    const s = await bridge.tegStatus();
    Object.assign(tegState, s);
  } catch (err) {
    toast.error('读取云控状态失败', (err as Error).message);
  } finally {
    tegLoading.value = false;
  }
}

async function doFreeze() {
  busy.value = true;
  try {
    await bridge.tegFreeze();
    toast.success('云控已冻结', 'Joyose 已重启，后续云端下发不会覆盖本地改动');
    await refresh();
  } catch (err) {
    toast.error('冻结失败', (err as Error).message);
  } finally {
    busy.value = false;
  }
}

async function doUnfreeze() {
  busy.value = true;
  try {
    await bridge.tegUnfreeze();
    toast.warn('云控已解冻', '下一次云控拉取可能覆盖本地改动');
    await refresh();
  } finally {
    busy.value = false;
  }
}

// Views are cached by <KeepAlive>; re-read the teg state each time the tab is
// entered so a freeze/unfreeze done elsewhere is reflected immediately.
onActivated(() => {
  if (state.connected) void refresh();
  else tegLoading.value = false;
});
</script>

<style scoped>
.freeze {
  position: relative;
  overflow: hidden;
}

.freeze.is-on {
  border-color: var(--surface-ok-border);
  background:
    radial-gradient(120% 140% at 0% 0%, var(--surface-ok-bg), transparent 58%),
    var(--bg-panel);
}

.freeze-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
}

.freeze-mark {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 13px;
  display: grid;
  place-items: center;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.is-on .freeze-mark {
  border-color: var(--surface-ok-border);
  color: var(--ok);
  background: var(--surface-ok-bg);
}

.freeze-mark :deep(svg) {
  width: 22px;
  height: 22px;
}

.freeze-text {
  flex: 1;
  min-width: 200px;
}

.freeze-title {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.015em;
  margin: 2px 0 4px;
}

.is-on .freeze-title {
  color: var(--ok);
}

.freeze-action {
  flex: none;
  align-self: center;
}

@media (max-width: 860px) {
  .freeze-title {
    font-size: 15px;
  }

  .freeze-action {
    width: 100%;
  }

  .freeze-action button {
    width: 100%;
  }
}
</style>
