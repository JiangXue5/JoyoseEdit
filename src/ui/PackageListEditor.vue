<template>
  <div class="panel">
    <div class="panel-header">
      <h2>{{ title }} <small>{{ packages.length }} 条</small></h2>
    </div>

    <div class="pkg-toolbar">
      <input v-model="filter" class="pkg-filter" placeholder="筛选包名" />
      <button class="ghost sm" @click="bulkPaste">批量</button>
      <button class="ghost sm" @click="dedupe">去重</button>
    </div>

    <div class="pkg-add">
      <input v-model="newPkg" placeholder="com.example.foo" @keyup.enter="add" />
      <button class="primary sm" @click="add" :disabled="!isLegal(newPkg)">添加</button>
    </div>

    <div class="pkg-list-scroll">
      <div v-for="(p, i) in filtered" :key="p + i" class="pkg-row">
        <span class="mono pkg-name">{{ p }}</span>
        <button class="icon-btn" @click="remove(p)" title="移除">
          <AppIcon name="close" />
        </button>
      </div>
      <div v-if="filtered.length === 0" class="hint" style="padding: 10px 4px">（空）</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { dialog } from '@/state/dialog';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ title: string; packages: string[] }>();
const emit = defineEmits<{ (e: 'update', packages: string[]): void }>();

const filter = ref('');
const newPkg = ref('');

const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return props.packages;
  return props.packages.filter((p) => p.toLowerCase().includes(f));
});

function isLegal(p: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_.]+$/.test(p.trim());
}

function add() {
  const p = newPkg.value.trim();
  if (!isLegal(p)) return;
  if (props.packages.includes(p)) return;
  emit('update', [...props.packages, p]);
  newPkg.value = '';
}

function remove(p: string) {
  emit('update', props.packages.filter((x) => x !== p));
}

async function bulkPaste() {
  const text = await dialog.prompt(`批量合并到 ${props.title}`, {
    detail: '用空格、逗号、分号或换行分隔；会去重后与现有包名合并。',
    multiline: true,
    placeholder: 'com.miHoYo.Yuanshen\ncom.miHoYo.hkrpg\n...',
  });
  if (!text) return;
  const fresh = text
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(isLegal);
  const next = Array.from(new Set([...props.packages, ...fresh])).sort();
  emit('update', next);
}

function dedupe() {
  emit('update', Array.from(new Set(props.packages)).sort());
}
</script>

<style scoped>
.pkg-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.pkg-filter {
  flex: 1;
  min-width: 0;
}

.pkg-toolbar :deep(button.ghost) {
  border-color: var(--border);
  color: var(--text-muted);
}

.pkg-add {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.pkg-add input {
  flex: 1;
  min-width: 0;
}

.pkg-list-scroll {
  max-height: 48dvh;
  overflow-y: auto;
  /* Not `contain`: this box covers half the screen on a phone, and trapping
     the gesture here is why scrolling past its end did nothing. */
  overscroll-behavior: auto;
  border-top: 1px solid var(--hairline);
}

.pkg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px 4px 4px;
  border-bottom: 1px solid var(--hairline);
}

.pkg-row:hover {
  background: var(--bg-elevated);
}

.pkg-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 860px) {
  .pkg-list-scroll {
    /* Was 52dvh — more than half the screen turned into an inner scrollbox,
       so the page itself looked frozen wherever the finger landed. */
    max-height: 42dvh;
  }
}
</style>
