// One table for the whole page registry.
//
// Before this existed, adding a page meant editing four places in App.vue
// (the loader map, the async component constants, VIEW_META and the
// currentView switch) and a fifth one for the sidebar entry. Forgetting any
// of them gave a page that could be navigated to but rendered nothing, or a
// header with the wrong title. The table below is now the only list.
//
// Badges stay in App.vue: they read reactive session state and change while
// the user works, while this file is static configuration.

import type { Component } from 'vue';
import type { ViewId } from '@/state/nav';
import OverviewView from '@/ui/OverviewView.vue';

export type NavGroupId = 'dashboard' | 'enhance' | 'tuning' | 'tools';

/** Backend-specific pages are only offered on the matching device. The
 *  overview page still explains the other backends, so hiding them is a
 *  navigation decision, not a capability claim. */
export type BackendId = 'mifisr' | 'qualcomm' | 'novatek';

export interface ViewDef {
  id: ViewId;
  /** Sidebar label; kept short so it fits a 390px drawer. */
  label: string;
  icon: string;
  group: NavGroupId;
  /** Page header title (may be longer than the sidebar label). */
  title: string;
  desc: string;
  /** When set, the page only appears for this active backend. */
  backend?: BackendId;
  /** Dynamic import. `overview` resolves to an already-loaded component. */
  load: () => Promise<unknown>;
}

export const GROUP_ORDER: NavGroupId[] = ['dashboard', 'enhance', 'tuning', 'tools'];

export const GROUP_LABELS: Record<NavGroupId, string> = {
  dashboard: 'Dashboard',
  enhance: '画质增强',
  tuning: '帧率与温控',
  tools: '工具',
};

export const VIEWS: Record<ViewId, ViewDef> = {
  overview: {
    id: 'overview',
    label: '概览',
    icon: 'overview',
    group: 'dashboard',
    title: '概览',
    desc: '设备上的 Joyose 数据库状态、可用增强通路与备份入口。',
    load: () => Promise.resolve({ default: OverviewView }),
  },
  lock: {
    id: 'lock',
    label: '云控锁定',
    icon: 'lock',
    group: 'dashboard',
    title: '云控锁定',
    desc: '冻结 teg 云控版本，避免云端下发覆盖本地修改。',
    load: () => import('@/ui/LockView.vue'),
  },
  gamelist: {
    id: 'gamelist',
    label: '游戏列表',
    icon: 'list',
    group: 'dashboard',
    title: '游戏列表',
    desc: 'Joyose 依据这两个名单决定是否为某个应用应用游戏策略。',
    load: () => import('@/ui/GameListView.vue'),
  },
  mifisr: {
    id: 'mifisr',
    label: 'MIFISR',
    icon: 'spark',
    group: 'enhance',
    title: 'MIFISR 画质增强',
    desc: '小米 17 系列的插帧 + 超分配置，逐游戏维护。',
    backend: 'mifisr',
    load: () => import('@/ui/MifisrView.vue'),
  },
  frc: {
    id: 'frc',
    label: '高通 GPU',
    icon: 'cpu',
    group: 'enhance',
    title: '高通 GPU',
    desc: '骁龙 8 Elite 机型的 AFME / FRC / FSR 通路（未实机验证）。',
    backend: 'qualcomm',
    load: () => import('@/ui/FrcView.vue'),
  },
  novatek: {
    id: 'novatek',
    label: 'Novatek 独显',
    icon: 'monitor',
    group: 'enhance',
    title: 'Novatek 独显',
    desc: '红米独显机型的 NT# 策略与温控参数。',
    backend: 'novatek',
    load: () => import('@/ui/NovatekView.vue'),
  },
  mivk: {
    id: 'mivk',
    label: '渲染模块',
    icon: 'layers',
    group: 'enhance',
    title: '渲染模块',
    desc: 'MIVK / MIGL 渲染 hook 的模块开关与等级。',
    load: () => import('@/ui/MivkView.vue'),
  },
  unlockfps: {
    id: 'unlockfps',
    label: '去除锁帧',
    icon: 'gauge',
    group: 'tuning',
    title: '去除锁帧',
    desc: '清除或推迟 Joyose 的帧率限制，两种力度可选。',
    load: () => import('@/ui/UnlockFpsView.vue'),
  },
  thermal: {
    id: 'thermal',
    label: '温度解锁',
    icon: 'thermo',
    group: 'tuning',
    title: '温度解锁',
    desc: '抬高插帧 / 超分的温控降档阈值。',
    load: () => import('@/ui/ThermalUnlockView.vue'),
  },
  json: {
    id: 'json',
    label: '参数树',
    icon: 'braces',
    group: 'tools',
    title: '参数树编辑',
    desc: '直接编辑云控参数树，适合排查与专家级调整。',
    load: () => import('@/ui/JsonEditorView.vue'),
  },
  history: {
    id: 'history',
    label: '编辑历史',
    icon: 'clock',
    group: 'tools',
    title: '编辑历史',
    desc: '每次提交产生一条增量记录，可随时回到任意节点。',
    load: () => import('@/ui/HistoryView.vue'),
  },
  importexport: {
    id: 'importexport',
    label: '导入 / 导出',
    icon: 'swap',
    group: 'tools',
    title: '导入 / 导出',
    desc: '把配置打包成 JSON，用于备份或跨设备迁移。',
    load: () => import('@/ui/ImportExportView.vue'),
  },
};

export const VIEW_LIST: ViewDef[] = Object.values(VIEWS);

/** Pages visible for a given backend, in sidebar order. */
export function pagesFor(backend: BackendId | null): ViewDef[] {
  return VIEW_LIST.filter((v) => !v.backend || v.backend === backend);
}

export type ViewComponent = Component;
