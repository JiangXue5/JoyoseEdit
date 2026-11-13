<template>
  <div class="app-shell" :class="{ 'sidebar-open': drawerOpen }">
    <div class="sidebar-scrim" v-show="drawerOpen" @click="drawerOpen = false" aria-hidden="true" />

    <nav class="sidebar" @click="onNavClick">
      <div class="brand">
        <div class="brand-mark">J</div>
        <div class="brand-text">
          <b>Joyose<em>Edit</em></b>
          <span>v{{ version }} · KernelSU</span>
        </div>
      </div>

      <template v-for="group in navGroups" :key="group.label">
        <div class="nav-group">{{ group.label }}</div>
        <button v-for="item in group.items" :key="item.id" class="nav-btn" :class="{ active: view === item.id }"
          @click="go(item.id)">
          <AppIcon :name="item.icon" />
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.badge" class="badge" :class="item.badgeTone">{{ item.badge }}</span>
        </button>
      </template>

      <div class="sidebar-foot">
        <div class="foot-row">
          <span class="dot" :class="state.connected ? 'ok' : 'warn'" />
          <span>{{ state.connected ? 'KernelSU 已连接' : '等待 KernelSU 环境' }}</span>
        </div>
        <div class="foot-row" v-if="state.stat">
          <span class="dot" :class="state.dirty ? 'warn' : 'ok'" />
          <span>{{ state.dirty ? '有未提交修改' : '与设备一致' }}</span>
        </div>
        <button class="nav-btn theme-btn" @click="cycleTheme" :title="themeTitle">
          <AppIcon :name="themeIcon" />
          <span class="nav-label">外观</span>
          <span class="badge">{{ themeLabel }}</span>
        </button>
      </div>
    </nav>

    <main ref="mainEl" class="main" :class="{ scrolled, 'has-pending': state.dirty }" @scroll.passive="onScroll">
      <div class="progress-line" :class="{ on: state.loading }" aria-hidden="true" />

      <!-- full-screen state when the KernelSU bridge is missing: nothing on the
           dashboard can work, so don't tease an empty UI -->
      <div v-if="!state.connected" class="app-empty">
        <div class="empty-card">
          <div class="empty-mark">
            <AppIcon name="warn" />
          </div>
          <h1>未连接到 KernelSU</h1>
          <p>{{ state.lastError ?? '本页面需要以模块 WebUI 的形式在 KernelSU 管理器内打开，才能读写 /data 下的数据库。' }}</p>
          <div class="empty-actions">
            <button class="primary" @click="retryConnect">重新检测</button>
          </div>
          <p class="tiny faint">如果你是在浏览器里直接打开的，看到这个提示是正常的。</p>
        </div>
      </div>

      <div v-else class="main-inner">
        <div v-if="state.lastError" class="banner error">
          <strong>操作失败</strong>
          <span>{{ state.lastError }}</span>
          <div class="banner-actions">
            <button class="ghost sm" @click="dismissError">知道了</button>
          </div>
        </div>

        <div v-if="state.parseIssues.length" class="banner warn">
          <strong>有 {{ state.parseIssues.length }} 行配置无法解析</strong>
          <span>{{ parseIssueSummary }}</span>
          <span class="tiny">这些行的原始内容仍保留在数据库里，本模块不会写回它们；其余配置可以正常查看和提交。</span>
        </div>

        <KeepAlive :max="14">
          <component :is="currentView" />
        </KeepAlive>
      </div>

      <!-- dirty commit bar: fixed so edits never shift the page -->
      <transition name="commit">
        <div v-if="state.dirty" class="commit-bar">
          <span class="commit-dot" />
          <div class="commit-text">
            <b>有未提交的修改</b>
            <span>写入设备后才会生效，提交前会自动备份。</span>
          </div>
          <div class="commit-actions">
            <button class="ghost sm" @click="handleDiscard" :disabled="state.loading">丢弃</button>
            <button class="primary sm" @click="handlePush" :disabled="state.loading">
              {{ state.loading ? '写入中…' : '提交到设备' }}
            </button>
          </div>
        </div>
      </transition>
    </main>

    <ToastStack />
    <DialogStack />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, h, onMounted, ref, watch, type Component } from 'vue';
import { state, initialize, pullAll, pushAll } from '@/state/session';
import { preflightCloudConfig } from '@/db/preflight';
import { isCloudLocked } from '@/db/merge';
import { scanFpsLock } from '@/parsers/fpslock';
import { toast } from '@/state/toast';
import OverviewView from '@/ui/OverviewView.vue';
import ToastStack from '@/ui/ToastStack.vue';
import DialogStack from '@/ui/DialogStack.vue';
import AppIcon from '@/ui/AppIcon.vue';
import { dialog } from '@/state/dialog';
import { theme, cycleTheme } from '@/state/theme';
import { activeView as view, drawerOpen, navigate, type ViewId } from '@/state/nav';
import { GROUP_LABELS, GROUP_ORDER, VIEWS, VIEW_LIST, pagesFor } from '@/ui/views';

// Async chunks can fail inside the WebView (stale cache → 404 on a hashed
// chunk, or MIME rejection). Rather than parking the UI on "加载中…" forever,
// surface a real error with a reload hint.
const AsyncErrorView = {
  setup: () => () =>
    h('div', { class: 'banner error' }, [
      h('strong', '视图加载失败'),
      h('span', '资源请求超时或被 WebView 拒绝 — 刷新页面或重装模块后重试。'),
    ]),
};

const LOADING_STUB = {
  setup: () => () => h('div', { class: 'panel', style: 'color: var(--text-faint); font-size: 13px' }, '加载中…'),
};

function asyncView(loader: () => Promise<unknown>) {
  return defineAsyncComponent({
    loader: loader as () => Promise<any>,
    errorComponent: AsyncErrorView,
    loadingComponent: LOADING_STUB,
    timeout: 15000,
    delay: 120,
  });
}

/** Built from the registry, so a new page needs no edit here. Overview is
 *  already in the main chunk (it is the first screen); wrapping it in an
 *  async component would add a loading flash to every cold start. */
const viewComponents = Object.fromEntries(
  VIEW_LIST.map((v) => [v.id, v.id === 'overview' ? OverviewView : asyncView(v.load)]),
) as Record<ViewId, Component>;

const version = __APP_VERSION__;

// Collapse the sticky page header on mobile once the user scrolls: title bar
// stays, description + action row fold away so the form gets the viewport.
//
// Two details keep this from flapping:
//  * the thresholds are asymmetric (collapse late, expand only at the very
//    top), so a 1–2px jitter around a single value can't toggle the state;
//  * `.main` opts out of scroll anchoring (see main.css) — folding the header
//    removes ~70px of content *above* everything else, and the browser's
//    anchoring compensation used to drag scrollTop back to 0, which both
//    undid the scroll and re-triggered the "expand" branch.
const mainEl = ref<HTMLElement | null>(null);
const COLLAPSE_AT = 64;
const EXPAND_AT = 8;
// Distance over which the mobile header's soft edge under the title bar fades
// in. Exposed as `--sy-p` (0 → 1) so the gradient tracks the gesture instead
// of appearing all at once at a threshold.
const HEAD_FADE_PX = 56;
const scrolled = ref(false);
let scrollTick = false;

function onScroll() {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    const top = mainEl.value?.scrollTop ?? 0;
    // Continuous 0→1 progress for the header edge: a scroll-linked value
    // instead of a boolean class, so the fade under the bar grows with the
    // gesture and nothing pops at the collapse threshold.
    const p = Math.min(Math.max(top / HEAD_FADE_PX, 0), 1);
    mainEl.value?.style.setProperty('--sy-p', p.toFixed(3));
    const next = scrolled.value ? top > EXPAND_AT : top > COLLAPSE_AT;
    if (next !== scrolled.value) scrolled.value = next;
  });
}

// Views start at the top: swapping the component leaves `.main` scrollTop
// where the previous page left it, which reads as a broken page header (it
// would still be collapsed on a page you have not scrolled yet).
watch(view, () => {
  scrolled.value = false;
  mainEl.value?.style.setProperty('--sy-p', '0');
  if (mainEl.value) mainEl.value.scrollTop = 0;
});

interface NavItem {
  id: ViewId;
  label: string;
  icon: string;
  badge?: string;
  badgeTone?: string;
}

/** Badges are the only per-page data that is not static: they follow the
 *  pulled config and change while the user works. Kept out of the registry
 *  so the table stays a plain constant. */
function navBadge(id: ViewId): { text: string; tone?: string } | undefined {
  switch (id) {
    case 'overview':
      return state.stat ? { text: `${pathsActive.value}/4` } : undefined;
    case 'lock':
      return isLocked.value ? { text: '已冻结', tone: 'warn' } : undefined;
    case 'gamelist':
      return gameListCount.value ? { text: String(gameListCount.value) } : undefined;
    case 'mifisr':
      return { text: pathCount('mifisr') };
    case 'frc':
      return { text: pathCount('qualcomm') };
    case 'novatek':
      return { text: pathCount('novatek') };
    case 'mivk':
      return { text: `${pathCount('mivk')}·${pathCount('migl')}` };
    case 'unlockfps':
      return fpsLockBadge.value ? { text: fpsLockBadge.value, tone: 'warn' } : undefined;
    default:
      return undefined;
  }
}

const navGroups = computed<{ label: string; items: NavItem[] }[]>(() => {
  const pages = pagesFor(state.activeBackend);
  return GROUP_ORDER.map((group) => ({
    label: GROUP_LABELS[group],
    items: pages
      .filter((v) => v.group === group)
      .map((v) => {
        const badge = navBadge(v.id);
        return {
          id: v.id,
          label: v.label,
          icon: v.icon,
          badge: badge?.text,
          badgeTone: badge?.tone,
        };
      }),
  })).filter((g) => g.items.length > 0);
});

const meta = computed(() => VIEWS[view.value]);

const currentView = computed<Component>(() => viewComponents[view.value]);

// Bounce back to overview if the selected backend-specific editor no longer
// matches the device (e.g. re-pulled from a different phone).
watch(
  () => state.activeBackend,
  (backend) => {
    if (view.value === 'frc' && backend !== 'qualcomm') view.value = 'overview';
    else if (view.value === 'mifisr' && backend !== 'mifisr') view.value = 'overview';
    else if (view.value === 'novatek' && backend !== 'novatek') view.value = 'overview';
  },
);

function onNavClick(event: Event) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.nav-btn')) drawerOpen.value = false;
}

/** The only user-facing way to change tabs, so a view with unsaved work gets
 *  to veto the switch (see setLeaveGuard in state/nav). */
function go(id: ViewId) {
  void navigate(id);
}

onMounted(async () => {
  await initialize();
  // Warm the remaining view chunks while the device is idle so tab switches
  // paint immediately instead of waiting on a 20–80 KB parse.
  const idle = (window as any).requestIdleCallback ?? ((cb: any) => setTimeout(cb, 800));
  idle(() => {
    for (const v of VIEW_LIST) {
      if (v.id === view.value) continue;
      v.load().catch(() => null);
    }
  });
});

const pathsActive = computed(() => state.paths.filter((p) => p.active).length);
const isLocked = computed(() => isCloudLocked(state.cloudConfig));

const fpsLockBadge = computed(() => {
  const booster = state.cloudConfig.booster_config?.params;
  if (!booster) return '';
  const n = scanFpsLock(booster).totalKeys;
  return n > 0 ? String(n) : '';
});

const gameListCount = computed(() => {
  const gl = state.cloudConfig.common_config?.params?.game_list;
  return Array.isArray(gl) ? gl.length : null;
});

function pathCount(id: string): string {
  const p = state.paths.find((x) => x.id === id);
  return p ? String(p.count) : '—';
}

const parseIssueSummary = computed(() => {
  const issues = state.parseIssues;
  const shown = issues
    .slice(0, 4)
    .map((i) => `${i.db === 'smartp' ? 'SmartP' : 'teg'}:${i.config}（${i.message}）`)
    .join('；');
  return issues.length > 4 ? `${shown} 等 ${issues.length} 行` : shown;
});

const themeIcon = computed(() => (theme.mode === 'auto' ? 'auto' : theme.mode === 'light' ? 'sun' : 'moon'));
const themeLabel = computed(() => {
  if (theme.mode === 'auto') return `跟随系统 · ${theme.effective === 'light' ? '浅' : '深'}`;
  return theme.mode === 'light' ? '浅色' : '深色';
});
const themeTitle = computed(() => `切换主题（当前：${theme.mode}），循环 跟随系统 → 浅色 → 深色`);

function dismissError() {
  state.lastError = null;
}

async function retryConnect() {
  await initialize();
}

async function handlePush() {
  // Stop before the note prompt: no point collecting a message for a commit
  // that would land rows Joyose cannot match to any game.
  const issues = preflightCloudConfig(state.cloudConfig);
  if (issues.length) {
    const lines = issues.slice(0, 5).map((i) => `· ${i.where}：${i.message}`);
    if (issues.length > 5) lines.push(`… 另有 ${issues.length - 5} 条`);
    await dialog.alert(
      `有 ${issues.length} 处配置还是占位内容`,
      `${lines.join('\n')}\n\n请先到对应页面改成真实包名，再提交。`,
    );
    return;
  }
  const note = await dialog.prompt('提交修改到设备', {
    detail: '给本次修改加一段备注（可留空），会写进历史记录。',
    placeholder: '例如：开启 17 PM MIFISR 原神插帧',
  });
  if (note === null) return;
  try {
    const res = await pushAll({ note });
    // One code, one branch. The booleans behind it (stop confirmed, restart
    // observed) are still reported separately for the lines that need them,
    // but the decision of *which* message to show no longer depends on the
    // order in which those booleans happen to be checked here.
    const name = res.file ?? '';
    switch (res.result.code) {
      case 'no-change':
        toast.info('没有改动', '工作区与设备上的配置一致，未写入数据库、未写历史、未重启 Joyose');
        return;
      case 'out-of-scope':
        toast.warn(
          '改动没有被写入',
          '被修改的配置不在当前「写入目标」范围内，请到概览页调整后重新提交',
        );
        return;
      case 'written-no-history':
        toast.warn(
          '已写入设备，但历史记录没有保存',
          `${res.historyError} · 配置已经生效，只是这次提交不在历史里`,
        );
        return;
      case 'written-restart-failed':
        toast.warn(
          '已写入设备，但 Joyose 重启失败',
          `${res.restartError} · 请手动重启 Joyose 或手机后再进游戏`,
        );
        return;
      case 'written-stop-failed':
        toast.warn(
          '已写入，但 Joyose 未能停止 —— 请手动重启它（或重启手机）后再进游戏',
          name,
        );
        return;
      case 'written-rebased':
        toast.success('已提交（云端更新已合并）', `${name} · 提交前 Joyose 刚拉过云控，已自动把你的改动叠加到新配置上`);
        return;
      case 'written':
        // Restarting Joyose right after the write means it has already read the
        // new rows; without this the first game launch raced the cold start and
        // the edit only showed up on the second one.
        toast.success('已提交，Joyose 已重新加载配置', `${name} · 直接进游戏即可，不需要再开一遍`);
        return;
      case 'written-stopped':
        toast.info('已提交', `${name} · Joyose 已停止，下次启动游戏时会读取新配置`);
        return;
      case 'written-reload-unconfirmed':
        toast.warn(
          '已提交，但没能确认 Joyose 已重新启动',
          `${name} · 进游戏前若配置没生效，请手动重启 Joyose`,
        );
        return;
      default:
        toast.success('已提交并写入历史', name);
    }
  } catch (err) {
    toast.fromError(err, '提交失败');
  }
}

async function handleDiscard() {
  const ok = await dialog.confirm('放弃未提交修改？', {
    detail: '本地所有未提交修改会丢失，从设备重新拉取一份干净的副本。',
    okText: '丢弃并拉取',
    destructive: true,
  });
  if (!ok) return;
  try {
    const r = await pullAll();
    if (!r.ok) {
      toast.fromError(new Error(r.error), '拉取失败');
      return;
    }
    toast.info('已重新从设备拉取');
  } catch (err) {
    toast.fromError(err, '拉取失败');
  }
}
</script>

<style scoped>
.progress-line {
  position: sticky;
  top: 0;
  z-index: 40;
  height: 2px;
  width: 100%;
  opacity: 0;
  background: linear-gradient(90deg, transparent, var(--accent), var(--cyan), transparent);
  background-size: 40% 100%;
  background-repeat: no-repeat;
  transition: opacity 0.2s ease;
}

.progress-line.on {
  opacity: 1;
  animation: slide 1.1s linear infinite;
}

@keyframes slide {
  from {
    background-position: -40% 0;
  }

  to {
    background-position: 140% 0;
  }
}

.commit-bar {
  position: fixed;
  left: 50%;
  bottom: calc(18px + var(--safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(560px, calc(100vw - 28px));
  padding: 10px 12px 10px 16px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--accent-line);
  box-shadow: var(--shadow-medium);
}

.commit-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 0 4px rgba(247, 185, 85, 0.16);
}

.commit-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.commit-text b {
  font-size: 13px;
  font-weight: 600;
}

.commit-text span {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.commit-enter-active,
.commit-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.commit-enter-from,
.commit-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

/* keep the floating commit bar from covering the last card */
.main.has-pending .main-inner {
  padding-bottom: 96px;
}

/* ---- disconnected state ---- */
.app-empty {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: 24px;
}

.empty-card {
  width: min(420px, 100%);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 24px;
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  border: 1px solid var(--border);
}

.empty-mark {
  width: 46px;
  height: 46px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: var(--surface-warn-bg);
  border: 1px solid var(--surface-warn-border);
  color: var(--warn);
  margin-bottom: 4px;
}

.empty-mark :deep(svg) {
  width: 24px;
  height: 24px;
}

.empty-card h1 {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.empty-card p {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
}

.empty-actions {
  margin-top: 6px;
}

@media (max-width: 860px) {
  .commit-bar {
    bottom: calc(10px + var(--safe-area-inset-bottom, 0px));
    padding: 9px 10px 9px 14px;
  }

  .commit-text span {
    display: none;
  }
}
</style>
