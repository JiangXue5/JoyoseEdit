<template>
  <div class="stack">
    <PageHeader title="JSON 编辑" kicker="raw editor" desc="直接编辑云控参数树。应用后仅改动内存，需在底部提交条写入设备。">
      <select v-model="target" aria-label="编辑目标">
        <option v-for="name in cloudConfigNames" :key="name" :value="'cc:' + name">
          cloud_config.{{ name }}.params
        </option>
        <option v-for="mod in rulesModules" :key="mod" :value="'rule:' + mod">
          teg_config.rules[{{ mod }}].rule_content
        </option>
      </select>
      <button class="ghost" @click="reset">重置</button>
      <button class="primary" @click="apply" :disabled="!editor || !isValidJson">应用到内存</button>
    </PageHeader>

    <div class="panel editor-panel">
      <div class="cm-shell" ref="editorRoot" />
      <div class="editor-status">
        <span v-if="!isValidJson" class="pill danger">JSON 无法解析：{{ parseError }}</span>
        <span v-else class="pill ok">JSON 合法</span>
        <span class="tiny faint">{{ codeLength }} 字符</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { state, markDirty } from '@/state/session';
import { toast } from '@/state/toast';
import { theme } from '@/state/theme';
import PageHeader from './PageHeader.vue';
// CodeMirror is the biggest single contributor to bundle size and is only
// used in this view — defer all imports until the view actually mounts.
import type { EditorView } from 'codemirror';

const target = ref<string>('');
const editorRoot = ref<HTMLElement | null>(null);
const editor = ref<EditorView | null>(null);
const isValidJson = ref(true);
const parseError = ref('');
const codeLength = ref(0);
// CodeMirror themes are set through a Compartment so switching the app theme
// recolours the editor without destroying the document / cursor.
let themeCompartment: any = null;

const cloudConfigNames = computed(() => Object.keys(state.cloudConfig));
const rulesModules = computed(() => Object.keys(state.rulesByModule));

watch(cloudConfigNames, (names) => {
  if (!target.value && names.length > 0) target.value = 'cc:' + names[0];
}, { immediate: true });

watch(target, () => reset(), { immediate: true });

function currentText(): string {
  if (!target.value) return '';
  const [kind, name] = target.value.split(':');
  if (kind === 'cc') {
    return JSON.stringify(state.cloudConfig[name]?.params ?? {}, null, 2);
  }
  const rows = state.rulesByModule[name] ?? [];
  return JSON.stringify(rows.map((r) => r.content), null, 2);
}

function reset() {
  const text = currentText();
  if (!editor.value) return;
  editor.value.dispatch({
    changes: { from: 0, to: editor.value.state.doc.length, insert: text },
  });
  isValidJson.value = true;
  parseError.value = '';
  codeLength.value = text.length;
}

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

onBeforeUnmount(() => {
  editor.value?.destroy();
});

function apply() {
  if (!editor.value) return;
  const text = editor.value.state.doc.toString();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    toast.fromError(err, 'JSON 解析失败');
    return;
  }
  const [kind, name] = target.value.split(':');
  if (kind === 'cc') {
    if (!state.cloudConfig[name]) return;
    state.cloudConfig[name].params = parsed;
  } else {
    const rows = state.rulesByModule[name] ?? [];
    if (!Array.isArray(parsed) || parsed.length !== rows.length) {
      toast.error(`格式错误`, `必须是包含 ${rows.length} 个 rule_content 的 JSON 数组`);
      return;
    }
    for (let i = 0; i < rows.length; i++) rows[i].content = parsed[i];
  }
  markDirty();
  toast.success('已应用到内存', '使用顶部"提交到设备"按钮写入 DB');
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
  height: min(62dvh, 620px);
}

.editor-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
}

@media (max-width: 860px) {
  .editor-panel .cm-shell {
    height: 58dvh;
  }
}
</style>
