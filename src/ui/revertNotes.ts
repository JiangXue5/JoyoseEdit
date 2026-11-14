// What a rollback did *not* fully prove.
//
// A revert can succeed and still be weaker than "已回滚到备份" implies: the
// snapshot may predate the completeness marker (so nothing can say it is
// untouched), or the SELinux label could not be re-applied (so Joyose may not
// be able to open the file). Both cases used to be invisible — the result
// object carried the facts but no view read them.
//
// Kept out of the .vue files on purpose: two views offer the same button, and
// two copies of this list would drift.

export interface RevertFacts {
  /** Backup has no `COMPLETE` marker (taken by an older version). */
  legacy?: boolean;
  /** Per-database relabel outcome: applied / unsupported / failed / unverified. */
  label?: { smartp?: string; teg?: string };
}

export function revertNotes(r: RevertFacts): string[] {
  const out: string[] = [];
  if (r.legacy) {
    out.push('这份备份没有完整性记录（旧版本生成），无法确认内容自备份后未被改动');
  }
  const labels = [r.label?.smartp, r.label?.teg];
  if (labels.includes('failed')) {
    out.push('SELinux 标签未能恢复，Joyose 可能读不到配置，必要时重启手机');
  }
  return out;
}

/** Join notes onto a toast detail, so one toast carries both. */
export function withNotes(detail: string, notes: string[]): string {
  return notes.length ? `${detail}\n· ${notes.join('\n· ')}` : detail;
}
