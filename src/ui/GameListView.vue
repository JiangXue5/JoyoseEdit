<template>
  <div class="stack">
    <PageHeader title="游戏列表" kicker="game_list / support_app"
      desc="Joyose 依据这两个名单决定是否为某个应用应用游戏策略。game_list 为正式纳入优化，support_app 是更宽泛的支持列表。" />

    <div v-if="!hasCommon" class="panel">
      <div class="empty-state">
        <strong>common_config 不可用</strong>
        <p class="hint">
          SmartP 里没有 common_config。如果 teg_config 有，可在概览页把数据源切成「允许 teg 兜底」；
          否则等 Joyose 联网下发后再刷新。
        </p>
      </div>
    </div>

    <div v-else class="grid-2">
      <PackageListEditor title="game_list" :packages="gameList" @update="(v: string[]) => update('game_list', v)" />
      <PackageListEditor title="support_app" :packages="supportApp"
        @update="(v: string[]) => update('support_app', v)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state, markDirty, sourceUsable } from '@/state/session';
import PageHeader from './PageHeader.vue';
import PackageListEditor from './PackageListEditor.vue';

const gameList = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.game_list ?? [];
});
const supportApp = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.support_app ?? [];
});

/** Respects the data-source policy: SmartP always counts, teg only when the
 *  user allowed the fallback. */
const hasCommon = computed(() => sourceUsable('common_config'));

function update(key: 'game_list' | 'support_app', next: string[]) {
  // Never create or write a config the source policy says is unavailable.
  if (!sourceUsable('common_config')) return;
  const cc = state.cloudConfig.common_config;
  if (!cc) return;
  if (!cc.params) cc.params = {};
  cc.params[key] = next;
  markDirty();
}
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
}

.empty-state strong {
  font-size: 14px;
  font-weight: 600;
}
</style>
