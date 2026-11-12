import { createApp } from 'vue';
import App from './App.vue';
import { initTheme } from '@/state/theme';
import { hydratePrefs } from '@/state/source';
import './styles/main.css';

// Ask KernelSU WebView to draw behind the status / navigation bars.
// index.html also links /internal/insets.css which triggers the same thing
// implicitly; calling the JS API belt-and-suspenders for older KSU builds
// that expose the API but not the /internal/* path handler (or vice versa).
// Both are no-ops outside a KernelSU host — wrap in try/catch because older
// kernelsu npm builds will throw when ksu.enableEdgeToEdge is undefined.
async function enableEdgeToEdge(): Promise<void> {
  try {
    const ksu = (window as any).ksu;
    if (ksu && typeof ksu.enableEdgeToEdge === 'function') {
      ksu.enableEdgeToEdge(true);
    }
  } catch {
    /* non-KSU environment or unsupported host */
  }
}

enableEdgeToEdge();
initTheme();
// Load the settings file before the first render: every picker is initialised
// synchronously from the preference cache, so mounting first would paint the
// defaults and leave them there. Each runner is a `cat` of a tiny file, and
// hydratePrefs swallows failures, so this cannot hold the UI hostage.
hydratePrefs()
  .catch(() => undefined)
  .finally(() => createApp(App).mount('#app'));
