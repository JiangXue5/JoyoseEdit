// Minimal navigation store. Views are mounted under a KeepAlive shell in
// App.vue; any view that needs to jump to another tab (e.g. overview →
// cloud lock) imports `navigate()` instead of threading props through the
// async component boundary.
//
// The active tab is persisted so reopening the WebUI lands where the user
// left off.

import { ref, watch } from 'vue';

export type ViewId =
  | 'overview'
  | 'lock'
  | 'unlockfps'
  | 'gamelist'
  | 'frc'
  | 'mifisr'
  | 'novatek'
  | 'mivk'
  | 'json'
  | 'history'
  | 'importexport';

const STORAGE_KEY = 'joyose-edit:view';

function restore(): ViewId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'overview' || v === 'lock' || v === 'unlockfps'
      || v === 'gamelist' || v === 'frc' || v === 'mifisr' || v === 'novatek'
      || v === 'mivk' || v === 'json' || v === 'history' || v === 'importexport') {
      return v;
    }
  } catch {
    /* localStorage blocked */
  }
  return 'overview';
}

export const activeView = ref<ViewId>(restore());

/** Mobile navigation drawer state. The page header owns the hamburger, so
 * both the shell and the header need to read this. */
export const drawerOpen = ref(false);

export function navigate(view: ViewId): void {
  activeView.value = view;
}

watch(activeView, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
});
