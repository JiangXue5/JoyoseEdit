// Minimal navigation store. Views are mounted under a KeepAlive shell in
// App.vue; any view that needs to jump to another tab (e.g. overview →
// cloud lock) imports `navigate()` instead of threading props through the
// async component boundary.
//
// The active tab is persisted so reopening the WebUI lands where the user
// left off.

import { ref, watch } from 'vue';

export const VIEW_IDS = [
  'overview',
  'lock',
  'unlockfps',
  'thermal',
  'gamelist',
  'frc',
  'mifisr',
  'novatek',
  'mivk',
  'json',
  'history',
  'importexport',
  'diagnosis',
] as const;

export type ViewId = (typeof VIEW_IDS)[number];

const STORAGE_KEY = 'joyose-edit:view';

function restore(): ViewId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && (VIEW_IDS as readonly string[]).includes(v)) return v as ViewId;
  } catch {
    /* localStorage blocked */
  }
  return 'overview';
}

export const activeView = ref<ViewId>(restore());

/** Mobile navigation drawer state. The page header owns the hamburger, so
 * both the shell and the header need to read this. */
export const drawerOpen = ref(false);

export function navigate(view: ViewId): Promise<boolean> {
  return requestNavigate(view);
}

/** A view with unsaved work registers itself here while it is on screen.
 *  Tab switches are the only way out and KeepAlive never unmounts the leaving
 *  view, so an unmount hook cannot block anything — the guard has to run
 *  *before* the ref changes, otherwise "取消" comes too late to keep the draft
 *  and the user is told their edits are gone after they already are. */
type LeaveGuard = () => boolean | Promise<boolean>;
let leaveGuard: LeaveGuard | null = null;

/** Pass null on deactivate so a background view cannot veto navigation. */
export function setLeaveGuard(fn: LeaveGuard | null): void {
  leaveGuard = fn;
}

/** Returns false when the guard refused, i.e. the active tab did not change. */
async function requestNavigate(view: ViewId): Promise<boolean> {
  if (view === activeView.value) {
    drawerOpen.value = false;
    return true;
  }
  if (leaveGuard) {
    let allowed = false;
    try {
      allowed = await leaveGuard();
    } catch {
      allowed = false;
    }
    if (!allowed) return false;
  }
  activeView.value = view;
  drawerOpen.value = false;
  return true;
}

watch(activeView, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
});
