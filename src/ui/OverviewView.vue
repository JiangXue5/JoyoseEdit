<template>
  <div class="stack">
    <PageHeader title="概览" kicker="Dashboard" desc="设备上的 Joyose 数据库状态、可用增强通路与备份入口。">
      <button class="ghost" @click="handleRefresh" :disabled="state.loading">
        <AppIcon name="refresh" /> 刷新
      </button>
      <button class="primary" @click="handleBackup" :disabled="state.loading">
        <AppIcon name="db" /> 立即备份
      </button>
      <button class="ghost danger-text" @click="handleResetCloud" :disabled="state.loading">
        <AppIcon name="warn" /> 重置云控
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
        <h2>云控配置 <small>版本与来源</small></h2>
        <button class="ghost sm" @click="goLock">管理</button>
      </div>
      <div class="data-list">
        <div v-for="(cfg, name) in state.cloudConfig" :key="name" class="data-row">
          <div class="data-main">
            <strong class="mono">{{ name }}</strong>
            <span class="pill" :class="isVersionLocked(cfg.meta.version) ? 'warn' : ''">
              {{ currentLabel(cfg) }}
            </span>
            <span v-if="cfg.meta?.empty" class="pill off">空配置</span>
          </div>
          <div class="data-note mono">
            <span>{{ sourceLine('SmartP', smartpHeaderVersion(String(name)), cfg.meta?.source) }}</span>
            <span>{{ sourceLine('teg', tegHeaderVersion(String(name)), cfg.meta?.source) }}</span>
            <span v-if="!cfg.meta?.fromTeg">规则 {{ ruleVersions(String(name)) }}</span>
          </div>
        </div>
        <div v-if="Object.keys(state.cloudConfig).length === 0" class="hint" style="padding: 8px 0">
          两个数据库里都没有 cloud_config 行。先在 Joyose 里联网下发一次云控，或到「JSON 编辑」写入。
        </div>
      </div>
    </section>

    <!-- source & write policy -->
    <section class="panel">
      <div class="panel-header">
        <h2>来源与写入 <small>全局生效</small></h2>
      </div>
      <div class="hint">
        同一份云控在 SmartP.db 与 teg_config.db 各有一份，官方更新时两边版本可能不同步。
        「自动」读取版本号较新的一份；<strong>改动仍按下面的写入目标落盘</strong>。
      </div>

      <div class="policy-list">
        <div v-if="cfgPresent('booster_config')" class="policy-row">
          <div class="policy-label">
            <strong>booster_config</strong>
            <span class="tiny faint">插帧 / 独显 / 帧率</span>
          </div>
          <select v-if="canChooseSource('booster_config')" v-model="boosterPref" @change="onBoosterSource">
            <option v-for="opt in sourceOptions('booster_config')" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <span v-else class="hint mono">{{ singleSourceLabel('booster_config') }}</span>
        </div>

        <div v-if="cfgPresent('common_config')" class="policy-row">
          <div class="policy-label">
            <strong>common_config</strong>
            <span class="tiny faint">游戏名单 / 通用开关</span>
          </div>
          <select v-if="canChooseSource('common_config')" v-model="commonPref" @change="onCommonSource">
            <option v-for="opt in sourceOptions('common_config')" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <span v-else class="hint mono">{{ singleSourceLabel('common_config') }}</span>
        </div>

        <div v-if="showDataSource" class="policy-row">
          <div class="policy-label">
            <strong>数据源策略</strong>
            <span class="tiny faint">SmartP 缺少该配置时</span>
          </div>
          <div class="radio-row">
            <label><input type="radio" value="smartp" :checked="dataSource === 'smartp'"
              @change="onDataSource('smartp')" /> 仅 SmartP</label>
            <label><input type="radio" value="teg-fallback" :checked="dataSource === 'teg-fallback'"
              @change="onDataSource('teg-fallback')" /> 允许 teg 兜底</label>
          </div>
        </div>

        <div class="policy-row">
          <div class="policy-label">
            <strong>写入目标</strong>
            <span class="tiny faint">提交时写哪一份</span>
          </div>
          <select v-model="writeTarget" @change="onWriteTargetChange">
            <option v-for="(label, v) in WRITE_TARGET_LABELS" :key="v" :value="v">{{ label }}</option>
          </select>
        </div>
      </div>
      <div class="hint" style="margin-top: 10px">
        写入目标对所有页面生效（结构化编辑、云控锁定、去锁帧、温度解锁）。全新安装会回到默认「同时写」，
        升级则保留你的选择。
      </div>
    </section>

    <!-- maintenance -->
    <section class="panel">
      <div class="panel-header">
        <h2>维护 <small>破坏性操作</small></h2>
      </div>
      <div class="data-list">
        <div class="data-row">
          <div class="data-main">
            <strong>重置云控数据</strong>
            <span class="pill danger">会清空 Joyose 数据</span>
          </div>
          <button class="ghost sm danger-text" @click="handleResetCloud" :disabled="state.loading">
            执行
          </button>
          <div class="data-note">
            清除 com.xiaomi.joyose 的全部应用数据，再唤醒它的云端服务重新下发。
            本模块的备份 / 历史不受影响，但 Joyose 自身的所有设置（包括你在别处改过的项）都会丢失。
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
import { computed, ref } from 'vue';
import { state, pullAll, refreshStat, recordBackupCheckpoint } from '@/state/session';
import {
  getBoosterSourcePref,
  setBoosterSourcePref,
  getCommonSourcePref,
  setCommonSourcePref,
  getDataSourcePref,
  setDataSourcePref,
  getWriteTarget,
  setWriteTarget,
  PREF_LABELS,
  WRITE_TARGET_LABELS,
  type BoosterSourcePref,
  type DataSourcePref,
  type WriteTarget,
} from '@/state/source';
import { navigate } from '@/state/nav';
import { toast } from '@/state/toast';
import { dialog } from '@/state/dialog';
import * as bridge from '@/root/bridge';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';

const activePaths = computed(() => state.paths.filter((p) => p.active).length);

// ---- source / write policy -------------------------------------------------

const boosterPref = ref<BoosterSourcePref>(getBoosterSourcePref());
const commonPref = ref<BoosterSourcePref>(getCommonSourcePref());
const writeTarget = ref<WriteTarget>(getWriteTarget());
const dataSource = ref<DataSourcePref>(getDataSourcePref());

function cfgPresent(name: string): boolean {
  return !!state.cloudConfig[name];
}

function smartpHas(name: string): boolean {
  return !!state.smartpRaw[name];
}

function tegHas(name: string): boolean {
  return (state.rulesByModule[name]?.length ?? 0) > 0;
}

/** A choice only exists when both sides carry the config. */
function canChooseSource(name: string): boolean {
  return smartpHas(name) && tegHas(name);
}

function singleSourceLabel(name: string): string {
  if (smartpHas(name)) return '仅 SmartP.db 有此配置（无从选择）';
  if (tegHas(name)) return '仅 teg_config.db 有此配置（无从选择）';
  return '两库均无';
}

function sourceOptions(name: string): { value: BoosterSourcePref; label: string }[] {
  const opts: BoosterSourcePref[] = [];
  if (smartpHas(name)) opts.push('smartp');
  if (tegHas(name)) opts.push('teg');
  if (opts.length > 1) opts.unshift('auto');
  return opts.map((v) => ({ value: v, label: PREF_LABELS[v] }));
}

/** Header version embedded in SmartP's params (the original source of truth). */
function smartpHeaderVersion(name: string): string {
  const v = state.smartpRaw[name]?.header?.version;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Header version of the newest teg envelope (by envelope.version). */
function tegHeaderVersion(name: string): string {
  const rows = state.rulesByModule[name] ?? [];
  let best: any = null;
  let bestV = 0;
  for (const r of rows) {
    const env = r?.content;
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    const v = Number((env as any).version ?? 0);
    if (v > bestV) {
      bestV = v;
      best = env;
    }
  }
  if (!best && rows.length) {
    const e = rows[0]?.content;
    best = e && typeof e === 'object' && !Array.isArray(e) ? e : null;
  }
  const h = best?.params?.header?.version;
  return typeof h === 'string' ? h : typeof h === 'number' ? String(h) : '';
}

function sourceLine(label: string, version: string, current?: string): string {
  const mark = current === label.toLowerCase() ? ' ← 当前' : '';
  return `${label} ${version || '—'}${mark}`;
}

function currentLabel(cfg: any): string {
  if (cfg.meta?.empty) return '（空）';
  const v = Number(cfg.meta?.version ?? 0);
  return v > 0 ? String(v) : '—';
}

const showDataSource = computed(
  () =>
    (!smartpHas('booster_config') && tegHas('booster_config')) ||
    (!smartpHas('common_config') && tegHas('common_config')),
);

async function onBoosterSource() {
  setBoosterSourcePref(boosterPref.value);
  await applyPull(PREF_LABELS[boosterPref.value]);
}

async function onCommonSource() {
  setCommonSourcePref(commonPref.value);
  await applyPull(PREF_LABELS[commonPref.value]);
}

async function applyPull(label: string) {
  try {
    await pullAll();
    toast.info('已切换来源并重新拉取', label);
  } catch (err) {
    toast.fromError(err, '切换失败');
  }
}

async function onDataSource(v: DataSourcePref) {
  if (dataSource.value === v) return;
  dataSource.value = v;
  setDataSourcePref(v);
  await applyPull(v === 'teg-fallback' ? '允许 teg 兜底' : '仅 SmartP');
}

function onWriteTargetChange() {
  setWriteTarget(writeTarget.value);
  toast.info('写入目标已更新', WRITE_TARGET_LABELS[writeTarget.value]);
}
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

/** Destructive: wipes Joyose app data. Requires two confirmations because the
 *  only way back is a re-download (and a reboot on some ROMs). */
async function handleResetCloud() {
  const ok = await dialog.confirm('重置 Joyose 云控数据？', {
    detail:
      '会执行 pm clear com.xiaomi.joyose：Joyose 的全部应用数据被清空，随后尝试重新获取云控。' +
      '请确保当前处于联网状态（建议 Wi-Fi），否则可能取不到新云控。本模块的备份与历史不受影响。',
    okText: '继续',
    cancelText: '取消',
    destructive: true,
  });
  if (!ok) return;
  const sure = await dialog.confirm('最后确认：清空 Joyose 数据', {
    detail: '此操作不可撤销。若只是想恢复本模块改过的配置，请改用「回滚到最近备份」。',
    okText: '确认清空',
    cancelText: '取消',
    destructive: true,
  });
  if (!sure) return;
  try {
    await bridge.resetCloud();
    toast.warn('已重置云控', 'Joyose 数据已清空，等待其重新下载；必要时重启设备');
    await refreshStat();
    await pullAll();
  } catch (err) {
    toast.fromError(err, '重置失败');
  }
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
.policy-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.policy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0;
  border-top: 1px solid var(--hairline);
}

.policy-row:first-child {
  border-top: none;
  padding-top: 0;
}

.policy-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
}

.policy-label strong {
  font-size: 13px;
  font-weight: 600;
}

.policy-row select {
  min-width: 220px;
  max-width: 100%;
}

.radio-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.radio-row label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.danger-text {
  color: var(--danger);
}

.danger-text:hover {
  border-color: var(--danger);
}

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
