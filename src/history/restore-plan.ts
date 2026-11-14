// Decide whether a history record may be replayed, and compute the snapshot
// it leads to.
//
// This used to live inline in session.ts, where every rule below was reachable
// only through a live device: the "refuse to replay onto a moved base" check
// had no test at all. Pulling the decision out as a pure function means the
// six rollback scenarios (immediate, consecutive, after a file-level revert,
// after a cloud pull, per-database, with a concurrent cloud update) can be
// replayed in the test suite.

import type { ConfigSnapshot, DbDigests, HistoryFileMeta, HistoryRecord } from './store';
import { applyDeltaReport, formatPath, invertDelta } from './diff';

export type RestoreFailure =
  /** The record predates a file-level revert, so its base no longer exists. */
  | 'floor'
  /** No history file carries that seq. */
  | 'missing'
  /** A marker record (backup checkpoint) with nothing to replay. */
  | 'no-delta'
  /** The databases were rewritten after the newest commit. */
  | 'drift'
  /** A record has a base digest but the current one cannot be read, so there
   *  is no way to tell whether the base still holds. */
  | 'unknown'
  /** A path in the delta no longer exists in the snapshot. */
  | 'replay';

export interface RestoreRequest {
  targetSeq: number;
  /** Newest seq that predates a file-level revert; 0 when none happened. */
  floor: number;
  /** All history files, newest first (listHistory()'s order). */
  meta: HistoryFileMeta[];
  /** Records with `seq > targetSeq`. Order does not matter: `planRestore`
   *  replays them by descending `seq`. */
  newerRecords: HistoryRecord[];
  targetRecord: HistoryRecord;
  /** Digests as the newest recorded commit left the databases, or null when
   *  no record carries one (records written before v1.2.0). */
  anchorDigest: DbDigests | null;
  /** Digests right now, or null when the helper cannot compute them. */
  nowDigest: DbDigests | null;
  /** The snapshot the chain is replayed backwards from. */
  current: ConfigSnapshot;
}

export type RestoreOutcome =
  | { ok: true; snapshot: ConfigSnapshot }
  | { ok: false; code: RestoreFailure; message: string };

export function planRestore(req: RestoreRequest): RestoreOutcome {
  const { targetSeq, floor, meta, targetRecord } = req;

  if (floor > 0 && targetSeq <= floor) {
    return {
      ok: false,
      code: 'floor',
      message:
        `这条记录（seq=${targetSeq}）早于最近一次文件级回滚（seq=${floor}），`
        + '它对应的数据库基准已经不存在，不能直接回滚。请用备份回滚，或只回滚回滚之后的新记录。',
    };
  }

  if (!meta.some((m) => m.seq === targetSeq)) {
    return { ok: false, code: 'missing', message: `未找到 seq=${targetSeq} 的历史记录` };
  }

  if (targetRecord.canRevert === false) {
    return {
      ok: false,
      code: 'no-delta',
      message:
        `seq=${targetSeq} 只是一条标记（没有配置改动），回滚它不会恢复任何东西。`
        + '请选择它前后的真实提交。',
    };
  }

  // "I could not check" is not "nothing changed". When the newest record knows
  // the digest it was written against and the current one cannot be read, the
  // replay would run on an unverified base and still report success.
  // `anchorDigest === null` is the older case — records from before v1.2.0
  // carry no digest at all — and stays allowed, otherwise upgrading the module
  // would block every rollback of the existing history.
  if (req.anchorDigest && !req.nowDigest) {
    return {
      ok: false,
      code: 'unknown',
      message:
        '无法读取当前数据库摘要（设备端 sha256 不可用），所以不能确认这份历史记录是否仍对应当前数据库。'
        + '已停止回滚：请重启设备后重试，或用「备份」里的文件级回滚。',
    };
  }

  const drift = digestDrift(req.anchorDigest, req.nowDigest);
  if (drift.length) {
    return {
      ok: false,
      code: 'drift',
      message:
        `${drift.join('、')} 在最后一次提交后又被改过（可能是云端下发或手动修改），`
        + '直接回滚会把那份改动一起覆盖。已停止回滚：请先刷新确认现状，'
        + '或用「备份」里的文件级回滚。',
    };
  }

  let snap: ConfigSnapshot = JSON.parse(JSON.stringify(req.current));
  const missing: string[] = [];
  // Newest first: undo the newest delta before the older one. The order is
  // taken from `seq`, not from the order the caller listed the files in —
  // `listHistory()` sorts by timestamp, and a file whose timestamp did not
  // match its seq (an imported or hand-edited record) would otherwise be
  // undone out of order, which fails the replay or, worse, succeeds against
  // the wrong base.
  const newer = [...req.newerRecords].sort((a, b) => b.seq - a.seq);
  for (const rec of newer) {
    const rep = applyDeltaReport(snap, invertDelta(rec.delta));
    snap = rep.value;
    for (const p of rep.missing) missing.push(formatPath(p));
  }
  if (missing.length) {
    const sample = missing.slice(0, 3).join('、');
    return {
      ok: false,
      code: 'replay',
      message:
        `历史记录与当前数据库不匹配（${missing.length} 处路径不存在：${sample}`
        + `${missing.length > 3 ? ' …' : ''}）。已停止回滚，请先刷新后再试。`,
    };
  }

  return { ok: true, snapshot: snap };
}

/** Names of the databases whose live bytes no longer match what the newest
 *  commit left behind. Empty when nothing drifted, either digest is unknown,
 *  or a side is missing (a file that does not exist cannot have changed).
 *
 *  "Either digest unknown" is why planRestore rejects that case separately:
 *  this helper answers "what drifted", not "is it safe to proceed". */
export function digestDrift(anchor: DbDigests | null, now: DbDigests | null): string[] {
  if (!anchor || !now) return [];
  const out: string[] = [];
  if (anchor.smartp && now.smartp && anchor.smartp !== now.smartp) out.push('SmartP.db');
  if (anchor.teg && now.teg && anchor.teg !== now.teg) out.push('teg_config.db');
  return out;
}
