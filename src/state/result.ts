// One shape for every mutating operation.
//
// The UI used to read a different combination of booleans per action: a commit
// returned `changed` + `wroteSmartp` + `wroteTeg`, a backup returned `stopped`,
// a revert returned `wasRunning` + `restarted`, freeze returned `stopped` +
// `frozen`. Every view re-derived "did it work, and is Joyose running now?"
// from those pieces, and each one could get it wrong differently.
//
// `code` is the single thing a view branches on. The booleans below it are
// facts, not verdicts: `databaseChanged` says the DB bytes moved,
// `joyoseRestarted` says the process was observed back up. They are
// deliberately separate — "we wrote the config" and "Joyose reloaded it" fail
// independently, and a UI that merges them tells the user the wrong thing.

export type OperationCode =
  /** DB written, history saved, Joyose observed running again. */
  | 'written'
  /** DB written, but on top of a cloud update that landed mid-commit. */
  | 'written-rebased'
  /** DB written; the restart was issued but could not be confirmed. */
  | 'written-reload-unconfirmed'
  /** DB written; Joyose refused to stop, so it still holds the old config. */
  | 'written-stop-failed'
  /** DB written; the restart command itself failed. */
  | 'written-restart-failed'
  /** DB written; Joyose is now stopped and will read the DB on next launch. */
  | 'written-stopped'
  /** DB written; the history record could not be saved. */
  | 'written-no-history'
  /** Nothing to write: the working copy equals the database. */
  | 'no-change'
  /** There are edits, but none fall inside the current write target. */
  | 'out-of-scope'
  | 'backed-up'
  | 'reverted'
  | 'reset'
  | 'frozen'
  | 'unfrozen'
  | 'failed';

export interface OperationResult {
  ok: boolean;
  code: OperationCode;
  /** One short sentence; views may use their own copy instead. */
  message: string;
  /** The database bytes changed on disk. */
  databaseChanged: boolean;
  /** A restore point was created as part of this operation. */
  backupCreated: boolean;
  /** Confirmed stopped before the write; null when the helper did not say. */
  joyoseStopped: boolean | null;
  /** Whether Joyose was up before we quiesced it. null when the helper is too
   *  old to say — which is not the same as "it was not running". */
  joyoseWasRunning: boolean | null;
  /** Observed running again; null when no restart was attempted or it could
   *  not be determined. */
  joyoseRestarted: boolean | null;
  /** Things that did not stop the operation but weakened it: a write verified
   *  by length instead of digest, a label that could not be re-applied. Views
   *  show these next to the success toast; an operation can be "done" and still
   *  not be what the user assumes. */
  warnings: string[];
}

export interface ResultInput {
  code: OperationCode;
  message?: string;
  databaseChanged?: boolean;
  backupCreated?: boolean;
  joyoseStopped?: boolean | null;
  joyoseWasRunning?: boolean | null;
  joyoseRestarted?: boolean | null;
  warnings?: string[];
}

/** `ok` follows from the code: every "written*" code and the completed
 *  operations are successes; `failed`, `no-change` and `out-of-scope` are not
 *  failures either — they are refusals the user needs told apart from one. */
export function makeResult(input: ResultInput): OperationResult {
  const ok = input.code !== 'failed';
  return {
    ok,
    code: input.code,
    message: input.message ?? defaultMessage(input.code),
    databaseChanged: input.databaseChanged ?? false,
    backupCreated: input.backupCreated ?? false,
    joyoseStopped: input.joyoseStopped ?? null,
    joyoseWasRunning: input.joyoseWasRunning ?? null,
    joyoseRestarted: input.joyoseRestarted ?? null,
    warnings: input.warnings ?? [],
  };
}

export function defaultMessage(code: OperationCode): string {  switch (code) {
    case 'written': return '已写入设备，Joyose 已重新加载配置';
    case 'written-rebased': return '已写入设备（云端更新已合并）';
    case 'written-reload-unconfirmed': return '已写入设备，但没能确认 Joyose 已重新启动';
    case 'written-stop-failed': return '已写入设备，但 Joyose 没有停止，仍在用旧配置';
    case 'written-restart-failed': return '已写入设备，但 Joyose 重启失败';
    case 'written-stopped': return '已写入设备，Joyose 已停止，下次启动时读取新配置';
    case 'written-no-history': return '已写入设备，但历史记录没有保存';
    case 'no-change': return '没有改动，未写入数据库';
    case 'out-of-scope': return '改动不在当前写入目标范围内，未写入';
    case 'backed-up': return '备份完成';
    case 'reverted': return '已从备份回滚';
    case 'reset': return '云控数据已清除';
    case 'frozen': return '已冻结云端版本';
    case 'unfrozen': return '已解冻云端版本';
    default: return '操作失败';
  }
}

/** Map the facts collected during a commit to one code.
 *
 *  Order matters and mirrors what the user must be told first: a history that
 *  did not save is more actionable than a restart that did not confirm, and
 *  both outrank "it was rebased". */
export function commitCode(args: {
  historyError?: string;
  restartError?: string;
  stopConfirmed: boolean | null;
  restartAttempted: boolean;
  startedAfter: boolean | null;
  rebased: boolean;
}): OperationCode {
  if (args.historyError) return 'written-no-history';
  if (args.restartError) return 'written-restart-failed';
  if (args.stopConfirmed === false) return 'written-stop-failed';
  if (args.rebased) return 'written-rebased';
  if (args.startedAfter === true) return 'written';
  if (args.restartAttempted && args.startedAfter === false) return 'written-stopped';
  if (args.restartAttempted) return 'written-reload-unconfirmed';
  return 'written';
}
