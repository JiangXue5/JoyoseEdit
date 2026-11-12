<template>
  <div class="stack">
    <PageHeader title="概览" kicker="Dashboard" desc="设备上的 Joyose 数据库状态、可用增强通路与备份入口。">
      <button class="ghost" @click="handleRefresh" :disabled="state.loading">
        <AppIcon name="refresh" /> 刷新
      </button>
      <button class="primary" @click="handleBackup" :disabled="state.loading">
        <AppIcon name="db" /> 立即备份
      </button>
    </PageHeader>

    <!-- device spotlight -->
    <section class="hero">
      <div class="hero-main">
        <div class="hero-mark">
          <AppIcon :name="backendIcon" />
        </div>
        <div class="hero-text">
          <div class="kpi-label">当前增强通路</div>
          <div class="hero-title">{{ backendLabel }}</div>
          <div class="hint">{{ backendDesc }}</div>
        </div>
        <div class="hero-pills">
          <span class="pill" :class="state.connected ? 'ok' : 'danger'">
            {{ state.connected ? 'KernelSU 已连接' : '未连接' }}
          </span>
          <span v-if="isLocked" class="pill warn">云控已冻结</span>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">SmartP.db</span>
          <span class="kpi-value">{{ formatSize(state.stat?.smartp?.size) }}</span>
          <span class="kpi-sub mono">{{ shortPath(state.stat?.smartp?.path) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">teg_config.db</span>
          <span class="kpi-value">{{ formatSize(state.stat?.teg?.size) }}</span>
          <span class="kpi-sub mono">{{ shortPath(state.stat?.teg?.path) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">通路</span>
          <span class="kpi-value">{{ activePaths }}<span class="unit">/{{ state.paths.length || 4 }}</span></span>
          <span class="kpi-sub">已下发配置的路径</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">备份 / 历史</span>
          <span class="kpi-value">{{ state.stat?.backup_count ?? 0 }}<span class="unit">/{{ state.stat?.history_count ?? 0 }}</span></span>
          <span class="kpi-sub">份备份 · 条提交记录</span>
        </div>
      </div>
    </section>

    <!-- path detection -->
    <section class="panel">
      <div class="panel-header">
        <h2>通路识别 <small>按设备实际 DB 自适应</small></h2>
      </div>
      <div class="data-list">
        <div v-for="p in state.paths" :key="p.id" class="data-row">
          <div class="data-main">
            <strong>{{ pathLabel(p.id) }}</strong>
            <span class="tiny faint mono">{{ p.count }} 条</span>
          </div>
          <span class="pill" :class="p.active ? 'ok' : 'off'">
            {{ p.active ? '已激活' : '未下发' }}
          </span>
          <div class="data-note">{{ p.note }}</div>
        </div>
        <div v-if="state.paths.length === 0" class="hint" style="padding: 8px 0">
          尚未拉取数据库，或该 ROM 没有 Joyose 插帧配置。
        </div>
      </div>
    </section>

    <!-- cloud config versions -->
    <section class="panel">
      <div class="panel-header">
        <h2>云控配置 <small>版本与锁定状态</small></h2>
        <button class="ghost sm" @click="goLock">管理</button>
      </div>
      <div class="data-list">
        <div v-for="(cfg, name) in state.cloudConfig" :key="name" class="data-row">
          <div class="data-main">
            <strong class="mono">{{ name }}</strong>
            <span class="pill" :class="isVersionLocked(cfg.meta.version) ? 'warn' : ''">
              {{ cfg.meta.version ?? '—' }}
            </span>
          </div>
          <div class="data-note mono">
            参数头 {{ cfg.params?.header?.version ?? '—' }} · 规则 {{ ruleVersions(String(name)) }}
          </div>
        </div>
      </div>
    </section>

    <!-- backup -->
    <section class="panel">
      <div class="panel-header">
        <h2>备份与恢复</h2>
      </div>
      <div class="hint">
        提交修改前会自动备份一次；这里可以随时手动打点，或把两份 DB 直接回滚到最近一次备份。
        备份文件保存在 <span class="mono">{{ state.stat?.data_root ?? '/data/adb/joyose-edit' }}/backup</span>。
      </div>
      <div class="btn-row" style="margin-top: var(--space-3)">
        <button @click="handleBackup" :disabled="state.loading">立即备份</button>
        <button class="danger" @click="handleRevertLatest" :disabled="state.loading">回滚到最近备份</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state, pullAll, refreshStat, recordBackupCheckpoint } from '@/state/session';
import { navigate } from '@/state/nav';
import { toast } from '@/state/toast';
import { dialog } from '@/state/dialog';
import * as bridge from '@/root/bridge';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';

const activePaths = computed(() => state.paths.filter((p) => p.active).length);
const isLocked = computed(() => {
  const v = state.cloudConfig.booster_config?.meta.version;
  return typeof v === 'number' && String(v).startsWith('2099');
});

const backendIcon = computed(() => {
  switch (state.activeBackend) {
    case 'mifisr': return 'spark';
    case 'qualcomm': return 'cpu';
    case 'novatek': return 'monitor';
    default: return 'info';
  }
});

const backendLabel = computed(() => {
  switch (state.activeBackend) {
    case 'mifisr': return 'MIFISR 插帧 / 超分';
    case 'qualcomm': return '高通 AFME / FRC 通路';
    case 'novatek': return 'Novatek 独显通路';
    default: return state.stat ? '未检测到增强通路' : '正在读取设备…';
  }
});

const backendDesc = computed(() => {
  switch (state.activeBackend) {
    case 'mifisr': return '小米 17 系列 · 骁龙 8 Elite 2，策略层与渲染层双通道。';
    case 'qualcomm': return '骁龙 8 Elite 机型，走 AFME / FRC / FSR 老通路（未实机验证）。';
    case 'novatek': return '红米独显机型，走 NT#FI / NT#FISR 策略（未实机验证）。';
    default: return '云控里还没有可用的插帧配置，或当前 ROM 不支持画质增强。';
  }
});

function pathLabel(id: string): string {
  switch (id) {
    case 'mifisr': return 'MIFISR';
    case 'qualcomm': return '高通 GPU';
    case 'novatek': return 'Novatek 独显';
    case 'mivk': return 'MIVK (Vulkan)';
    case 'migl': return 'MIGL (OpenGL)';
    default: return id;
  }
}

function isVersionLocked(v: unknown): boolean {
  return typeof v === 'number' && String(v).startsWith('2099');
}

function ruleVersions(name: string): string {
  const rows = state.rulesByModule[name] ?? [];
  if (rows.length === 0) return '（空）';
  const vs = rows.map((r) => r.meta.rule_version).filter(Boolean);
  return vs.join(', ') || '—';
}

function formatSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function shortPath(p?: string): string {
  if (!p) return '—';
  const parts = p.split('/');
  return parts.slice(-2).join('/');
}

function goLock() {
  navigate('lock');
}

async function handleRefresh() {
  await refreshStat();
  await pullAll();
}

async function handleBackup() {
  try {
    const r = await bridge.backup();
    await recordBackupCheckpoint(r.name).catch(() => null);
    await refreshStat();
    toast.success('已备份', r.name);
  } catch (err) {
    toast.fromError(err, '备份失败');
  }
}

async function handleRevertLatest() {
  const ok = await dialog.confirm('回滚到最近一次备份？', {
    detail: '两份 DB 会被覆盖，但编辑历史记录仍保留（可继续回滚到更早版本）。',
    okText: '回滚',
    destructive: true,
  });
  if (!ok) return;
  try {
    const r = await bridge.revertLatest();
    let stopped = r.stopped;
    if (stopped !== true) {
      // Older helper: revert did not stop Joyose itself, so ask again.
      const again = await bridge.restart().catch(() => null);
      if (typeof again?.stopped === 'boolean') stopped = again.stopped;
    }
    await pullAll();
    if (stopped === false) {
      toast.warn('已回滚，但 Joyose 未能停止 —— 请手动重启它后再进游戏', r.from);
    } else {
      toast.success('已回滚到备份', r.from);
    }
  } catch (err) {
    toast.fromError(err, '回滚失败');
  }
}
</script>

<style scoped>
.hero {
  background:
    radial-gradient(120% 140% at 0% 0%, var(--accent-soft), transparent 55%),
    var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hero-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.hero-mark {
  width: 46px;
  height: 46px;
  flex: none;
  border-radius: 14px;
  display: grid;
  place-items: center;
  color: var(--accent-strong);
  background: var(--bg-sunken);
  border: 1px solid var(--accent-line);
}

.hero-mark :deep(svg) {
  width: 24px;
  height: 24px;
}

.hero-text {
  flex: 1;
  min-width: 180px;
}

.hero-title {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.25;
  margin: 2px 0 3px;
}

.hero-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-faint);
  margin-left: 2px;
}

@media (max-width: 860px) {
  .hero {
    padding: 14px;
    border-radius: var(--radius-md);
    gap: 12px;
  }

  .hero-title {
    font-size: 17px;
  }

  .hero-mark {
    width: 40px;
    height: 40px;
    border-radius: 12px;
  }
}
</style>
