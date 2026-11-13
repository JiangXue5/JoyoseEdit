<template>
  <div class="stack">
    <PageHeader title="编辑历史" kicker="git-style deltas"
      desc="历史保存在 /data/adb/joyose-edit/history/，每条只记录本次变更的增量。恢复会从当前内存状态反向推算，回滚不会删除任何历史。">
      <button class="ghost" @click="refresh" :disabled="loading">
        <AppIcon name="refresh" /> 刷新
      </button>
      <button class="danger" @click="handleClear" :disabled="loading">清理旧历史</button>
    </PageHeader>

    <div v-if="floor > 0" class="banner warn">
      <strong>早于 seq {{ floor }} 的记录已失效</strong>
      <span>最近一次「从此备份回滚」直接替换了数据库，之前的增量记录对应的是另一份基准，不能再按增量回放。它们仍可查看；需要回到更早的状态请用备份回滚。</span>
    </div>

    <div class="twopane">
      <div class="list">
        <button v-for="item in listing" :key="item.name" class="item" :class="{ active: selected?.name === item.name }"
          @click="select(item.name)">
          <strong>{{ formatTime(item.timestamp) }}</strong>
          <span class="sub">seq {{ item.seq }}</span>
          <span v-if="selected?.name === item.name && detailLoading" class="sub">加载中…</span>
        </button>
        <div v-if="listing.length === 0" class="muted tiny" style="padding: 12px">
          （暂无历史）
        </div>
      </div>

      <div v-if="record" class="detail stack">
        <div class="row">
          <strong>seq {{ record.seq }}</strong>
          <span class="pill">{{ record.source }}</span>
          <span class="pill">{{ formatTime(record.timestamp) }}</span>
          <button v-if="record.source !== 'backup' && record.canRevert !== false" class="primary" @click="restore"
            style="margin-left: auto" :disabled="detailLoading || restoreDisabled"
            :title="restoreDisabled
              ? '这条记录早于最近一次文件级回滚，基准已失效，不能再按增量回放'
              : '把内存状态回溯到此次提交完成后的状态；还需点顶栏「提交到设备」才真正生效。想看此提交之前的状态，请选前一条记录恢复'">
            {{ restoreDisabled ? '基准已失效' : '恢复到此提交' }}
          </button>
          <button v-else-if="record.canRevert === false" class="ghost" disabled style="margin-left: auto"
            title="这条记录不改变任何配置（例如备份锚点），没有可回放的内容">
            无变更
          </button>
          <button v-else class="danger" @click="revertFromBackup" style="margin-left: auto"
            title="直接把此时间点的 DB 字节拷贝回 Joyose（文件级恢复，立即生效）">
            从此备份回滚
          </button>
        </div>
        <div v-if="record.note" class="muted tiny">note: {{ record.note }}</div>
        <div v-if="record.dbKind || record.afterDigest" class="muted tiny">
          <span v-if="record.dbKind">写入目标：{{ dbKindLabel }}</span>
          <span v-if="record.afterDigest?.smartp">　SmartP {{ record.afterDigest.smartp.slice(0, 8) }}</span>
          <span v-if="record.afterDigest?.teg">　teg {{ record.afterDigest.teg.slice(0, 8) }}</span>
          <span v-if="!record.afterDigest">　（旧记录，无写入后摘要）</span>
        </div>
        <div class="panel" style="margin: 0; background: var(--bg-elevated)">
          <h2 style="font-size: 14px">变更 <small>{{ diffEntries.length }} 条</small></h2>
          <div v-if="diffEntries.length === 0" class="muted tiny">（无字段变化）</div>
          <div v-else style="max-height: 300px; overflow-y: auto">
            <div v-for="(r, i) in diffEntries.slice(0, 500)" :key="i" class="diff-line" :class="r.kind">{{
              summarize(r) }}</div>
          </div>
          <div v-if="diffEntries.length > 500" class="hint" style="margin-top: var(--space-2)">
            仅显示前 500 条。
          </div>
        </div>
      </div>
      <div v-else-if="detailLoading" class="detail muted tiny">加载中…</div>
      <div v-else-if="selected" class="detail muted tiny">读取失败，请重试或选其他记录。</div>
      <div v-else class="detail muted tiny">从列表里选一条。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, ref } from 'vue';
import {
  listHistory,
  readHistory,
  restoreToRecord,
  markDirty,
  pullAll,
  revertToBackup,
} from '@/state/session';
import * as bridge from '@/root/bridge';
import { toast } from '@/state/toast';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import { dialog } from '@/state/dialog';
import type { HistoryFileMeta, HistoryRecord } from '@/history/store';
import { summarizeRecord } from '@/history/diff';
import { getHistoryFloor } from '@/state/source';

const listing = ref<HistoryFileMeta[]>([]);
const selected = ref<HistoryFileMeta | null>(null);
const record = ref<HistoryRecord | null>(null);
const loading = ref(false);
const detailLoading = ref(false);

const diffEntries = computed(() => record.value?.delta ?? []);
const dbKindLabel = computed(() => {
  switch (record.value?.dbKind) {
    case 'smartp': return '仅 SmartP.db';
    case 'teg': return '仅 teg_config.db';
    case 'both': return '两个库';
    default: return '';
  }
});
/** Newest seq that predates a file-level revert; 0 when none happened. */
const floor = ref(0);
const restoreDisabled = computed(
  () => floor.value > 0 && record.value !== null && record.value.seq <= floor.value,
);

// Views live inside <KeepAlive>, so refresh whenever the tab is re-entered —
// a commit in another tab adds files that this list must pick up.
onActivated(() => refresh());

async function refresh() {
  loading.value = true;
  try {
    listing.value = await listHistory();
    floor.value = getHistoryFloor();
    selected.value = null;
    record.value = null;
  } catch (err) {
    toast.fromError(err, '读取历史列表失败');
  } finally {
    loading.value = false;
  }
}

async function select(name: string) {
  selected.value = listing.value.find((l) => l.name === name) ?? null;
  record.value = null;
  detailLoading.value = true;
  try {
    record.value = await readHistory(name);
  } catch (err) {
    toast.fromError(err, '读取历史记录失败');
  } finally {
    detailLoading.value = false;
  }
}

async function restore() {
  if (!record.value) return;
  detailLoading.value = true;
  try {
    await restoreToRecord(record.value.seq);
    markDirty();
    toast.info('已恢复到此提交', '点顶栏「提交到设备」才会真正写入 DB，并生成一条新的历史记录');
  } catch (err) {
    toast.fromError(err, '恢复失败');
  } finally {
    detailLoading.value = false;
  }
}

async function revertFromBackup() {
  if (!record.value || record.value.source !== 'backup') return;
  const backupName = record.value.note;
  if (!backupName) {
    toast.warn('此记录缺少备份名，无法回滚');
    return;
  }
  const ok = await dialog.confirm(`从备份「${backupName}」回滚？`, {
    detail: '两份 DB 会被覆盖为该备份的字节，立即生效。编辑历史仍保留。',
    okText: '回滚',
    destructive: true,
  });
  if (!ok) return;
  try {
    const reverted = await revertToBackup(backupName);
    // The rollback itself succeeded; a failed refresh only means the page is
    // still showing pre-rollback values. Say that instead of "回滚失败".
    const pulled = await pullAll();
    if (reverted.wasRunning && reverted.restarted === false) {
      toast.warn('已回滚，但 Joyose 未能重新启动 —— 请手动重启它后再进游戏', backupName);
    } else if (!pulled.ok) {
      toast.warn('已回滚，但界面刷新失败', `${pulled.error} · 请手动刷新`); 
    } else {
      toast.success('已回滚到备份', backupName);
    }
  } catch (err) {
    toast.fromError(err, '回滚失败');
  }
}

async function handleClear() {
  const v = await dialog.prompt('清理历史记录', {
    detail: '保留最近 N 条，其余删除（不可撤销）。',
    initialValue: '100',
    placeholder: '非负整数',
  });
  if (v === null) return;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    toast.warn('输入无效', '请输入非负整数');
    return;
  }
  try {
    const r = await bridge.historyClear(n);
    await refresh();
    toast.success(`已保留最近 ${r.kept} 条历史`);
  } catch (err) {
    toast.fromError(err, '清理失败');
  }
}

function summarize(r: Parameters<typeof summarizeRecord>[0]): string {
  return summarizeRecord(r);
}

function formatTime(epoch: number): string {
  try {
    const d = new Date(epoch * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(epoch);
  }
}
</script>
