<template>
  <div class="stack">
    <div v-if="backendMismatch" class="banner error">
      <strong>此面板不适用于当前机型</strong>
      <span class="hint">当前机型不走此后端，改动不会生效。请到对应面板操作，或通过「参数树」页直接改底层数据。</span>
    </div>

    <PageHeader title="高通 GPU 插帧" kicker="AFME / FRC / FSR · 未实机验证"
      desc="适用于无独显的小米机型。小米 15 / 15 Pro 会被云控下发相关配置；小米 17 未下发，可手动建条目让设备尝试启用插帧 / 超分。">
      <button class="ghost" @click="addFromPreset">
        <AppIcon name="list" /> 从预设
      </button>
      <button class="primary" @click="addBlank">+ 新建条目</button>
    </PageHeader>

    <div class="twopane">
      <div class="list">
        <div class="list-head">
          <span class="tiny muted">{{ entries.length }} 条</span>
          <button class="ghost sm" @click="addFromPreset">预设</button>
        </div>
        <button v-for="(s, i) in entries" :key="i" class="item" :class="{ active: selected === i }"
          @click="selected = i">
          <strong>{{ displayPkg(s) }}</strong>
          <span class="sub">{{ s }}</span>
        </button>
        <div v-if="entries.length === 0" class="hint" style="padding: var(--space-3)">
          没有条目。点击"新建条目"添加。
        </div>
      </div>

      <div v-if="currentParsed" class="detail stack">
        <div class="row">
          <strong class="mono">{{ currentParsed.pkg }}</strong>
          <button class="danger ghost" @click="removeCurrent" style="margin-left: auto">
            删除条目
          </button>
        </div>

        <div class="field">
          <label class="label">包名 pkg</label>
          <input v-model="currentParsed.pkg" @input="rewrite" />
        </div>

        <div class="grid-4">
          <div class="field">
            <label class="label">minFps</label>
            <input type="number" step="0.1" v-model.number="currentParsed.minFps" @input="rewrite" />
          </div>
          <div class="field">
            <label class="label">targetFps</label>
            <input type="number" step="1" v-model.number="currentParsed.targetFps" @input="rewrite" />
          </div>
          <div class="field">
            <label class="label">srcFps</label>
            <input type="number" step="1" v-model.number="currentParsed.srcFps" @input="rewrite" />
          </div>
          <div class="field">
            <label class="label">modeFps</label>
            <input type="number" step="1" v-model.number="currentParsed.modeFps" @input="rewrite" />
          </div>
        </div>

        <div class="grid-4">
          <div class="field">
            <label class="label">温控 T1 (℃)</label>
            <input type="number" step="0.1" v-model.number="currentParsed.t1" @input="rewrite" />
          </div>
          <div class="field">
            <label class="label">温控 T2 (℃)</label>
            <input type="number" step="0.1" v-model.number="currentParsed.t2" @input="rewrite" />
          </div>
          <div class="field">
            <label class="label">温控 T3 (℃)</label>
            <input type="number" step="0.1" v-model.number="currentParsed.t3" @input="rewrite" />
          </div>
          <div class="field">
            <label class="label">温控 T4 (℃，最低)</label>
            <input type="number" step="0.1" v-model.number="currentParsed.t4" @input="rewrite" />
          </div>
        </div>

        <div class="grid-3">
          <div class="field">
            <label class="label">分辨率</label>
            <select v-model="currentParsed.resolution" @change="rewrite">
              <option value="0x0">0x0（不限定）</option>
              <option value="1080x2400">1080x2400</option>
              <option value="1440x3200">1440x3200</option>
              <option value="720x1600">720x1600</option>
            </select>
          </div>
          <div class="field">
            <label class="label">FI 插帧</label>
            <select v-model.number="currentParsed.fi" @change="rewrite">
              <option :value="1">开</option>
              <option :value="0">关</option>
            </select>
          </div>
          <div class="field">
            <label class="label">SR 超分</label>
            <select v-model.number="currentParsed.sr" @change="rewrite">
              <option :value="1">开</option>
              <option :value="0">关</option>
            </select>
          </div>
        </div>

        <div class="panel" style="margin: 0; background: var(--bg-elevated)">
          <div class="label">序列化结果</div>
          <div class="mono" style="font-size: 12px; word-break: break-all">
            {{ entries[selected] }}
          </div>
          <div v-if="issues.length" class="stack" style="margin-top: var(--space-2)">
            <div v-for="(i, k) in issues" :key="k" class="tiny" style="color: var(--warn)">
              ⚠ <span class="mono">{{ i.field }}</span>: {{ i.message }}
            </div>
          </div>
        </div>

        <div class="panel" style="margin: 0">
          <h2 style="font-size: 14px">画质增强策略</h2>
          <div class="row">
            <button @click="applyPreset('qualcommStandard')">小米 15 标准（60→120）</button>
            <button @click="applyPreset('qualcomm6090')">小米 15 星铁（60→90）</button>
            <button @click="applyPreset('novatekStandard')" :disabled="true" title="仅红米独显适用">Novatek</button>
            <label class="row" style="margin-left: auto; gap: var(--space-1)">
              <input type="checkbox" v-model="alsoUpdateWhitelists" />
              <span class="hint">同步写入超分 / 帧率白名单</span>
            </label>
          </div>
          <table class="table" v-if="routedPolicies" style="margin-top: var(--space-2)">
            <thead>
              <tr>
                <th>类型</th>
                <th>策略</th>
                <th>最高刷新率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in routedPolicies" :key="p.feature">
                <td><strong class="mono">{{ p.feature }}</strong></td>
                <td class="mono" data-label="策略">{{ p.strategy }}</td>
                <td class="mono" data-label="最高刷新率">{{ p.support_max_refresh ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="hint">该包尚未配置画质增强策略。选一个预设一键应用。</div>
        </div>
      </div>

      <div v-else class="detail hint">从列表里选一条，或点击"新建条目"。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { state, markDirty } from '@/state/session';
import {
  parseFrc,
  serializeFrc,
  blankFrc,
  validateFrc,
  type FrcParams,
} from '@/parsers/frc-string';
import {
  STRATEGY_PRESETS,
  emptyFisrConfig,
  findGroupForPkg,
  upsertPkgPolicy,
  removePkg,
  type FisrConfig,
  type PresetName,
} from '@/parsers/fisr-config';

import frcPresets from '@/presets/frc/index.json';
import { dialog } from '@/state/dialog';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import { rafThrottle } from '@/utils/raf';

const entries = computed<string[]>({
  get: () => {
    const gb = state.cloudConfig.booster_config?.params?.game_booster ?? {};
    return Array.isArray(gb.frc_game_params) ? gb.frc_game_params : [];
  },
  set: (val: string[]) => {
    const gb = ensureGameBooster();
    gb.frc_game_params = val;
    markDirty();
  },
});

const alsoUpdateWhitelists = ref(true);
const selected = ref(0);

const currentParsed = ref<FrcParams | null>(null);

// Re-parse the current list entry when the list identity changes (add / remove)
// or when the user switches selection. Do NOT use deep watch: rewrite() mutates
// list[selected] in-place on every keystroke, and re-parsing transient NaN
// states would wipe currentParsed, destroying the form under the user's cursor.
watch(
  [() => entries.value.length, selected],
  () => {
    const e = entries.value;
    if (e.length === 0) {
      currentParsed.value = null;
      return;
    }
    if (selected.value >= e.length) selected.value = 0;
    try {
      currentParsed.value = parseFrc(e[selected.value]);
    } catch {
      currentParsed.value = null;
    }
  },
  { immediate: true },
);

const issues = computed(() => {
  if (!currentParsed.value) return [];
  const rates = detectSupportedRefreshRates();
  return validateFrc(currentParsed.value, rates);
});

const backendMismatch = computed(
  () => state.activeBackend !== null && state.activeBackend !== 'qualcomm',
);

const routedPolicies = computed(() => {
  if (!currentParsed.value) return null;
  const cfg = state.cloudConfig.booster_config?.params?.game_booster?.fisr_config as
    | FisrConfig
    | undefined;
  if (!cfg) return null;
  const group = findGroupForPkg(cfg, currentParsed.value.pkg);
  return group?.enhance_policy_config ?? null;
});

function ensureGameBooster(): any {
  const cc = state.cloudConfig.booster_config;
  if (!cc) throw new Error('booster_config missing');
  if (!cc.params) cc.params = {};
  if (!cc.params.game_booster) cc.params.game_booster = {};
  return cc.params.game_booster;
}

function displayPkg(s: string): string {
  const idx = s.indexOf('_');
  return idx < 0 ? s : s.slice(0, idx);
}

function detectSupportedRefreshRates(): number[] | undefined {
  const gb = state.cloudConfig.booster_config?.params?.game_booster;
  const rates = gb?.support_display_refresh_rates;
  return Array.isArray(rates) ? rates.map(Number).filter(Number.isFinite) : undefined;
}

function rewriteNow() {
  const p = currentParsed.value;
  if (!p) return;
  // Skip while the user is mid-edit (cleared a numeric field → NaN). Writing
  // "NaN" into the on-disk string would corrupt the list. We keep the last
  // valid serialized value there until the user types a finite number.
  const nums = [p.minFps, p.targetFps, p.srcFps, p.modeFps, p.t1, p.t2, p.t3, p.t4];
  if (nums.some((n) => !Number.isFinite(n))) return;
  try {
    const serialized = serializeFrc(p);
    const gb = ensureGameBooster();
    if (!Array.isArray(gb.frc_game_params)) gb.frc_game_params = [];
    gb.frc_game_params[selected.value] = serialized;
    markDirty();
  } catch (err: any) {
    console.warn('frc serialize failed:', err);
  }
}


const rewrite = rafThrottle(rewriteNow);
function addBlank() {
  const gb = ensureGameBooster();
  if (!Array.isArray(gb.frc_game_params)) gb.frc_game_params = [];
  const template = blankFrc('com.example.newgame');
  gb.frc_game_params.push(serializeFrc(template));
  selected.value = gb.frc_game_params.length - 1;
  markDirty();
}

async function addFromPreset() {
  if (frcPresets.length === 0) return;
  const value = await dialog.select(
    '从预设添加 FRC 条目',
    frcPresets.map((p, i) => ({
      label: p.label,
      value: String(i),
      detail: p.string,
    })),
    { detail: '选一款游戏：会追加一条 frc_game_params 并自动应用对应的 fisr_config 路由预设。' },
  );
  if (value === null) return;
  const preset = frcPresets[Number(value)];
  if (!preset) return;
  const gb = ensureGameBooster();
  if (!Array.isArray(gb.frc_game_params)) gb.frc_game_params = [];
  gb.frc_game_params.push(preset.string);
  selected.value = gb.frc_game_params.length - 1;
  // also apply route preset if supplied
  if (preset.route) applyFisrPreset(preset.pkg, preset.route as PresetName);
  markDirty();
}

function removeCurrent() {
  const gb = ensureGameBooster();
  if (!Array.isArray(gb.frc_game_params)) return;
  const removed = currentParsed.value?.pkg;
  gb.frc_game_params.splice(selected.value, 1);
  if (removed && gb.fisr_config) removePkg(gb.fisr_config, removed);
  if (removed && alsoUpdateWhitelists.value) removeFromWhitelists(removed);
  selected.value = Math.max(0, selected.value - 1);
  markDirty();
}

function applyPreset(preset: PresetName) {
  if (!currentParsed.value) return;
  applyFisrPreset(currentParsed.value.pkg, preset);
}

function applyFisrPreset(pkg: string, preset: PresetName) {
  const gb = ensureGameBooster();
  if (!gb.fisr_config) gb.fisr_config = emptyFisrConfig();
  upsertPkgPolicy(gb.fisr_config, pkg, STRATEGY_PRESETS[preset](), {
    switch_default_status: '0#0',
  });
  if (alsoUpdateWhitelists.value) addToWhitelists(pkg);
  markDirty();
}

function addToWhitelists(pkg: string) {
  const gb = ensureGameBooster();
  if (!Array.isArray(gb.support_resolution_enhance_config)) {
    gb.support_resolution_enhance_config = [];
  }
  if (!gb.support_resolution_enhance_config.some((e: any) => e.pkg === pkg)) {
    gb.support_resolution_enhance_config.push({ pkg, isSupportHotSwap: false });
  }
  if (!Array.isArray(gb.support_enhance_targetfps)) gb.support_enhance_targetfps = [];
  if (!gb.support_enhance_targetfps.some((g: any) => g.package_list?.includes(pkg))) {
    gb.support_enhance_targetfps.push({
      package_list: [pkg],
      targetfps: [24, 30, 45, 60],
    });
  }
}

function removeFromWhitelists(pkg: string) {
  const gb = ensureGameBooster();
  if (Array.isArray(gb.support_resolution_enhance_config)) {
    gb.support_resolution_enhance_config = gb.support_resolution_enhance_config.filter(
      (e: any) => e.pkg !== pkg,
    );
  }
  if (Array.isArray(gb.support_enhance_targetfps)) {
    for (const g of gb.support_enhance_targetfps) {
      g.package_list = (g.package_list ?? []).filter((p: string) => p !== pkg);
    }
    gb.support_enhance_targetfps = gb.support_enhance_targetfps.filter(
      (g: any) => (g.package_list ?? []).length > 0,
    );
  }
}
</script>
