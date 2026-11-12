<template>
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

// Single-file icon set: stroke paths on a 24×24 grid. Keeping them inline
// avoids a font/animation dependency and any network request inside the
// KernelSU WebView.
const ICONS: Record<string, string[]> = {
  overview: ['M4 13h6V4H4v9Z', 'M14 20h6v-9h-6v9Z', 'M4 20h6v-4H4v4Z', 'M14 8h6V4h-6v4Z'],
  lock: ['M6 11h12v9H6z', 'M9 11V7.5a3 3 0 0 1 6 0V11', 'M12 15v2'],
  list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  spark: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z', 'M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z'],
  cpu: ['M7 7h10v10H7z', 'M4 10V8h3M4 14v2h3M17 8h3v2M17 16h3v-2', 'M10 4v3M14 4v3M10 17v3M14 17v3'],
  monitor: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  layers: ['M12 3l9 5-9 5-9-5 9-5Z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  braces: ['M8 4H6a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2', 'M16 4h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  swap: ['M4 8h13l-3-3', 'M20 16H7l3 3'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z'],
  auto: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 3v18'],
  refresh: ['M20 11a8 8 0 1 0-.6 4', 'M20 4v7h-7'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M20 6L9 17l-5-5'],
  shield: ['M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3Z', 'M9.5 12l1.8 1.8 3.4-3.4'],
  chip: ['M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3', 'M7 7h10v10H7z'],
  db: ['M12 7c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z', 'M20 4v6c0 1.7-3.6 3-8 3s-8-1.3-8-3V4', 'M20 10v6c0 1.7-3.6 3-8 3s-8-1.3-8-3v-6'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5M12 8h.01'],
  warn: ['M12 4l8.5 15h-17L12 4Z', 'M12 10v4M12 17h.01'],
};

const props = defineProps<{ name: string }>();
const paths = computed(() => ICONS[props.name] ?? ICONS.info);
</script>
