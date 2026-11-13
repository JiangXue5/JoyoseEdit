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
        <h2>云控配置 <small>版本与来源</small></h2>
        <button class="ghost sm" @click="goLock">管理</button>
      </div>
      <div class="data-list">
        <div v-for="row in cfgRows" :key="row.name" class="cfg-row">
          <div class="cfg-head">
            <strong class="mono">{{ row.name }}</strong>
            <span
              class="cfg-version"
              :class="{ locked: isVersionLocked(row.cfg.meta?.version) }"
              :title="row.cfg.meta?.empty ? '' : `原始版本号 ${row.cfg.meta?.version ?? '—'}`"
            ><span class="lbl">{{ isVersionLocked(row.cfg.meta?.version) ? '锁定' : '生效' }}</span>{{ currentLabel(row.cfg) }}</span>
            <span v-if="row.cfg.meta?.empty" class="pill off">空配置</span>
            <span v-if="row.cfg.meta?.broken" class="pill danger">JSON 损坏</span>
          </div>
          <dl class="cfg-sources">
            <div class="cfg-source">
              <dt>SmartP.db</dt>
              <dd>
                <span class="num">{{ fmtVersion(sourceVersion(row.name, 'smartp')) }}</span>
                <span v-if="isActiveSource(row.cfg.meta?.source, 'smartp')" class="cfg-tag">生效</span>
              </dd>
            </div>
            <div class="cfg-source">
              <dt>teg_config.db</dt>
              <dd>
                <span class="num">{{ fmtVersion(sourceVersion(row.name, 'teg')) }}</span>
                <span v-if="isActiveSource(row.cfg.meta?.source, 'teg')" class="cfg-tag">生效</span>
              </dd>
            </div>
            <div v-if="ruleHistory(row.name)" class="cfg-source">
              <dt>历史版本</dt>
              <dd class="faint">{{ ruleHistory(row.name) }}</dd>
            </div>
            <div class="cfg-source">
              <dt>写入目标</dt>
              <dd>
                <span class="cfg-tag write">{{ writeTargetShort }}</span>
                <span class="tiny faint">{{ writeTargetNote(row.name) }}</span>
              </dd>
            </div>
          </dl>
          <div v-if="row.cfg.meta?.broken" class="cfg-conflict">
            这一行的 JSON 无法解析（{{ row.cfg.meta?.parseError }}）。它的原始内容仍保存在数据库里，
            本模块不会写回这一行；需要修复时请到「参数树」按原始文本处理。
          </div>
          <div v-if="sourceConflict(row.name)" class="cfg-conflict">
            {{ sourceConflict(row.name) }}
          </div>
        </div>
        <div v-if="Object.keys(state.cloudConfig).length === 0" class="hint" style="padding: 8px 0">
          两个数据库里都没有 cloud_config 行。先在 Joyose 里联网下发一次云控，或到「参数树」写入。
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
        写入目标对所有页面生效（结构化编辑、云控锁定、去锁帧、温度解锁）。这些选择保存在模块目录
        <code>settings.json</code> 里，重开 WebUI、切换管理器都不会丢；只有全新安装会回到默认「同时写」。
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
import { state, pullAll, refreshStat, recordBackupCheckpoint, backupNow, resetCloudData, revertLatestBackup } from '@/state/session';
import { isVersionLocked } from '@/db/merge';
import {
  getBoosterSourcePref,
  setBoosterSourcePref,
  getCommonSourcePref,
  setCommonSourcePref,
  getDataSourcePref,
  setDataSourcePref,
  getWriteTarget,
  setWriteTarget,
  getPersistError,
  whenPrefsPersisted,
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
import { orderedCloudConfig } from './cloudOrder';

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
  return opts.map((v) => ({ value: v, label: sourceOptionLabel(name, v) }));
}

/** The two numbers auto compares: SmartP's cloud_config.version column vs the
 *  highest envelope.version among the teg rows. */
function sourceVersion(name: string, side: 'smartp' | 'teg'): number {
  const meta = state.cloudConfig[name]?.meta as any;
  if (!meta) return 0;
  return side === 'smartp' ? Number(meta.smartpVersion ?? 0) : Number(meta.tegVersion ?? 0);
}

/** Concrete choices show the comparable version, and the newer side gets the
 *  mark. The old static "rules 最新" label read like a claim about which file
 *  was fresher — that is precisely what auto compares, and it was wrong
 *  whenever SmartP had the newer version. */
function sourceOptionLabel(name: string, v: BoosterSourcePref): string {
  if (v === 'auto') return PREF_LABELS.auto;
  const own = sourceVersion(name, v);
  const other = sourceVersion(name, v === 'smartp' ? 'teg' : 'smartp');
  const base = v === 'smartp' ? 'SmartP.db' : 'teg_config.db';
  const version = own > 0 ? ` · ${own}` : '';
  const mark = own > 0 && other > 0 && own > other ? '（较新）' : '';
  return `${base}${version}${mark}`;
}

/** Cloud versions are `YYYYMMDDnn`. The raw number is unreadable at a glance,
 *  and three of them side by side said nothing about which was which — so the
 *  list shows dates and keeps the raw form in the tooltip. */
function fmtVersion(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = String(Math.trunc(n));
  if (s.length === 10) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function isActiveSource(source: unknown, side: 'smartp' | 'teg'): boolean {
  return String(source ?? '').toLowerCase() === side;
}

function currentLabel(cfg: any): string {
  if (cfg.meta?.empty) return '（空）';
  return fmtVersion(cfg.meta?.version);
}

/** What this row will be written to when the user commits. Shown per config
 *  because "读取来源" and "写入目标" are two different settings, and a silent
 *  mismatch is exactly how an edit ends up nowhere. */
const writeTargetShort = computed(() => {
  switch (writeTarget.value) {
    case 'smartp':
      return '仅 SmartP';
    case 'teg':
      return '仅 teg';
    default:
      return '两份都写';
  }
});

function writeTargetNote(name: string): string {
  if (writeTarget.value === 'both') return '提交后同时更新';
  if (writeTarget.value === 'smartp') return smartpHas(name) ? '提交后更新' : 'SmartP 里没有这一行';
  return tegHas(name) ? '提交后更新' : 'teg 里没有这一行';
}

/** The read source and the write target disagree.
 *
 *  The commit path only writes a row that actually exists in the target DB and
 *  never copies a teg-sourced working copy into SmartP wholesale, so some
 *  combinations drop the user's edit. Say so here instead of letting the user
 *  find out after a "提交成功" toast. */
function sourceConflict(name: string): string {
  const meta = state.cloudConfig[name]?.meta as any;
  if (!meta || meta.empty) return '';
  const fromTeg = meta.fromTeg === true || meta.source === 'teg';
  const fromSmartp = meta.source === 'smartp';

  if (fromTeg && writeTarget.value === 'smartp') {
    return '读取自 teg，写入目标只有 SmartP：这份配置提交后不会落盘（teg 内容不会整份写进 SmartP）。'
      + '请把写入目标改成「两份都写」或「仅 teg」，或先在 Joyose 里让 SmartP 下发这一行。';
  }
  if (fromTeg && writeTarget.value === 'both') {
    return '读取自 teg：提交时只会写 teg 镜像，SmartP 里这一行保持原样（避免把 teg 独有字段带过去）。';
  }
  if (fromSmartp && writeTarget.value === 'teg') {
    return '读取自 SmartP，写入目标只有 teg：SmartP 里的这份不会被更新，Joyose 实际读到的可能仍是旧内容。';
  }
  if (writeTarget.value === 'smartp' && !smartpHas(name)) {
    return '写入目标是 SmartP，但 SmartP 里没有这一行，提交会被跳过。';
  }
  if (writeTarget.value === 'teg' && !tegHas(name)) {
    return '写入目标是 teg，但 teg 里没有这一行，提交会被跳过。';
  }
  return '';
}

/** 云控 JSON 的键序由后端拼装顺序决定，不能拿它当展示顺序。
 *  这里跟着下面的「来源与写入」排：booster 在上、common 在下，两处对照着读。 */
const cfgRows = computed(() => orderedCloudConfig(state.cloudConfig));

const showDataSource = computed(
  () =>
    (!smartpHas('booster_config') && tegHas('booster_config')) ||
    (!smartpHas('common_config') && tegHas('common_config')),
);

async function onBoosterSource() {
  setBoosterSourcePref(boosterPref.value);
  await reportPersist();
  await applyPull(PREF_LABELS[boosterPref.value]);
}

async function onCommonSource() {
  setCommonSourcePref(commonPref.value);
  await reportPersist();
  await applyPull(PREF_LABELS[commonPref.value]);
}

/** Settings go to /data/adb/joyose-edit/settings.json; say so when the write
 *  failed instead of letting the picker quietly revert on the next launch. */
async function reportPersist() {
  await whenPrefsPersisted();
  const err = getPersistError();
  if (err) toast.warn('设置没能写入模块目录，重开 WebUI 后会恢复默认', err);
}

async function applyPull(label: string) {
  try {
    const r = await pullAll();
    if (!r.ok) {
      toast.fromError(new Error(r.error), '切换失败');
      return;
    }
    toast.info('已切换来源并重新拉取', label);
  } catch (err) {
    toast.fromError(err, '切换失败');
  }
}

async function onDataSource(v: DataSourcePref) {
  if (dataSource.value === v) return;
  dataSource.value = v;
  setDataSourcePref(v);
  await reportPersist();
  await applyPull(v === 'teg-fallback' ? '允许 teg 兜底' : '仅 SmartP');
}

async function onWriteTargetChange() {
  setWriteTarget(writeTarget.value);
  await whenPrefsPersisted();
  const err = getPersistError();
  if (err) {
    toast.warn('写入目标没能保存到模块目录', err);
    return;
  }
  toast.info('写入目标已更新', WRITE_TARGET_LABELS[writeTarget.value]);
}
const isLocked = computed(() => isVersionLocked(state.cloudConfig.booster_config?.meta.version));

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

/** Revisions left behind in teg's `rules` table. The newest one is already
 *  shown as teg's version above, so only the backlog is listed here —
 *  repeating the newest number in both lines was pure noise. */
function ruleHistory(name: string): string {
  const rows = state.rulesByModule[name] ?? [];
  const seen = new Set<number>();
  for (const r of rows) {
    const v = Number((r.content as any)?.version ?? 0);
    if (v > 0) seen.add(v);
  }
  const vs = [...seen].sort((a, b) => b - a).slice(1);
  if (vs.length === 0) return '';
  const shown = vs.slice(0, 2).map(fmtVersion);
  const more = vs.length > shown.length ? ` 等 ${vs.length} 条` : '';
  return `${shown.join(' · ')}${more}`;
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
    const reset = await resetCloudData();
    if (reset.failed.length) {
      toast.warn(
        '已清空云控，但部分步骤失败',
        `${reset.failed.join('、')} · 数据已删除，Joyose 下次启动会重新下发，必要时重启设备`,
      );
    } else {
      toast.warn('已重置云控', 'Joyose 数据已清空，等待其重新下载；必要时重启设备');
    }
    await refreshStat();
    const r = await pullAll();
    if (!r.ok) toast.warn('已重置，但界面刷新失败', `${r.error} · 请手动刷新`);
  } catch (err) {
    toast.fromError(err, '重置失败');
  }
}

async function handleRefresh() {
  await refreshStat();
  const r = await pullAll();
  if (!r.ok) toast.fromError(new Error(r.error), '刷新失败');
}

async function handleBackup() {
  try {
    const r = await backupNow();
    await recordBackupCheckpoint(r.name).catch(() => null);
    await refreshStat();
    if (r.wasRunning && r.restarted === false) {
      toast.warn('已备份，但 Joyose 未能重新启动', `${r.name} · 进游戏前请手动打开一次 Joyose`);
    } else {
      toast.success('已备份', r.name);
    }
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
    const r = await revertLatestBackup();
    const pulled = await pullAll();
    if (r.wasRunning && r.restarted === false) {
      toast.warn('已回滚，但 Joyose 未能重新启动 —— 请手动重启它后再进游戏', r.from);
    } else if (!pulled.ok) {
      toast.warn('已回滚，但界面刷新失败', `${pulled.error} · 请手动刷新`);
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

/* Two source lines + the rule list read as separate facts; without wrapping
   they ran together into "SmartP 2025112651teg 2025122001". */
.source-note {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
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
