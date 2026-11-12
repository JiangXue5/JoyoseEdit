<template>
  <div class="stack">
    <PageHeader title="JSON 编辑" kicker="raw editor"
      desc="直接改云控参数树。保存是直写：立刻写入所选数据库的那一行并重启 Joyose，不走底部提交条。">
      <select v-model="target" aria-label="编辑目标">
        <option v-for="t in TARGETS" :key="t.id" :value="t.id">{{ t.label }}</option>
      </select>
      <button class="ghost" @click="resetLatest(true)" :disabled="busy || !editor">
        <AppIcon name="refresh" /> 重置为最新值
      </button>
      <button class="primary" @click="save" :disabled="!editor || !isValidJson || targetEmpty || busy">
        {{ busy ? '写入中…' : '保存到设备' }}
      </button>
    </PageHeader>

    <div v-if="targetEmpty" class="banner warn">
      <strong>{{ targetEmptyReason }}</strong>
      <span>当前目标在对应数据库里没有这一行，因此不能写入。换一个目标，或先在对应页面创建该配置。</span>
    </div>

    <div class="panel editor-panel">
      <div class="cm-shell" ref="editorRoot" />
      <div class="editor-status">
        <span v-if="!isValidJson" class="pill danger">JSON 无法解析：{{ parseError }}</span>
        <span v-else class="pill ok">JSON 合法</span>
        <span v-if="dirty" class="pill warn">未保存</span>
        <span class="tiny faint">{{ codeLength }} 字符</span>
        <div class="editor-actions">
          <label class="editor-link">
            导入
            <input type="file" accept=".json,application/json" style="display: none" @change="importFile" />
          </label>
          <button class="editor-link" @click="exportText" :disabled="!editor || !isValidJson || targetEmpty">
            导出
          </button>
        </div>
      </div>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2>关于这个页面 <small>何时用</small></h2>
      </div>
      <div class="hint">
        结构化页面覆盖不到的字段、或从别处拿到的整段配置，可以在这里直接落盘。
        保存前会自动备份一次（标签 <span class="mono">json-edit</span>），可从「编辑历史 / 备份」回滚。
      </div>
      <div class="hint" style="margin-top: 8px">
        <strong>SmartP 目标</strong>只写 <span class="mono">cloud_config</span> 的那一行；
        <strong>teg 目标</strong>只写 <span class="mono">rules</span> 里该模块的最新一行。
        两边不会自动互相同步 —— 想让两份一致，请在结构化页面改完用底部「提交到设备」。
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, ref, watch } from 'vue';
import { state, saveJsonTarget, pullAll, currentRuleRow, type JsonTarget } from '@/state/session';
import * as bridge from '@/root/bridge';
import { toast } from '@/state/toast';
import { theme } from '@/state/theme';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
// CodeMirror is the biggest single contributor to bundle size and is only used
// in this view — defer every import until the view actually mounts.
import type { EditorView } from 'codemirror';

const TARGETS: { id: JsonTarget; label: string }[] = [
  { id: 'sp_booster', label: 'SmartP · booster_config.params' },
  { id: 'sp_common', label: 'SmartP · common_config.params' },
  { id: 'teg_booster', label: 'teg · booster_config（最新一行信封）' },
  { id: 'teg_common', label: 'teg · common_config（最新一行信封）' },
];

const target = ref<JsonTarget>('sp_booster');
const editorRoot = ref<HTMLElement | null>(null);
const editor = ref<EditorView | null>(null);
const isValidJson = ref(true);
const parseError = ref('');
const codeLength = ref(0);
const busy = ref(false);
/** Editor content differs from the last load / save. */
const dirty = ref(false);
/** Set while WE rewrite the document, so the update listener does not flag it. */
let suppressDirty = false;
// CodeMirror themes go through a Compartment so switching the app theme
// recolours the document without destroying it.
let themeCompartment: any = null;

const targetEmpty = computed(() => {
  switch (target.value) {
    case 'sp_booster':
      return !state.smartpRaw.booster_config;
    case 'sp_common':
      return !state.smartpRaw.common_config;
    case 'teg_booster':
      return (state.rulesByModule.booster_config ?? []).length === 0;
    case 'teg_common':
      return (state.rulesByModule.common_config ?? []).length === 0;
  }
});

const targetEmptyReason = computed(() => {
  const sp = target.value.startsWith('sp_');
  const name = target.value.endsWith('booster') ? 'booster_config' : 'common_config';
  return sp
    ? `SmartP 里没有 ${name}`
    : `teg_config 里没有 ${name}`;
});

/** Content of the selected row, as pretty JSON.
 *  teg shows the module's CURRENT row (highest rule_version) as a single
 *  envelope — the rules table keeps every historical release, and dumping the
 *  array made it impossible to tell which one Joyose actually uses. */
function currentText(): string {
  switch (target.value) {
    case 'sp_booster':
      return JSON.stringify(state.smartpRaw.booster_config ?? {}, null, 2);
    case 'sp_common':
      return JSON.stringify(state.smartpRaw.common_config ?? {}, null, 2);
    case 'teg_booster':
    case 'teg_common': {
      const mod = target.value === 'teg_booster' ? 'booster_config' : 'common_config';
      const row = currentRuleRow(state.rulesByModule[mod] ?? []);
      return JSON.stringify(row?.content ?? {}, null, 2);
    }
  }
}

function reset() {
  const text = currentText();
  if (!editor.value) {
    dirty.value = false;
    return;
  }
  suppressDirty = true;
  editor.value.dispatch({
    changes: { from: 0, to: editor.value.state.doc.length, insert: text },
  });
  suppressDirty = false;
  isValidJson.value = true;
  parseError.value = '';
  codeLength.value = text.length;
  dirty.value = false;
}

/** Re-pull first: the in-memory copies are only rebuilt on pull, so "reset"
 *  without a pull can restore a snapshot that is already stale. */
async function resetLatest(withInfo = false) {
  try {
    await pullAll();
    reset();
    if (withInfo) toast.info('已重置为数据库最新值');
  } catch (err) {
    toast.fromError(err, '重置失败');
  }
}

let cancelSwitch = false;
watch(
  target,
  async (nv, ov) => {
    if (ov === undefined) {
      reset();
      return;
    }
    if (cancelSwitch) {
      cancelSwitch = false;
      return;
    }
    if (dirty.value && !window.confirm('编辑器有未保存的修改，切换目标会丢弃它们。继续？')) {
      dirty.value = false;
      cancelSwitch = true;
      target.value = ov;
      return;
    }
    dirty.value = false;
    await resetLatest();
  },
  { immediate: true },
);

async function mountEditor() {
  await nextTick();
  if (!editorRoot.value || editor.value) return;
  const [{ EditorView: EV, basicSetup }, { json }, { oneDark }, { EditorState, Compartment }] =
    await Promise.all([
      import('codemirror'),
      import('@codemirror/lang-json'),
      import('@codemirror/theme-one-dark'),
      import('@codemirror/state'),
    ]);
  themeCompartment = new Compartment();
  editor.value = new EV({
    state: EditorState.create({
      doc: currentText(),
      extensions: [
        basicSetup,
        json(),
        themeCompartment.of(theme.effective === 'light' ? [] : oneDark),
        EV.updateListener.of((v) => {
          if (!v.docChanged) return;
          if (suppressDirty) return;
          dirty.value = true;
          const text = v.state.doc.toString();
          codeLength.value = text.length;
          try {
            JSON.parse(text);
            isValidJson.value = true;
            parseError.value = '';
          } catch (err: any) {
            isValidJson.value = false;
            parseError.value = err?.message ?? String(err);
          }
        }),
      ],
    }),
    parent: editorRoot.value,
  });
  codeLength.value = editor.value.state.doc.length;
}

watch(editorRoot, (el) => {
  if (el) mountEditor();
});

watch(
  () => theme.effective,
  async (effective) => {
    if (!editor.value || !themeCompartment) return;
    const { oneDark } = await import('@codemirror/theme-one-dark');
    editor.value.dispatch({
      effects: themeCompartment.reconfigure(effective === 'light' ? [] : oneDark),
    });
  },
);

onActivated(() => {
  // Coming back to the tab: refresh the baseline content quietly, but never
  // clobber unsaved edits.
  if (!dirty.value) void resetLatest();
});

onBeforeUnmount(() => {
  if (dirty.value) {
    window.confirm('编辑器有未保存的修改，离开页面会丢失');
  }
  editor.value?.destroy();
});

async function save() {
  if (!editor.value) return;
  const text = editor.value.state.doc.toString();
  busy.value = true;
  try {
    await saveJsonTarget(target.value, text);
    toast.success(
      '已写入设备',
      `${targetLabel()} · Joyose 已重启，进游戏即生效`,
    );
    reset();
  } catch (err) {
    toast.fromError(err, '保存失败');
  } finally {
    busy.value = false;
  }
}

function targetLabel(): string {
  return TARGETS.find((t) => t.id === target.value)?.label ?? target.value;
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !editor.value) return;
  const text = await file.text();
  suppressDirty = true;
  editor.value.dispatch({
    changes: { from: 0, to: editor.value.state.doc.length, insert: text },
  });
  suppressDirty = false;
  dirty.value = true;
  try {
    JSON.parse(text);
    isValidJson.value = true;
    parseError.value = '';
    toast.info('已载入文件', '检查内容后点「保存到设备」写入');
  } catch (err: any) {
    isValidJson.value = false;
    parseError.value = err?.message ?? String(err);
    toast.warn('文件已载入，但 JSON 无法解析', parseError.value);
  }
  codeLength.value = text.length;
}

async function exportText() {
  if (!editor.value) return;
  const text = editor.value.state.doc.toString();
  const name = `${target.value.replace('_', '-')}.json`;
  try {
    const res = await bridge.exportFile(name, text);
    toast.success('已导出', res.path);
  } catch (err) {
    toast.fromError(err, '导出失败');
  }
}
</script>

<style scoped>
.editor-panel {
  padding: 0;
  overflow: hidden;
}

.editor-panel .cm-shell {
  border: none;
  border-radius: 0;
  height: min(58dvh, 580px);
}

.editor-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  flex-wrap: wrap;
}

.editor-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.editor-link {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  line-height: 1.2;
}

.editor-link:hover {
  color: var(--text);
  border-color: var(--border);
}

@media (max-width: 860px) {
  .editor-panel .cm-shell {
    height: 54dvh;
  }
}
</style>
