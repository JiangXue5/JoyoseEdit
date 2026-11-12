<template>
  <div class="stack">
    <div v-if="backendMismatch" class="banner error">
      <strong>此面板不适用于当前机型</strong>
      <span class="hint">当前机型不走此后端，改动不会生效。Novatek 面板仅对带独显的机型有意义。</span>
    </div>

    <PageHeader title="Novatek 独显" kicker="红米独显 · 未实机验证"
      desc="仅适用于带独显（d1 / d2）的机型，典型为红米至尊版系列。本机若未下发相关键，本页会显示为空。">
      <button class="ghost" @click="pasteImport">粘贴导入</button>
      <button class="primary" @click="addBlank">+ 新建</button>
    </PageHeader>

    <div class="panel">
      <div class="row" style="justify-content: space-between">
        <label class="row" style="gap: 6px">
          <span class="label" style="margin: 0">列表</span>
          <select v-model="listKey">
            <option value="main">游戏中配置 ({{ counts.main }})</option>
            <option value="nonplay">非游戏配置 ({{ counts.nonplay }})</option>
          </select>
        </label>
        <button class="ghost sm" @click="quickUnlockThermal">一键温控 95/93/93/91</button>
      </div>
    </div>

    <div v-if="!anyNovatek" class="banner warn">
      <strong>该设备未下发独显相关配置</strong>
      <span class="hint">可以新建条目，但没有独显硬件时不会实际生效。</span>
    </div>

    <div class="twopane">
      <div class="list">
        <button v-for="(s, i) in entries" :key="i" class="item" :class="{ active: selected === i }"
          @click="selected = i">
          <strong>{{ displayPkg(s) }}</strong>
          <span class="sub">{{ s }}</span>
        </button>
        <div v-if="entries.length === 0" class="hint" style="padding: var(--space-3)">（空）</div>
      </div>

      <div v-if="currentParsed" class="detail stack">
        <div class="row">
          <strong class="mono">{{ currentParsed.pkg }}</strong>
          <button class="danger ghost" @click="removeCurrent" style="margin-left: auto">删除</button>
        </div>
        <div class="field">
          <label class="label">包名</label>
          <input v-model="currentParsed.pkg" @input="rewrite" />
        </div>

        <div class="grid-3">
          <NovatekSegmentCard label="Set A ── 独显方案 A" :segment="currentParsed.setA" @change="rewrite" />
          <NovatekSegmentCard label="Set GPU ── GPU 备选" :segment="currentParsed.setGpu" @change="rewrite" />
          <NovatekSegmentCard label="Set B ── 独显方案 B" :segment="currentParsed.setB" @change="rewrite" />
        </div>

        <div class="panel" style="margin: 0; background: var(--bg-elevated)">
          <div class="label">序列化结果</div>
          <div class="mono tiny" style="word-break: break-all">{{ entries[selected] }}</div>
          <div v-if="issues.length" class="stack" style="margin-top: var(--space-2)">
            <div v-for="(i, k) in issues" :key="k" class="tiny" style="color: var(--warn)">
              ⚠ <span class="mono">{{ i.segment }}</span>: {{ i.message }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="detail hint">从列表里选一条。</div>
    </div>

    <div class="panel">
      <h2>附属配置</h2>
      <div class="grid-2">
        <PackageListEditor title="novatek_black_app" :packages="blackApp"
          @update="(v: string[]) => updateNovatekAux('novatek_black_app', v)" />
        <PackageListEditor title="novatek_gex_fps_limit" :packages="gexLimit"
          @update="(v: string[]) => updateNovatekAux('novatek_gex_fps_limit', v)" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { state, markDirty } from '@/state/session';
import {
  parseNovatek,
  serializeNovatek,
  validateNovatek,
  setThermal,
  blankNovatek,
  type NovatekParams,
} from '@/parsers/novatek-string';
import PageHeader from './PageHeader.vue';
import { rafThrottle } from '@/utils/raf';
import NovatekSegmentCard from './NovatekSegmentCard.vue';
import PackageListEditor from './PackageListEditor.vue';
import { toast } from '@/state/toast';
import { dialog } from '@/state/dialog';

const listKey = ref<'main' | 'nonplay'>('main');
const selected = ref(0);

const backendMismatch = computed(
  () => state.activeBackend !== null && state.activeBackend !== 'novatek',
);

const entries = computed<string[]>({
  get: () => {
    const gb = state.cloudConfig.booster_config?.params?.game_booster ?? {};
    if (listKey.value === 'main') return Array.isArray(gb.novatek_game_params) ? gb.novatek_game_params : [];
    return gb.novatek_extend_config?.novatek_non_playing_config ?? [];
  },
  set: (val: string[]) => {
    const gb = ensureGameBooster();
    if (listKey.value === 'main') {
      gb.novatek_game_params = val;
    } else {
      if (!gb.novatek_extend_config) gb.novatek_extend_config = {};
      gb.novatek_extend_config.novatek_non_playing_config = val;
    }
    markDirty();
  },
});

const counts = computed(() => {
  const gb = state.cloudConfig.booster_config?.params?.game_booster ?? {};
  return {
    main: gb.novatek_game_params?.length ?? 0,
    nonplay: gb.novatek_extend_config?.novatek_non_playing_config?.length ?? 0,
  };
});

const anyNovatek = computed(() => state.paths.find((p) => p.id === 'novatek')?.active === true);

const currentParsed = ref<NovatekParams | null>(null);

// Only re-parse on list-identity changes (length / listKey) or selection move.
// In-place mutations from rewrite() must not trigger re-parse, otherwise a
// transient invalid edit (e.g. user clears a field) would wipe currentParsed
// and destroy the form under the user's cursor.
watch(
  [() => entries.value.length, selected, listKey],
  () => {
    const e = entries.value;
    if (e.length === 0) {
      currentParsed.value = null;
      return;
    }
    if (selected.value >= e.length) selected.value = 0;
    try {
      currentParsed.value = parseNovatek(e[selected.value]);
    } catch {
      currentParsed.value = null;
    }
  },
  { immediate: true },
);

const issues = computed(() => {
  if (!currentParsed.value) return [];
  return validateNovatek(currentParsed.value);
});

const blackApp = computed<string[]>(() => {
  return state.cloudConfig.booster_config?.params?.game_booster?.novatek_black_app ?? [];
});
const gexLimit = computed<string[]>(() => {
  return state.cloudConfig.booster_config?.params?.game_booster?.novatek_gex_fps_limit ?? [];
});

function ensureGameBooster(): any {
  const cc = state.cloudConfig.booster_config;
  if (!cc) throw new Error('booster_config missing');
  if (!cc.params) cc.params = {};
  if (!cc.params.game_booster) cc.params.game_booster = {};
  return cc.params.game_booster;
}

function updateNovatekAux(key: 'novatek_black_app' | 'novatek_gex_fps_limit', v: string[]) {
  ensureGameBooster()[key] = v;
  markDirty();
}

function displayPkg(s: string): string {
  return s.split('_', 1)[0];
}

function rewriteNow() {
  if (!currentParsed.value) return;
  try {
    const serialized = serializeNovatek(currentParsed.value);
    const list = entries.value.slice();
    list[selected.value] = serialized;
    entries.value = list;
  } catch (err) {
    console.warn('novatek serialize failed:', err);
  }
}


// Serialising on every keystroke re-created the array (watch source) and
// re-rendered the selector; one write per frame is plenty.
const rewrite = rafThrottle(rewriteNow);

async function addBlank() {
  const pkg = await dialog.prompt('新条目的包名', {
    detail: '会生成一条空白 novatek_game_params 模板，随后可在详情区域编辑。',
    initialValue: 'com.example.newgame',
  });
  if (!pkg) return;
  const p = blankNovatek(pkg);
  const serialized = serializeNovatek(p);
  entries.value = [...entries.value, serialized];
  selected.value = entries.value.length - 1;
}

async function pasteImport() {
  const raw = await dialog.prompt('粘贴一条 novatek_game_params 原始字符串', {
    detail: '格式：包名 _ 独显A _ GPU _ 独显B，每段 # 分 7 字段。',
    multiline: true,
    placeholder: 'com.example.pkg_...#...#...#...',
  });
  if (!raw) return;
  try {
    parseNovatek(raw); // validate
    entries.value = [...entries.value, raw];
    selected.value = entries.value.length - 1;
    toast.success('导入成功');
  } catch (err) {
    toast.fromError(err, '解析失败');
  }
}

function quickUnlockThermal() {
  if (!currentParsed.value) return;
  setThermal(currentParsed.value, '95', '93', '93', '91');
  rewrite();
}

function removeCurrent() {
  entries.value = entries.value.filter((_, i) => i !== selected.value);
  selected.value = Math.max(0, selected.value - 1);
}
</script>
