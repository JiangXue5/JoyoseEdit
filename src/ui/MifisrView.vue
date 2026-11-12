<template>
  <div class="stack">
    <PageHeader title="MIFISR 画质增强" kicker="骁龙 8 Elite 2 · 17 系列"
      desc="每条配置管一款游戏的帧插值 + 超分。字段中 -1 代表交给驱动自动决定。">
      <button class="ghost" @click="addFromPreset">
        <AppIcon name="list" /> 从预设
      </button>
      <button class="primary" @click="addBlank">+ 新建条目</button>
    </PageHeader>

    <!-- 诊断：一行状态 + 折叠详情 -->
    <section class="panel diag">
      <div class="status-strip">
        <span class="status-chip" :class="mifisrSwitchOn ? 'ok' : 'error'">
          <i class="led" /> 总开关
          <b>{{ mifisrSwitchOn ? '已开启' : '未开启' }}</b>
        </span>
        <span class="status-chip" :class="visionTone">
          <i class="led" /> vendor 能力
          <b>{{ visionText }}</b>
        </span>
        <span class="status-chip" :class="mivkTone">
          <i class="led" /> 渲染通道
          <b>{{ mivkText }}</b>
        </span>
        <span class="status-chip" :class="whitelistTone">
          <i class="led" /> 白名单
          <b>{{ whitelistText }}</b>
        </span>
        <button class="ghost sm diag-refresh" @click="refreshVision" :disabled="visionLoading"
          title="重新读取 vendor 属性">
          <AppIcon name="refresh" />
        </button>
      </div>

      <div v-if="problems.length" class="issue-list">
        <div v-for="p in problems" :key="p.id" class="issue" :class="p.tone">
          <AppIcon :name="p.tone === 'ok' ? 'check' : 'warn'" class="issue-icon" />
          <div class="issue-body">
            <strong>{{ p.title }}</strong>
            <div class="hint">{{ p.detail }}</div>
            <pre v-if="p.code" class="code-block mono">{{ p.code }}</pre>
            <div v-if="p.action" class="btn-row" style="margin-top: 8px">
              <button class="primary sm" @click="p.action.run" :disabled="state.loading">{{ p.action.label }}</button>
              <button v-if="p.secondary" class="ghost sm" @click="p.secondary.run">{{ p.secondary.label }}</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="twopane">
      <!-- entry selector -->
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
          没有条目。点击"新建条目"添加，或从预设选一款 Ultra 同款游戏。
        </div>
      </div>

      <!-- editor -->
      <div v-if="currentParsed" class="detail stack">
        <div class="detail-head">
          <div style="min-width: 0">
            <div class="kpi-label">正在编辑</div>
            <h3 class="mono detail-pkg">{{ currentParsed.pkg }}</h3>
          </div>
          <button class="danger ghost sm" @click="removeCurrent">
            <AppIcon name="close" /> 删除条目
          </button>
        </div>

        <div v-if="issues.length" class="issue compact" :class="hasBlockingIssue ? 'error' : 'warn'">
          <AppIcon :name="hasBlockingIssue ? 'warn' : 'info'" class="issue-icon" />
          <div class="issue-body">
            <strong>{{ hasBlockingIssue ? '字段有问题，写入后可能不生效' : '字段提示' }}</strong>
            <div v-for="(i, k) in issues" :key="k" class="tiny">
              <span class="mono">{{ i.field }}</span>：{{ i.message }}
            </div>
          </div>
        </div>

        <div class="panel subpanel" style="margin: 0">
          <div class="panel-title-row">
            <h3>基础参数</h3>
            <span class="tiny faint mono"># 分隔 7 字段</span>
          </div>

          <div class="field">
            <label class="label">包名 pkg</label>
            <input v-model="currentParsed.pkg" class="mono" @input="queueRewrite" />
          </div>

          <div class="grid-2" style="margin-top: var(--space-3)">
            <div class="field">
              <label class="label">最小帧率</label>
              <input type="number" step="1" v-model.number="currentParsed.minFps" @input="queueRewrite" />
              <span class="tiny faint">-1 = 自动</span>
            </div>
            <div class="field">
              <label class="label">目标帧率</label>
              <input type="number" step="1" v-model.number="currentParsed.targetFps" @input="queueRewrite" />
              <span class="tiny faint">-1 = 自动</span>
            </div>
          </div>

          <div class="field" style="margin-top: var(--space-3)">
            <label class="label">源帧率</label>
            <input v-model="srcFpsText" class="mono" placeholder="45,60" @change="rewriteFromSrcText" />
            <span class="tiny faint">逗号分隔；低于 45fps 的源帧率不被支持。</span>
          </div>

          <div class="grid-4" style="margin-top: var(--space-3)">
            <div class="field">
              <label class="label">T1 (℃)</label>
              <input type="number" step="1" v-model.number="currentParsed.t1" @input="queueRewrite" />
            </div>
            <div class="field">
              <label class="label">T2 (℃)</label>
              <input type="number" step="1" v-model.number="currentParsed.t2" @input="queueRewrite" />
            </div>
            <div class="field">
              <label class="label">T3 (℃)</label>
              <input type="number" step="1" v-model.number="currentParsed.t3" @input="queueRewrite" />
            </div>
            <div class="field">
              <label class="label">T4 (℃，最低)</label>
              <input type="number" step="1" v-model.number="currentParsed.t4" @input="queueRewrite" />
            </div>
          </div>

          <div class="btn-row" style="margin-top: var(--space-3)">
            <button class="ghost sm" @click="applyThermal(47, 45, 44, 42)">标准温控 47/45/44/42</button>
            <button class="ghost sm" @click="applyThermal(95, 93, 92, 90)" title="散热充足时才建议；未经社区验证">
              激进 95/93/92/90
            </button>
          </div>
        </div>

        <div class="panel subpanel" style="margin: 0">
          <div class="panel-title-row">
            <h3>画质增强策略</h3>
            <span class="tiny faint">按需组合 FI / SR / FISR</span>
          </div>

          <div class="btn-row">
            <button class="sm" @click="addFisrFeature('FI')" :disabled="hasFeature('FI')"
              :title="hasFeature('FI') ? '已存在' : '可能出现画面异常 / 输入延迟'">
              + FI 仅插帧
            </button>
            <button class="sm" @click="addFisrFeature('SR')" :disabled="hasFeature('SR')"
              :title="hasFeature('SR') ? '已存在' : '仅超分配置（Ultra 同款）'">
              + SR 仅超分
            </button>
            <button class="sm" @click="addFisrFeature('FISR')" :disabled="hasFeature('FISR')"
              :title="hasFeature('FISR') ? '已存在' : '插帧 + 超分，功耗与延迟风险最高'">
              + FISR 合体
            </button>
          </div>

          <label class="row" style="gap: 6px; margin-top: var(--space-2)">
            <input type="checkbox" v-model="alsoUpdateMqs" />
            <span class="tiny">同步写入 <span class="mono">mqs_enhance_list</span></span>
          </label>

          <div v-if="routedPolicies && routedPolicies.length" class="stack" style="margin-top: var(--space-3)">
            <div v-for="p in routedPolicies" :key="p.feature" class="policy-card">
              <div class="policy-head">
                <span class="pill" :class="policyTone(String(p.feature))">{{ p.feature }}</span>
                <span class="mono faint tiny">{{ (p as any).strategy ?? '—' }}</span>
                <button class="danger ghost sm" style="margin-left: auto"
                  @click="removeFisrFeature(String(p.feature))">删除</button>
              </div>

              <div class="field-line">
                <span class="field-name mono">strategy</span>
                <input type="text" class="mono field-input w-strategy" placeholder="MIFISR"
                  :value="(p.strategy as string) ?? ''"
                  @change="(e: Event) => setStrategy(p, (e.target as HTMLInputElement).value)" />
                <span class="hint">MIFISR、AFME、FSR、FRC…</span>
              </div>

              <div class="field-line">
                <span class="field-name mono">support_game_mode</span>
                <label class="check">
                  <input type="checkbox" :checked="gameModeBit(p, 0)"
                    @change="(e: Event) => setGameModeBit(p, 0, (e.target as HTMLInputElement).checked)" />
                  <span>均衡</span>
                </label>
                <label class="check">
                  <input type="checkbox" :checked="gameModeBit(p, 1)"
                    @change="(e: Event) => setGameModeBit(p, 1, (e.target as HTMLInputElement).checked)" />
                  <span>性能</span>
                </label>
                <span class="tiny faint mono">{{ (p.support_game_mode as string) ?? '—' }}</span>
              </div>

              <div v-if="needsMaxRefresh(p)" class="field-line">
                <span class="field-name mono">support_max_refresh</span>
                <input type="text" class="mono field-input w-refresh" :class="maxRefreshMissing(p) ? 'invalid' : ''"
                  :value="(p.support_max_refresh as string) ?? ''"
                  :placeholder="maxRefreshMissing(p) ? '默认 = 60' : '60#120'"
                  @change="(e: Event) => setMaxRefresh(p, (e.target as HTMLInputElement).value)" />
                <span class="hint">Hz 上限（均衡#性能）</span>
              </div>

              <div class="field-line">
                <span class="field-name mono">disable_scene_list</span>
                <input type="text" class="mono field-input w-scene" placeholder="10004,1051"
                  :value="disableSceneText(p)"
                  @change="(e: Event) => setDisableSceneList(p, (e.target as HTMLInputElement).value)" />
                <span class="hint">留空 = 不禁用</span>
              </div>

              <div class="field-line">
                <span class="field-name mono">support_resolution_leave</span>
                <input type="text" class="mono field-input w-refresh" placeholder="留空 = 允许所有"
                  :value="(p.support_resolution_leave as string) ?? ''"
                  @change="(e: Event) => setResolutionLeave(p, (e.target as HTMLInputElement).value)" />
                <span class="hint">分辨率白名单</span>
              </div>

              <div class="field-line">
                <span class="field-name mono">switch_default_status</span>
                <input type="text" class="mono field-input w-flag" placeholder="0#0"
                  :value="(p.switch_default_status as string) ?? ''"
                  @change="(e: Event) => setSwitchDefaultStatus(p, (e.target as HTMLInputElement).value)" />
                <span class="hint">UI 初始位</span>
              </div>
            </div>
          </div>
          <div v-else class="hint" style="margin-top: var(--space-2)">
            该包还没有画质增强策略。点上面的 + FI / + SR / + FISR 按需添加。
          </div>

          <div v-if="routedPolicies && routedPolicies.length" class="vk-row">
            <label class="check">
              <input type="checkbox" :checked="currentSupportVk"
                @change="(e: Event) => toggleSupportVk((e.target as HTMLInputElement).checked)" />
              <strong>支持 Vulkan</strong>
            </label>
            <span class="hint">
              <span v-if="isHkrpg" class="vk-hint">★ 星铁必开 — </span>
              只对星铁生效；VK 模式下不开会导致画质开关消失，其他游戏无影响。
            </span>
          </div>
        </div>

        <div class="panel subpanel" style="margin: 0">
          <div class="serialized">
            <span class="kpi-label">序列化结果</span>
            <div class="mono serialized-value">{{ entries[selected] }}</div>
          </div>
          <div class="hint" style="margin-top: var(--space-2)">
            画面要真正看到效果，还需到 <strong>渲染模块</strong> 面板把该游戏的
            <span class="mono">mifi</span> / <span class="mono">misr</span> 等级设为 <span class="mono">31</span>。
          </div>
        </div>
      </div>

      <div v-else class="detail hint">从左侧列表选一条，或点击右上角"新建条目"。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { state, markDirty } from '@/state/session';
import { navigate } from '@/state/nav';
import * as bridge from '@/root/bridge';
import type { VisionStatus } from '@/root/bridge';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import {
  parseMifisr,
  serializeMifisr,
  blankMifisr,
  validateMifisr,
  type MifisrParams,
} from '@/parsers/mifisr-string';
import {
  STRATEGY_PRESETS,
  emptyFisrConfig,
  findGroupForPkg,
  upsertPkgPolicy,
  removePkg,
  addPolicyForPkg,
  removePolicyForPkg,
  isValidSupportGameMode,
  type FisrConfig,
  type FisrPolicy,
} from '@/parsers/fisr-config';
import { findByCmdline, getEntries, modulesOf } from '@/parsers/mivk-migl';
import { lookupKnownGame } from '@/presets/mifisr/known-games';
import { toast } from '@/state/toast';

import mifisrPresets from '@/presets/mifisr/index.json';
import { dialog } from '@/state/dialog';

const entries = computed<string[]>({
  get: () => {
    const gb = state.cloudConfig.booster_config?.params?.game_booster ?? {};
    return Array.isArray(gb.customize_game_params?.game_mifisr_config)
      ? gb.customize_game_params.game_mifisr_config
      : [];
  },
  set: (val: string[]) => {
    const gb = ensureGameBooster();
    if (!gb.customize_game_params) gb.customize_game_params = {};
    gb.customize_game_params.game_mifisr_config = val;
    markDirty();
  },
});

const alsoUpdateMqs = ref(true);
const selected = ref(0);
const currentParsed = ref<MifisrParams | null>(null);
const srcFpsText = ref('');

const mifisrSwitchOn = computed(
  () => state.cloudConfig.booster_config?.params?.game_booster?.fisr_mqs_v2 === true,
);

// `ro.vendor.gpp.frc.support` / `ro.vendor.xiaomi.sr.support` gate whether
// HyperOS's game-assistant UI renders the FI / SR controls at all. Read once
// on mount; the diagnostics strip reflects the result.
const vision = ref<VisionStatus | null>(null);
const visionLoading = ref(false);

async function refreshVision() {
  if (visionLoading.value) return;
  visionLoading.value = true;
  try {
    vision.value = await bridge.visionStatus();
  } catch {
    // Bridge unavailable (dev mode) or old module without the subcommand.
    vision.value = null;
  } finally {
    visionLoading.value = false;
  }
}

onMounted(refreshVision);

const visionFrcOn = computed(() => vision.value?.frc_support === 'true');
const visionSrOn = computed(() => vision.value?.sr_support === 'true');
const visionBlocked = computed(
  () => vision.value !== null && !visionFrcOn.value && !visionSrOn.value,
);
const visionPartial = computed(
  () => vision.value !== null && visionFrcOn.value !== visionSrOn.value,
);
const visionReady = computed(
  () => vision.value !== null && visionFrcOn.value && visionSrOn.value,
);

// MIFISR strategy (l.i) and the MIVK xrender hook are two independent
// channels: l.i never reads mivk_settings. With mifi:0 / misr:0 the strategy
// still activates but nothing happens on screen — surface that state.
const whitelistMatch = computed(() => {
  const pkg = currentParsed.value?.pkg;
  if (!pkg) return null;
  return lookupKnownGame(pkg);
});

const mivkStatus = computed(() => {
  const pkg = currentParsed.value?.pkg;
  if (!pkg) return null;
  const gb = state.cloudConfig.booster_config?.params?.game_booster;
  if (!gb) return null;
  const mivkEntries = getEntries(gb, 'mivk');
  const entry = findByCmdline(mivkEntries, 'mivk', pkg);
  if (!entry) return { status: 'missing' as const, mifi: 0, misr: 0 };
  const modules = modulesOf(entry);
  const mifi = modules.find((m) => m.name === 'mifi')?.level ?? 0;
  const misr = modules.find((m) => m.name === 'misr')?.level ?? 0;
  let status: 'ok' | 'partial' | 'off';
  if (mifi > 0 && misr > 0) status = 'ok';
  else if (mifi > 0 || misr > 0) status = 'partial';
  else status = 'off';
  return { status, mifi, misr };
});

// ---- diagnostics strip + consolidated issues ------------------------------
const visionTone = computed(() =>
  visionBlocked.value ? 'error' : visionPartial.value ? 'warn' : visionReady.value ? 'ok' : '',
);

const visionText = computed(() => {
  if (!vision.value) return '未知';
  if (visionBlocked.value) return '未就绪';
  if (visionPartial.value) return visionFrcOn.value ? '仅插帧' : '仅超分';
  return 'FRC + SR';
});

const mivkTone = computed(() => {
  switch (mivkStatus.value?.status) {
    case 'ok': return 'ok';
    case 'partial': return 'warn';
    case 'off': return 'error';
    case 'missing': return 'warn';
    default: return '';
  }
});

const mivkText = computed(() => {
  const s = mivkStatus.value;
  if (!s) return '未选择';
  if (s.status === 'missing') return '未配置';
  return `mifi ${s.mifi} / misr ${s.misr}`;
});

const whitelistTone = computed(() => {
  if (!currentParsed.value?.pkg) return '';
  return whitelistMatch.value ? 'ok' : 'warn';
});

const whitelistText = computed(() => {
  if (!currentParsed.value?.pkg) return '未选择';
  return whitelistMatch.value ? whitelistMatch.value.name : '未知包名';
});

interface Issue {
  id: string;
  tone: 'ok' | 'warn' | 'error';
  title: string;
  detail: string;
  code?: string;
  action?: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
}

const problems = computed<Issue[]>(() => {
  const list: Issue[] = [];

  if (!mifisrSwitchOn.value) {
    list.push({
      id: 'switch',
      tone: 'error',
      title: 'MIFISR 总开关未开启',
      detail: '未开启前，下面的条目都不会生效。',
      action: { label: '一键开启', run: enableMifisrSwitch },
    });
  }

  if (visionBlocked.value) {
    list.push({
      id: 'vision',
      tone: 'error',
      title: '游戏助手不会显示画质增强面板',
      detail: `vendor 属性 frc=${vision.value?.frc_support || '空'}、sr=${vision.value?.sr_support || '空'}，两者都需要为 true。本模块不会自动改系统属性，可先用下面的命令临时开启（重启失效），或用 npm run package:prop 重打成带 system.prop 的包。`,
      code: 'su -c "resetprop ro.vendor.gpp.frc.support true"\nsu -c "resetprop ro.vendor.xiaomi.sr.support true"\nam force-stop com.miui.securitycenter',
    });
  } else if (visionPartial.value) {
    list.push({
      id: 'vision-partial',
      tone: 'warn',
      title: 'vendor 能力半就绪',
      detail: `当前 frc=${vision.value?.frc_support || '空'}、sr=${vision.value?.sr_support || '空'}，游戏助手只会显示${visionFrcOn.value ? '「插帧」' : '「超分」'}开关。`,
    });
  }

  if (mivkStatus.value?.status === 'off' || mivkStatus.value?.status === 'missing') {
    list.push({
      id: 'mivk',
      tone: 'warn',
      title: mivkStatus.value.status === 'missing' ? '渲染模块里还没有这个包' : '渲染通道未启用',
      detail: mivkStatus.value.status === 'missing'
        ? 'MIFISR 策略仍会激活，但画面不会有任何变化。需要先在渲染模块面板添加该包。'
        : `mifi / misr 等级为 ${mivkStatus.value.mifi} / ${mivkStatus.value.misr}，两路都为 0 时画面看不到效果。`,
      action: { label: '前往渲染模块', run: () => navigate('mivk') },
    });
  } else if (mivkStatus.value?.status === 'partial') {
    list.push({
      id: 'mivk-partial',
      tone: 'warn',
      title: '渲染通道仅半启用',
      detail: `mifi ${mivkStatus.value.mifi} / misr ${mivkStatus.value.misr}，等级为 0 的那一路不会生效。推荐原神 31/31、星铁 31/7。`,
      action: { label: '前往渲染模块', run: () => navigate('mivk') },
    });
  }

  if (currentParsed.value?.pkg && !whitelistMatch.value) {
    list.push({
      id: 'whitelist',
      tone: 'warn',
      title: '该包不在已知白名单',
      detail: '策略可以激活，但渲染层没有对应 Processor，画面不会出现插帧 / 超分。若实机有效欢迎反馈。',
    });
  }

  if (hasNoFiSr.value) {
    list.push({
      id: 'nofisr',
      tone: 'error',
      title: '缺少 FI / SR 策略，画质增强面板不会显示',
      detail: '只保留 FISR 是无效的，必须至少有 FI 或 SR 之一。',
      action: { label: '补一条 SR', run: () => addFisrFeature('SR') },
    });
  } else if (hasUselessFisr.value) {
    list.push({
      id: 'fisr-sibling',
      tone: 'warn',
      title: `FISR 需要搭配 ${missingFisrSibling.value} 才能生效`,
      detail: '合体模式必须同时存在 FI + SR；仅留 FISR 无意义。',
      action: {
        label: `补一条 ${missingFisrSibling.value}`,
        run: () => addFisrFeature(missingFisrSibling.value as 'FI' | 'SR'),
      },
    });
  }

  if (hasMissingMaxRefresh.value) {
    list.push({
      id: 'refresh',
      tone: 'warn',
      title: 'FI / FISR 未设置最高刷新率',
      detail: '字段缺失时 Joyose 默认按 60Hz 处理，倍帧会被削回 60fps。144Hz 屏请改成 60#144。',
      action: { label: '一键填 60#120', run: () => fillMaxRefresh('60#120') },
    });
  }

  if (resolutionLeavePolicies.value.length) {
    list.push({
      id: 'resolution',
      tone: 'warn',
      title: '该配置限制了分辨率白名单',
      detail: `受限策略：${resolutionLeaveSummary.value}。切换画质档位后若勾选框消失，多半是该字段导致，可去「参数树」页删除或改成当前档位。`,
    });
  }

  if (whitelistMatch.value?.source === 'inferred') {
    list.push({
      id: 'inferred',
      tone: 'ok',
      title: `白名单命中 ${whitelistMatch.value.name}（推断）`,
      detail: `后端：${whitelistMatch.value.backends.join(' / ')}。结果基于公开资料推断，若实机未激活请反馈。`,
    });
  }

  return list;
});

// Re-parse the current list entry when the list identity changes (add / remove)
// or when the user switches selection. Deliberately not a deep watch:
// rewrite() mutates list[selected] in place on every keystroke, and
// re-parsing transient NaN states would wipe the form under the cursor.
watch(
  [() => entries.value.length, selected],
  () => {
    const e = entries.value;
    if (e.length === 0) {
      currentParsed.value = null;
      srcFpsText.value = '';
      return;
    }
    if (selected.value >= e.length) selected.value = 0;
    try {
      const parsed = parseMifisr(e[selected.value]);
      currentParsed.value = parsed;
      srcFpsText.value = parsed.srcFps.join(',');
    } catch {
      currentParsed.value = null;
      srcFpsText.value = '';
    }
  },
  { immediate: true },
);

const issues = computed(() =>
  currentParsed.value ? validateMifisr(currentParsed.value) : [],
);

const hasBlockingIssue = computed(() => issues.value.some((i) => i.severity !== 'warn'));

const routedPolicies = computed(() => {
  if (!currentParsed.value) return null;
  const cfg = state.cloudConfig.booster_config?.params?.game_booster?.fisr_config as
    | FisrConfig
    | undefined;
  if (!cfg) return null;
  const group = findGroupForPkg(cfg, currentParsed.value.pkg);
  return group?.enhance_policy_config ?? null;
});

// support_vk is a group-level boolean on fisr_config.enhance_config[].
// k.b.isSupportEnhance only consults it when pkg == "com.miHoYo.hkrpg", so
// flipping it elsewhere is harmless but pointless — hence the hkrpg hint.
const isHkrpg = computed(() => currentParsed.value?.pkg === 'com.miHoYo.hkrpg');

const currentSupportVk = computed(() => {
  if (!currentParsed.value) return false;
  const cfg = state.cloudConfig.booster_config?.params?.game_booster?.fisr_config as
    | FisrConfig
    | undefined;
  if (!cfg) return false;
  const group = findGroupForPkg(cfg, currentParsed.value.pkg);
  return group?.support_vk === true;
});

function toggleSupportVk(on: boolean) {
  if (!currentParsed.value) return;
  const cfg = state.cloudConfig.booster_config?.params?.game_booster?.fisr_config as
    | FisrConfig
    | undefined;
  if (!cfg) return;
  const group = findGroupForPkg(cfg, currentParsed.value.pkg);
  if (!group) return;
  group.support_vk = on;
  markDirty();
}

function policyTone(feature: string): string {
  if (feature === 'FI') return 'ok';
  if (feature === 'SR') return '';
  return 'warn';
}

// support_max_refresh caps FI output (l.i.r: min(gameFps*2, supportMaxFps)).
// Only FI / FISR care — SR doesn't double frames.
function needsMaxRefresh(p: FisrPolicy): boolean {
  return p.feature === 'FI' || p.feature === 'FISR';
}

function maxRefreshMissing(p: FisrPolicy): boolean {
  if (!needsMaxRefresh(p)) return false;
  return typeof p.support_max_refresh !== 'string' || p.support_max_refresh.length === 0;
}

const hasMissingMaxRefresh = computed(() => {
  const list = routedPolicies.value ?? [];
  return list.some((p) => maxRefreshMissing(p as FisrPolicy));
});

function setMaxRefresh(p: FisrPolicy, value: string) {
  const v = value.trim();
  if (v === '') {
    delete p.support_max_refresh;
  } else {
    p.support_max_refresh = v;
  }
  markDirty();
}

function fillMaxRefresh(value: string) {
  const list = routedPolicies.value;
  if (!list) return;
  for (const p of list) {
    if (maxRefreshMissing(p as FisrPolicy)) {
      (p as FisrPolicy).support_max_refresh = value;
    }
  }
  markDirty();
  toast.success('已补齐 support_max_refresh', `所有缺字段的 FI/FISR policy → ${value}`);
}

// Combination guards. The UI only renders FI and SR checkboxes
// (GameBoxVisionEnhanceUtils.s()); FISR is the "both checked" upgrade.
// k.b.isSupportEnhance never consults FISR, so FISR-only hides the panel.
const hasNoFiSr = computed(() => {
  const list = routedPolicies.value;
  if (!list || list.length === 0) return false;
  return !list.some((p) => p.feature === 'FI') && !list.some((p) => p.feature === 'SR');
});

const missingFisrSibling = computed<'FI' | 'SR' | null>(() => {
  const list = routedPolicies.value;
  if (!list) return null;
  const hasFisr = list.some((p) => p.feature === 'FISR');
  if (!hasFisr) return null;
  const hasFi = list.some((p) => p.feature === 'FI');
  const hasSr = list.some((p) => p.feature === 'SR');
  if (hasFi && hasSr) return null;
  if (!hasFi && hasSr) return 'FI';
  if (hasFi && !hasSr) return 'SR';
  return null;
});

const hasUselessFisr = computed(() => missingFisrSibling.value !== null);

// support_resolution_leave is a render-level whitelist checked before
// activation; a miss silently aborts. Surface the policies that carry it.
const resolutionLeavePolicies = computed(() => {
  const list = routedPolicies.value ?? [];
  return list.filter(
    (p) => typeof p.support_resolution_leave === 'string' && p.support_resolution_leave.length > 0,
  );
});

const resolutionLeaveSummary = computed(() =>
  resolutionLeavePolicies.value
    .map((p) => `${p.feature}=${p.support_resolution_leave}`)
    .join(', '),
);

function ensureGameBooster(): any {
  const cc = state.cloudConfig.booster_config;
  if (!cc) throw new Error('booster_config missing');
  if (!cc.params) cc.params = {};
  if (!cc.params.game_booster) cc.params.game_booster = {};
  return cc.params.game_booster;
}

function ensureMifisrList(): string[] {
  const gb = ensureGameBooster();
  if (!gb.customize_game_params) gb.customize_game_params = {};
  if (!Array.isArray(gb.customize_game_params.game_mifisr_config)) {
    gb.customize_game_params.game_mifisr_config = [];
  }
  return gb.customize_game_params.game_mifisr_config;
}

function displayPkg(s: string): string {
  const idx = s.indexOf('_');
  return idx < 0 ? s : s.slice(0, idx);
}

function disableSceneText(p: any): string {
  const list = Array.isArray(p?.disable_scene_list) ? p.disable_scene_list : [];
  return list.join(', ');
}

// support_game_mode is a 2-position bitmap "X#Y" where X = MGAME (均衡),
// Y = TGAME (性能).
function gameModeBit(p: any, idx: 0 | 1): boolean {
  const raw = typeof p?.support_game_mode === 'string' ? p.support_game_mode : '';
  const parts = raw.split('#');
  if (parts.length !== 2) return false;
  return parts[idx] === '1';
}

// Write back one bit of support_game_mode. A malformed value makes Joyose's
// k.e.u() silently drop the per-mode check, so re-normalise loudly instead.
function setGameModeBit(p: any, idx: 0 | 1, on: boolean): void {
  const raw = p?.support_game_mode;
  if (raw != null && !isValidSupportGameMode(raw)) {
    toast.warn(
      'support_game_mode 格式非法，已重置',
      `原值 "${String(raw)}" 不是 X#Y（X/Y ∈ {0,1}）；Joyose 在非法格式下会静默忽略 mode 限制，已按当前勾选重建。`,
    );
  }
  const base: [string, string] = isValidSupportGameMode(raw) ? (raw.split('#') as [string, string]) : ['0', '0'];
  base[idx] = on ? '1' : '0';
  p.support_game_mode = `${base[0]}#${base[1]}`;
  markDirty();
}

function setStrategy(p: FisrPolicy, value: string): void {
  const v = value.trim();
  p.strategy = v || 'MIFISR';
  markDirty();
}

// `disable_scene_list` is an integer array; drop empty / non-integer tokens
// rather than rejecting mid-edit. Empty input removes the field.
function setDisableSceneList(p: FisrPolicy, value: string): void {
  const v = value.trim();
  if (v === '') {
    delete p.disable_scene_list;
  } else {
    const ids = v.split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n));
    p.disable_scene_list = ids;
  }
  markDirty();
}

// `support_resolution_leave` stays a raw string — Joyose parses it itself.
function setResolutionLeave(p: FisrPolicy, value: string): void {
  const v = value.trim();
  if (v === '') {
    delete p.support_resolution_leave;
  } else {
    p.support_resolution_leave = v;
  }
  markDirty();
}

// `switch_default_status` is an "X#Y" bitmap for the initial switch state.
function setSwitchDefaultStatus(p: FisrPolicy, value: string): void {
  const v = value.trim();
  if (v === '') {
    delete p.switch_default_status;
  } else {
    p.switch_default_status = v;
  }
  markDirty();
}

// Coalesce rewrites to one per animation frame. Typing in a number field used
// to serialise + re-detect paths on every keystroke, which is the main source
// of input lag on device.
let rewriteQueued = false;

function queueRewrite() {
  if (rewriteQueued) return;
  rewriteQueued = true;
  requestAnimationFrame(() => {
    rewriteQueued = false;
    rewrite();
  });
}

function rewrite() {
  const p = currentParsed.value;
  if (!p) return;
  // Skip while the user is mid-edit (cleared a numeric field → NaN). Writing
  // "NaN" into the on-disk string would corrupt the list.
  const nums: number[] = [p.minFps, p.targetFps, p.t1, p.t2, p.t3, p.t4, ...p.srcFps];
  if (nums.some((n) => !Number.isFinite(n))) return;
  try {
    const serialized = serializeMifisr(p);
    const list = ensureMifisrList();
    list[selected.value] = serialized;
    markDirty();
  } catch (err) {
    console.warn('mifisr serialize failed:', err);
  }
}

function rewriteFromSrcText() {
  if (!currentParsed.value) return;
  const parts = srcFpsText.value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) {
    toast.error('srcFps 格式错误', '逗号分隔的正整数，如 60 或 45,60');
    return;
  }
  currentParsed.value.srcFps = nums;
  rewrite();
}

function addBlank() {
  const list = ensureMifisrList();
  const template = blankMifisr('com.example.newgame');
  list.push(serializeMifisr(template));
  selected.value = list.length - 1;
  markDirty();
}

async function addFromPreset() {
  if (mifisrPresets.length === 0) return;
  const value = await dialog.select(
    '从预设添加 MIFISR 条目',
    mifisrPresets.map((p, i) => ({
      label: p.label,
      value: String(i),
      detail: p.string,
    })),
    { detail: '选一款游戏：会追加一条 game_mifisr_config 并自动应用 MIFISR 路由。' },
  );
  if (value === null) return;
  const preset = mifisrPresets[Number(value)];
  if (!preset) return;
  const list = ensureMifisrList();
  list.push(preset.string);
  selected.value = list.length - 1;
  if (preset.route === 'mifisrStandard') {
    applyFisrPreset(preset.pkg);
  }
  markDirty();
}

function removeCurrent() {
  if (!currentParsed.value) return;
  const pkg = currentParsed.value.pkg;
  const gb = ensureGameBooster();
  const list = ensureMifisrList();
  list.splice(selected.value, 1);
  if (list.length === 0) {
    selected.value = 0;
  } else if (selected.value >= list.length) {
    selected.value = list.length - 1;
  }
  if (gb.fisr_config) removePkg(gb.fisr_config, pkg);
  removeFromMqs(pkg);
  removeFromDpFiConfig(pkg);
  markDirty();
}

// Feature→strategy is hardcoded by Joyose (status code dispatch). Pull the 3
// canonical policies out of mifisrStandard() so "add one feature" and "apply
// whole preset" share a single source of truth.
function policyForFeature(feature: 'FI' | 'SR' | 'FISR'): FisrPolicy {
  const found = STRATEGY_PRESETS.mifisrStandard().find((p) => p.feature === feature);
  if (!found) throw new Error(`no preset policy for ${feature}`);
  return found;
}

function hasFeature(feature: string): boolean {
  return routedPolicies.value?.some((p) => p.feature === feature) ?? false;
}

function addFisrFeature(feature: 'FI' | 'SR' | 'FISR') {
  if (!currentParsed.value) return;
  const pkg = currentParsed.value.pkg;
  const gb = ensureGameBooster();
  if (!gb.fisr_config) gb.fisr_config = emptyFisrConfig();
  const policy = policyForFeature(feature);
  const added = addPolicyForPkg(gb.fisr_config as FisrConfig, pkg, policy);
  if (!added) {
    toast.warn(`${feature} 已存在`, `${pkg} 的 fisr_config 里已有 ${feature} policy，未重复添加`);
    return;
  }
  // MIFISR doesn't read dp_fi_config (that's DMI's concern), so the default
  // preset flow doesn't touch it.
  if (alsoUpdateMqs.value) addToMqs(pkg);
  markDirty();
  toast.success(`已添加 ${feature}`, `strategy=${policy.strategy}`);
}

function removeFisrFeature(feature: string) {
  if (!currentParsed.value) return;
  const pkg = currentParsed.value.pkg;
  const gb = ensureGameBooster();
  if (!gb.fisr_config) return;
  const removed = removePolicyForPkg(gb.fisr_config as FisrConfig, pkg, feature);
  if (!removed) return;
  markDirty();
  toast.success(`已移除 ${feature}`);
}

function applyFisrPreset(pkg: string) {
  const gb = ensureGameBooster();
  if (!gb.fisr_config) gb.fisr_config = emptyFisrConfig();
  upsertPkgPolicy(gb.fisr_config, pkg, STRATEGY_PRESETS.mifisrStandard());
  if (alsoUpdateMqs.value) addToMqs(pkg);
  markDirty();
}

function addToMqs(pkg: string) {
  const gb = ensureGameBooster();
  if (!Array.isArray(gb.mqs_enhance_list)) gb.mqs_enhance_list = [];
  const entry = `${pkg}:60#default`;
  if (!gb.mqs_enhance_list.some((s: string) => s === entry || s.startsWith(`${pkg}:`))) {
    gb.mqs_enhance_list.push(entry);
  }
}

function removeFromMqs(pkg: string) {
  const gb = ensureGameBooster();
  if (Array.isArray(gb.mqs_enhance_list)) {
    gb.mqs_enhance_list = gb.mqs_enhance_list.filter((s: string) => !s.startsWith(`${pkg}:`));
  }
}

// DMI (feature "FI" + strategy DMI) reads customize_game_params.dp_fi_config
// at activation time; a miss makes l.b.q() return -1 and FI silently aborts.
// Kept for expert users who switch a policy to DMI in the JSON editor.
function removeFromDpFiConfig(pkg: string): void {
  const gb = ensureGameBooster();
  const list = gb.customize_game_params?.dp_fi_config;
  if (!Array.isArray(list)) return;
  gb.customize_game_params.dp_fi_config = list.filter((s: string) => !s.startsWith(`${pkg}_`));
}

function applyThermal(t1: number, t2: number, t3: number, t4: number) {
  if (!currentParsed.value) return;
  currentParsed.value.t1 = t1;
  currentParsed.value.t2 = t2;
  currentParsed.value.t3 = t3;
  currentParsed.value.t4 = t4;
  rewrite();
}

function enableMifisrSwitch() {
  const gb = ensureGameBooster();
  gb.fisr_mqs_v2 = true;
  markDirty();
  toast.success('已开启 MIFISR 总开关', 'fisr_mqs_v2 = true');
}
</script>

<style scoped>
.diag {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.diag-refresh {
  margin-left: auto;
  align-self: center;
  min-height: 26px;
  padding: 4px 8px;
}

.diag-refresh :deep(svg) {
  width: 14px;
  height: 14px;
}

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.issue {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-sunken);
}

.issue.compact {
  padding: 9px 11px;
}

.issue.ok {
  border-color: var(--surface-ok-border);
  background: var(--surface-ok-bg);
}

.issue.warn {
  border-color: var(--surface-warn-border);
  background: var(--surface-warn-bg);
}

.issue.error {
  border-color: var(--surface-error-border);
  background: var(--surface-error-bg);
}

.issue-icon {
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 2px;
  color: var(--text-muted);
}

.issue.ok .issue-icon {
  color: var(--ok);
}

.issue.warn .issue-icon {
  color: var(--warn);
}

.issue.error .issue-icon {
  color: var(--danger);
}

.issue-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.issue-body strong {
  font-size: 13px;
  font-weight: 600;
}

.code-block {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.55;
  overflow-x: clip;
  color: var(--text-muted);
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 8px;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.detail-pkg {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-top: 2px;
  word-break: break-all;
}

.policy-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
}

.policy-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--hairline);
}

.field-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 5px 0;
}

.field-name {
  min-width: 190px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.field-input.w-strategy {
  width: 132px;
}

.field-input.w-refresh {
  width: 116px;
}

.field-input.w-scene {
  width: 180px;
}

.field-input.w-flag {
  width: 76px;
}

.field-input.invalid {
  border-color: var(--surface-warn-border);
  background: var(--surface-warn-bg);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-muted);
  cursor: pointer;
}

.vk-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--hairline);
}

.vk-hint {
  color: var(--warn);
  font-weight: 600;
}

.serialized {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.serialized-value {
  word-break: break-all;
  color: var(--text-muted);
  font-size: 11.5px;
}

@media (max-width: 860px) {

  .field-name {
    min-width: 100%;
  }

  .field-input {
    flex: 1 1 auto;
    width: auto;
    min-width: 120px;
  }

  .field-input.w-scene {
    min-width: 160px;
  }

  .detail-pkg {
    font-size: 13.5px;
  }
}
</style>
