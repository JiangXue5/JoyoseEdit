<template>
  <!-- The action row lives *outside* the sticky header on mobile: it belongs to
       the page body, so it scrolls away with the cards instead of vanishing in
       one frame when the header collapses. Desktop keeps the old single-row
       layout through the wrapper grid. -->
  <div class="page-head-wrap">
    <header class="page-head">
      <button class="hamburger page-hamburger" @click="drawerOpen = !drawerOpen" aria-label="打开菜单">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <div class="page-head-text">
        <div v-if="kicker" class="page-kicker">{{ kicker }}</div>
        <h1 class="page-title">{{ title }}</h1>
        <div v-if="desc" class="page-desc-wrap">
          <p class="page-desc">{{ desc }}</p>
        </div>
      </div>
    </header>

    <div v-if="$slots.default" class="page-actions">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { drawerOpen } from '@/state/nav';

defineProps<{ title: string; desc?: string; kicker?: string }>();
</script>
