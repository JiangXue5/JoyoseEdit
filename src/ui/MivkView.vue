<template>
  <div class="stack">
    <PageHeader title="渲染模块" kicker="MIVK / MIGL"
      desc="配置每个渲染模块的开启等级：0 = 关闭，1–7 分级启用，31 强制开启。这里只是渲染层开关，MIFISR 策略层请去对应面板。">
      <select v-model="channel" aria-label="通道">
        <option value="mivk">MIVK（Vulkan）</option>
        <option value="migl">MIGL（OpenGL）</option>
      </select>
      <button class="ghost" @click="addFromPreset">从预设</button>
      <button class="primary" @click="addBlank">+ 新建条目</button>
    </PageHeader>

    <div class="twopane">
      <div class="list">
        <button v-for="(entry, i) in entries" :key="i" class="item" :class="{ active: selected === i }"
          @click="selected = i">
          <strong>{{ (entry as any)[nameKey(channel)] }}</strong>
          <span class="sub">{{ ((entry as any)[cmdlinesKey(channel)] ?? []).join(', ') }}</span>
        </button>
        <div v-if="entries.length === 0" class="hint" style="padding: var(--space-3)">
          该通道没有条目。点击"新建条目"添加。
        </div>
      </div>

      <div v-if="currentEntry" class="detail stack">
        <div class="row">
          <strong class="mono">{{ (currentEntry as any)[nameKey(channel)] }}</strong>
          <button class="danger ghost" @click="removeCurrent" style="margin-left: auto">删除</button>
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="label">应用 / 游戏短名</label>
            <input :value="(currentEntry as any)[nameKey(channel)]"
              @change="(e: Event) => setName(((e.target as HTMLInputElement)).value)" />
          </div>
          <div class="field">
            <label class="label">主检测信息（checkMainInfo）</label>
            <input :value="currentEntry.xrender_config?.checkMainInfo ?? ''"
              @change="(e: Event) => setCheckMainInfo(((e.target as HTMLInputElement)).value)" />
          </div>
        </div>

        <div class="field">
          <label class="label">匹配包名（逗号或换行分隔）</label>
          <textarea rows="2" :value="((currentEntry as any)[cmdlinesKey(channel)] ?? []).join('\n')"
            @change="(e: Event) => setCmdlines(((e.target as HTMLTextAreaElement)).value)" />
        </div>

        <div class="panel" style="margin: 0; background: var(--bg-elevated)">
          <h2 style="font-size: 14px">模块开关 <small>support_module</small></h2>
          <div class="module-list">
            <div v-for="m in modules" :key="m.name" class="module-row">
              <span class="mono module-name">{{ m.name }}</span>
              <select :value="m.level" aria-label="等级"
                @change="(e: Event) => setLevel(m.name, Number(((e.target as HTMLSelectElement)).value))">
                <option v-for="lv in [0, 1, 2, 3, 4, 5, 6, 7, 31]" :key="lv" :value="lv">{{ lv === 0 ? '0 (关)' : lv
                  === 31 ?
                  '31 (强制)' : `${lv}` }}</option>
              </select>
              <button class="icon-btn" @click="dropModule(m.name)" title="删除模块">
                <AppIcon name="close" />
              </button>
            </div>
            <div v-if="modules.length === 0" class="hint" style="padding: 8px 0">还没有模块，从下方添加。</div>
          </div>
          <div class="row" style="margin-top: var(--space-2)">
            <select v-model="newModuleName" aria-label="模块">
              <option value="" disabled>选择模块…</option>
              <option v-for="n in availableModuleNames" :key="n" :value="n">{{ n }}</option>
            </select>
            <select v-model.number="newModuleLevel">
              <option v-for="lv in [0, 1, 2, 3, 4, 5, 6, 7, 31]" :key="lv" :value="lv">{{ lv === 0 ? '0 (关)' : lv === 31
                ? '31 (强制) ' : `${lv}` }}</option>
            </select>
            <button class="primary" @click="addModule">+ 添加模块</button>
          </div>
        </div>

        <div class="panel" style="margin: 0">
          <h2 style="font-size: 14px">模块参数块 <small>高级：按模块名展开的 JSON 块</small></h2>
          <div v-for="name in moduleBlockKeys" :key="name" style="margin-bottom: var(--space-3)">
            <div class="row">
              <strong class="mono">{{ name }}</strong>
              <button class="ghost" @click="removeBlock(name)">删除块</button>
            </div>
            <textarea rows="5" :value="stringifyBlock((currentEntry as any)[name])"
              style="font-family: var(--font-mono); font-size: 12px; width: 100%"
              @change="(e: Event) => setBlock(name, ((e.target as HTMLTextAreaElement)).value)" />
          </div>
          <div class="row">
            <select v-model="newBlockName">
              <option v-for="n in suggestBlockNames" :key="n" :value="n">{{ n }}</option>
            </select>
            <button class="primary" @click="addBlock">+ 添加模块块</button>
          </div>
        </div>
      </div>
      <div v-else class="detail hint">从列表里选一条。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { state, markDirty } from '@/state/session';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import {
  getEntries,
  setEntries,
  newMivkEntry,
  newMiglEntry,
  cmdlinesKey,
  nameKey,
  modulesOf,
  setModules,
  type Channel,
  type ChannelEntry,
} from '@/parsers/mivk-migl';
import { withModule } from '@/parsers/support-module';
import { toast } from '@/state/toast';
import { dialog } from '@/state/dialog';
import mivkPresets from '@/presets/mivk/index.json';

const channel = ref<Channel>('mivk');
const selected = ref(0);
const newModuleName = ref('misr');
const newModuleLevel = ref<number>(5);
const newBlockName = ref('misr');

const entries = computed<ChannelEntry[]>(() => {
  const gb = state.cloudConfig.booster_config?.params?.game_booster;
  if (!gb) return [];
  return getEntries(gb, channel.value);
});

watch([channel], () => {
  selected.value = 0;
});

const currentEntry = computed<ChannelEntry | null>(() => {
  const e = entries.value;
  if (e.length === 0) return null;
  if (selected.value >= e.length) selected.value = 0;
  return e[selected.value] ?? null;
});

const modules = computed(() => (currentEntry.value ? modulesOf(currentEntry.value) : []));

const availableModuleNames = computed(() => {
  const all = ['mifi', 'misr', 'drr', 'vrs', 'gmem', 'hsre', 'alr', 'sd', 'afme', 'aptssao', 'mrp'];
  const active = new Set(modules.value.map((m) => m.name));
  return all.filter((n) => !active.has(n));
});

const moduleBlockKeys = computed(() => {
  if (!currentEntry.value) return [];
  const structural = new Set([
    'app', 'game', 'app_cmdlines', 'game_cmdlines', 'params', 'xrender_config',
  ]);
  return Object.keys(currentEntry.value).filter(
    (k) => !structural.has(k) && /^(mifi|misr|drr(_static)?|gmem|vrs|aptssao|hsre|alr|afme|sd|mrp|params)$/.test(k),
  );
});

const suggestBlockNames = computed(() => {
  const all = ['mifi', 'misr', 'drr', 'drr_static', 'gmem', 'vrs', 'aptssao', 'hsre', 'alr', 'sd', 'afme', 'mrp'];
  const existing = new Set(moduleBlockKeys.value);
  return all.filter((n) => !existing.has(n));
});

function ensureGameBooster(): any {
  const cc = state.cloudConfig.booster_config;
  if (!cc) throw new Error('booster_config missing');
  if (!cc.params) cc.params = {};
  if (!cc.params.game_booster) cc.params.game_booster = {};
  return cc.params.game_booster;
}

function setName(v: string) {
  if (!currentEntry.value) return;
  (currentEntry.value as any)[nameKey(channel.value)] = v;
  markDirty();
}

function setCheckMainInfo(v: string) {
  if (!currentEntry.value) return;
  if (!currentEntry.value.xrender_config) currentEntry.value.xrender_config = {};
  currentEntry.value.xrender_config.checkMainInfo = v;
  markDirty();
}

function setCmdlines(v: string) {
  if (!currentEntry.value) return;
  (currentEntry.value as any)[cmdlinesKey(channel.value)] = v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  markDirty();
}

function setLevel(name: string, level: number) {
  if (!currentEntry.value) return;
  setModules(currentEntry.value, withModule(modules.value, name, level));
  markDirty();
}

function dropModule(name: string) {
  if (!currentEntry.value) return;
  setModules(currentEntry.value, withModule(modules.value, name, null));
  markDirty();
}

function addModule() {
  if (!currentEntry.value || !newModuleName.value) return;
  setModules(currentEntry.value, withModule(modules.value, newModuleName.value, newModuleLevel.value));
  markDirty();
}

function stringifyBlock(v: unknown): string {
  return JSON.stringify(v ?? {}, null, 2);
}

function setBlock(name: string, body: string) {
  if (!currentEntry.value) return;
  try {
    (currentEntry.value as any)[name] = JSON.parse(body);
    markDirty();
  } catch (err) {
    toast.fromError(err, `JSON 解析失败 (${name})`);
  }
}

function removeBlock(name: string) {
  if (!currentEntry.value) return;
  delete (currentEntry.value as any)[name];
  markDirty();
}

function addBlock() {
  if (!currentEntry.value || !newBlockName.value) return;
  if ((currentEntry.value as any)[newBlockName.value] !== undefined) return;
  (currentEntry.value as any)[newBlockName.value] = {};
  markDirty();
}

async function addFromPreset() {
  // Filter presets matching current channel; warn if none.
  const eligible = mivkPresets.filter((p) => p.channel === channel.value);
  if (eligible.length === 0) {
    toast.warn(`没有 ${channel.value === 'mivk' ? 'MIVK' : 'MIGL'} 通道的预设`);
    return;
  }
  const value = await dialog.select(
    `从预设添加 ${channel.value === 'mivk' ? 'MIVK' : 'MIGL'} 条目`,
    eligible.map((p, i) => ({
      label: p.label,
      value: String(i),
      detail: ((p.entry as any)[cmdlinesKey(channel.value)] ?? []).join(', '),
    })),
    { detail: '应用后会追加一条配置；不会移除同游戏的旧条目。' },
  );
  if (value === null) return;
  const preset = eligible[Number(value)];
  if (!preset) return;
  // Deep clone so multiple applications of the same preset don't share refs.
  const entry = JSON.parse(JSON.stringify(preset.entry)) as ChannelEntry;
  const gb = ensureGameBooster();
  const all = getEntries(gb, channel.value);
  setEntries(gb, channel.value, [...all, entry]);
  selected.value = all.length;
  markDirty();
  toast.success(`已应用预设：${preset.label}`, '记得保存或推送以生效');
}

async function addBlank() {
  const short = await dialog.prompt(`新条目短名`, {
    detail: `作为 ${nameKey(channel.value)} 字段的值（例如 "yuanshen"、"hkrpg"）。`,
    initialValue: 'newgame',
  });
  if (!short) return;
  const cmdlines = await dialog.prompt('包名列表', {
    detail: '逗号或换行分隔；主包 + 所有渠道包。',
    initialValue: `com.example.${short}`,
    multiline: true,
  });
  if (!cmdlines) return;
  const pkgs = cmdlines.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const entry = channel.value === 'mivk' ? newMivkEntry(short, pkgs) : newMiglEntry(short, pkgs);
  const gb = ensureGameBooster();
  const all = getEntries(gb, channel.value);
  setEntries(gb, channel.value, [...all, entry]);
  selected.value = all.length;
  markDirty();
}

function removeCurrent() {
  if (!currentEntry.value) return;
  const gb = ensureGameBooster();
  const all = getEntries(gb, channel.value);
  const next = all.filter((_, i) => i !== selected.value);
  setEntries(gb, channel.value, next);
  selected.value = Math.max(0, selected.value - 1);
  markDirty();
}
</script>
