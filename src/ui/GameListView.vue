<template>
  <div class="stack">
    <PageHeader title="游戏列表" kicker="game_list / support_app"
      desc="Joyose 依据这两个名单决定是否为某个应用应用游戏策略。game_list 为正式纳入优化，support_app 是更宽泛的支持列表。" />

    <div class="grid-2">
      <PackageListEditor title="game_list" :packages="gameList" @update="(v: string[]) => update('game_list', v)" />
      <PackageListEditor title="support_app" :packages="supportApp"
        @update="(v: string[]) => update('support_app', v)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state, markDirty } from '@/state/session';
import PageHeader from './PageHeader.vue';
import PackageListEditor from './PackageListEditor.vue';

const gameList = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.game_list ?? [];
});
const supportApp = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.support_app ?? [];
});

function update(key: 'game_list' | 'support_app', next: string[]) {
  const cc = state.cloudConfig.common_config;
  if (!cc) return;
  if (!cc.params) cc.params = {};
  cc.params[key] = next;
  markDirty();
}
</script>
