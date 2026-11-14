#!/system/bin/sh
# JoyoseEdit privileged helper.
# Called from the KernelSU WebUI via ksu.exec. Positional-arg whitelist only —
# never interpolate user-supplied strings as shell code.
#
# Subcommands:
#   stat                           prints schema/version fingerprints as JSON
#   digest                         prints sha256 of both DBs (conflict detection)
#   install-ts                     timestamp of the last fresh install ("" when none)
#   prefs-read                     print the user's WebUI settings as JSON
#   prefs-write <b64>              replace the settings file (base64 JSON, atomic)
#   save-dl-from-stage <name> <st> decode a staged blob into /sdcard/Download/joyose-edit/<name>
#   reset-cloud                    pm clear com.xiaomi.joyose + wake its cloud services
#                                  (DESTRUCTIVE: every Joyose setting is wiped)
#   pull smartp|teg                emits base64 of the DB file
#   push smartp|teg <b64>          decodes <b64> and writes back atomically
#   backup [label]                 snapshot both DBs into /data/adb/joyose-edit/backup/<epoch>[-label]/
#                                  (keeps only the newest 10 backup dirs)
#   revert <epoch-label>           restore a specific backup
#   revert-latest                  restore most recent backup
#   restart                        stop Joyose, then start it again so it re-reads the DBs
#   history-list                   list every history file (one JSON per line)
#   history-get <name>             print the contents of one history file
#   history-clear <keep>           keep N newest, remove the rest
#   (history write goes through history-save-from-stage; see staging section)
#   cat-wasm                       emit base64 of webroot/assets/sql-wasm.wasm
#                                  (workaround for WebView asset handlers that
#                                   refuse .wasm fetches)
#   vision-status                  report vendor FRC/SR flags
#   teg-status                     report teg SDK pref_local_max_version
#   teg-freeze                     pin teg SDK pref_local_max_version to Long.MAX_VALUE
#                                  (stops teg cloud pushes from overwriting teg_config.db)
#   teg-unfreeze                   reset teg SDK pref_local_max_version to 0
#                                  (re-enables teg cloud updates)
#
# The base64 arguments carry DB bytes / history JSON; the kernelsu WebUI
# bridge does not expose stdin, so payload goes through argv. ARG_MAX is the
# budget for the whole argument list, not for one argument: a single string is
# capped separately by MAX_ARG_STRLEN, 128 KB on Linux and Android. Base64 of
# the ~1 MB teg_config.db mirror on a K90 Pro Max sample is ~1.4 MB, so
# `push <b64>` fails with E2BIG before this script is even entered. Real
# payloads therefore go through the stage directory in 48 KB chunks
# (`stage-append` + `push-from-stage`); `push <b64>` is only usable for small
# databases typed by hand.

set -eu

DATA_ROOT=/data/adb/joyose-edit
STAGE_DIR="$DATA_ROOT/stage"
DB_DIR=/data/user/0/com.xiaomi.joyose/databases
SMARTP="$DB_DIR/SmartP.db"
TEG="$DB_DIR/teg_config.db"
PKG=com.xiaomi.joyose

# Set while Joyose is stopped by *us* and removed only once we have seen it come
# back. A write that never returns (front-end timeout, WebView closed, manager
# kills the shell) leaves the phone with Joyose down, and nothing on the device
# would otherwise know that this was our doing rather than the user's.
SERVICE_MARKER="$DATA_ROOT/.service-stopped"
# Fingerprint of the database pair the last boot snapshot was taken from.
BOOTSTRAP_STAMP="$DATA_ROOT/.bootstrap-version"

mkdir -p "$DATA_ROOT/backup" "$DATA_ROOT/history" "$STAGE_DIR"
chmod 700 "$DATA_ROOT" "$DATA_ROOT/backup" "$DATA_ROOT/history" "$STAGE_DIR"

# Errors go to stderr: callers capture stdout in $(...) all over this file
# (resolve_db, prune_backups), and a fatal message printed to stdout was being
# swallowed by command substitution — the user only saw "shell exit 1".
die() {
  # Optional second argument is a machine-readable service state that belongs
  # next to the error: `true` / `false` / `not-needed`. Without it the caller
  # could only see "write failed" and had no way to learn that Joyose was left
  # stopped.
  #
  # Optional third argument is a machine-readable reason code. The front end
  # branches on it (e.g. incomplete backup vs. integrity failure); matching on
  # the message text instead was one wording change away from breaking the UI.
  printf '{"ok":false%s%s,"error":%s}\n' \
    "${3:+,\"code\":\"$3\"}" \
    "${2:+,\"serviceRestore\":\"$2\"}" \
    "$(printf '%s' "$1" | _json_string)" >&2
  exit 1
}

# ---- helpers --------------------------------------------------------------
_json_string() {
  # stdin -> JSON string literal (quote + escape). Joins lines with \n but does
  # not append one: a single-line message used to come back as "text\n",
  # which the WebUI then showed or compared with a stray newline attached.
  #
  # C0 controls other than tab/CR/LF are dropped first. They are illegal
  # unescaped inside a JSON string, and an error message containing one (a
  # binary path, a truncated argv) used to produce a payload the front end
  # could not parse at all — the caller then saw a JSON syntax error instead
  # of the actual failure.
  tr -d '\000-\010\013\014\016-\037\177' | awk 'BEGIN{printf "\""} {
    if (NR > 1) printf "\\n";
    gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t");
    gsub(/\r/,"\\r"); printf "%s", $0
  } END{printf "\""}'
}

# ---- device-side write lock ----------------------------------------------
# Two taps in the WebUI, or a helper that outlives the 30 s front-end timeout,
# can otherwise interleave two writes: each pulls the same old DB, edits its
# own copy, and the second swap silently discards the first. Every mutating
# subcommand takes this lock; the second one waits or fails with the owner.
LOCK_DIR="$DATA_ROOT/lock"
LOCK_TTL=180
# How many 200 ms ticks a second writer waits before giving up (~20 s). Only a
# value from the environment changes it; tests use a small one so a contended
# lock fails in under a second instead of stalling the suite.
LOCK_WAIT_TICKS=${LOCK_WAIT_TICKS:-100}
# Filled by _acquire_lock, checked by _release_lock. Guards against removing a
# lock that a *different* process created with our pid number after we died.
MY_LOCK_TOKEN=''

# Field 22 of /proc/<pid>/stat: process start time in clock ticks since boot.
# comm (field 2) can contain spaces and parentheses, so cut to the last ')'.
_proc_start() {
  sed 's/^[^)]*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'
}

_new_token() {
  if [ -r /dev/urandom ]; then
    od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
  fi
}

# Read an owner file into one line. Deliberately `cat`, not `read < path`:
# `read` is a special builtin, and in dash a redirection error on a special
# builtin aborts the whole script. A release that lost the race with a waiter
# then took the shell with it (the 40-writer stress showed `cannot open ...
# lock.release.N/owner` and no further output).
_owner_line() {
  [ -f "$1" ] || return 1
  cat "$1" 2>/dev/null || return 1
}

# A lock is stale when its owner is *gone* — never merely because it is old.
# The previous version required `kill -0` AND `age < LOCK_TTL`, so a write that
# took longer than three minutes had its lock declared dead while still running,
# and a second writer could enter the critical section underneath it. Age is now
# only a fallback for the no-procfs / legacy-owner-file case.
_lock_owner_alive() {
  local pid ts start token now nowstart line
  line=$(_owner_line "$LOCK_DIR/owner") || return 1
  [ -n "$line" ] || return 1
  set -- $line
  pid=$1
  ts=$2
  start=$3
  token=$4
  [ -n "${pid:-}" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  case "${start:-}" in
    ''|*[!0-9]*) ;;                    # no start time recorded
    *)
      nowstart=$(_proc_start "$pid")
      if [ -n "$nowstart" ]; then
        # Same pid + same start time = the holder. A different start time means
        # the number was recycled and the real holder is gone.
        [ "$nowstart" = "$start" ] && return 0
        return 1
      fi
      ;;
  esac
  now=$(date +%s)
  [ $((now - ts)) -lt "$LOCK_TTL" ] || return 1
  return 0
}

# True when the lock is safe to take over.
#
# A directory whose owner cannot be read is ambiguous: it is either a crashed
# writer or a live one that won `mkdir` a moment ago and has not finished
# writing its owner yet. Stealing the second kind hands both writers the
# critical section at once — which the 20-writer test caught on a 2-core CI
# runner, because the old grace period only covered a *missing* owner file and
# `printf > owner` creates the file before it fills it.
#
# Two changes: the owner file is published by rename (so it is either absent or
# complete), and the grace period now applies whenever the owner is not
# provably alive — a crashed lock's directory is already older than the grace,
# so this only delays a takeover that was about to happen anyway.
LOCK_GRACE=${LOCK_GRACE:-2}

_lock_stale() {
  local mtime now
  [ -d "$LOCK_DIR" ] || return 1
  _lock_owner_alive && return 1
  # A stat that fails must not read as "infinitely old": that turned a lock
  # directory racing with its own removal into an instant steal.
  mtime=$(stat -c '%Y' "$LOCK_DIR" 2>/dev/null) || return 1
  [ -n "$mtime" ] || return 1
  now=$(date +%s)
  [ $((now - mtime)) -ge "$LOCK_GRACE" ] || return 1
  return 0
}

_acquire_lock() {
  local kind="$1" i=0 start ino ino_now owner_token owner_line owner_text
  # Build everything the owner line needs *before* the directory exists, and
  # write it with a builtin. Between `mkdir` and the owner landing there must be
  # no fork at all: on a loaded machine (CI, 2 cores, 20 writers) each fork cost
  # hundreds of milliseconds, the gap grew past the grace period, and a waiter
  # reclaimed a lock that was about to be held.
  start=$(_proc_start "$$")
  [ -n "$start" ] || start='-'
  MY_LOCK_TOKEN=$(_new_token)
  [ -n "$MY_LOCK_TOKEN" ] || MY_LOCK_TOKEN="$$-$(date +%s)"
  owner_text="$$ $(date +%s) $start $MY_LOCK_TOKEN $kind"
  while :; do
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
      if _lock_stale; then
        # Rename first: only one waiter can move a given inode, so two
        # processes that both judged the lock stale cannot both delete a
        # freshly created one. The loser simply loops and retries.
        if mv "$LOCK_DIR" "$LOCK_DIR.stale.$$" 2>/dev/null; then
          rm -rf "$LOCK_DIR.stale.$$" 2>/dev/null || true
        fi
        continue
      fi
      i=$((i + 1))
      if [ "$i" -ge "$LOCK_WAIT_TICKS" ]; then
        die "device is busy: another write is still running (pid $(awk '{print $1}' "$LOCK_DIR/owner" 2>/dev/null) · $(awk '{print $5}' "$LOCK_DIR/owner" 2>/dev/null))"
      fi
      sleep 0.2 2>/dev/null || sleep 1
    done
    # First command after winning the directory: no fork, no temp file.
    if ! printf '%s\n' "$owner_text" > "$LOCK_DIR/owner" 2>/dev/null; then
      i=$((i + 1))
      [ "$i" -lt "$LOCK_WAIT_TICKS" ] || die "device is busy: cannot publish the lock owner"
      continue
    fi
    # Now that the owner is visible, spending forks is safe. Confirm we are
    # still inside the directory we created: a waiter that judged us stale
    # moves it away, and a third process can put its own directory at the same
    # path. Nothing has been touched yet, so the honest response is to try
    # again — dying here turned a millisecond race into a failed write.
    ino=$(stat -c '%i' "$LOCK_DIR" 2>/dev/null || echo '')
    owner_line=$(_owner_line "$LOCK_DIR/owner") || owner_line=''
    # Unquoted on purpose: this splits the five fields into $1..$5.
    # shellcheck disable=SC2086
    if [ -n "$owner_line" ]; then set -- $owner_line; fi
    owner_token=${4:-}
    ino_now=$(stat -c '%i' "$LOCK_DIR" 2>/dev/null || echo '')
    if [ -z "$ino" ] || [ "$ino_now" != "$ino" ] || [ "$owner_token" != "$MY_LOCK_TOKEN" ]; then
      i=$((i + 1))
      [ "$i" -lt "$LOCK_WAIT_TICKS" ] || die "device is busy: the lock changed hands during initialisation"
      continue
    fi
    break
  done
  trap '_release_lock' EXIT
  trap '_release_lock; exit 130' INT TERM HUP
  # A write that was killed mid-swap left a record behind. Resolve it now, with
  # the lock held and before this command touches anything: building a new edit
  # on top of a half-applied pair is how a recoverable state becomes an
  # unrecoverable one.
  if ! _recover_pending_pair; then
    die "上一次双库写入被中断，且现有文件无法证明落在哪一半；回滚副本见 $PENDING_PAIR，请手动处理后重试" not-needed recovery-required
  fi
}

_release_lock() {
  local line pid token
  [ -d "$LOCK_DIR" ] || return 0
  line=$(_owner_line "$LOCK_DIR/owner") || return 0
  # Unquoted on purpose: splits the five fields into $1..$5.
  # shellcheck disable=SC2086
  if [ -n "$line" ]; then set -- $line; fi
  pid=${1:-}
  token=${4:-}
  # Pid alone is not identity: every subshell of one script shares `$$`, and an
  # unrelated process can inherit the number. Only the token says "this is the
  # lock I took".
  [ "$pid" = "$$" ] || return 0
  if [ -n "$token" ] && [ -n "$MY_LOCK_TOKEN" ] && [ "$token" != "$MY_LOCK_TOKEN" ]; then
    return 0
  fi
  # Remove the owner file first, then the (now empty) directory. The previous
  # version moved the whole directory aside and inspected it afterwards, which
  # could move a lock that a waiter had just created at the same path — the
  # waiter then died with "lost the device lock", or two writers ran at once.
  rm -f "$LOCK_DIR/owner" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  return 0
}

resolve_db() {
  case "$1" in
    smartp) printf '%s' "$SMARTP" ;;
    teg)    printf '%s' "$TEG" ;;
    *)      die "unknown db selector: $1" ;;
  esac
}

# Sanity-check a backup / history filename: restrict to a safe character set
# so user input can never escape the directory or the DB paths.
safe_name() {
  case "$1" in
    ''|*..*|*/*|*\\*|*\&*|*\|*|*\;*|*\`*|*\$*|*\(*|*\)*|*\<*|*\>*) return 1 ;;
    # Glob metacharacters: these names end up as `$STAGE_DIR/$name` and inside
    # `rm -f`, and a `*` there expands to every staged file.
    *'*'*|*'?'*|*'['*|*']'*) return 1 ;;
    # Control characters, including newline: they break both the JSON we print
    # back and the quoting around stage paths.
    *[[:cntrl:]]*) return 1 ;;
    *) return 0 ;;
  esac
}

# ---- process / file hand-off ----------------------------------------------
# Joyose keeps the parsed cloud config in memory *and* keeps the SQLite file
# handles open. Replacing a database underneath a live process is what makes
# an edit look like it "needs two game launches" to take effect:
#
#   mv new SmartP.db -> old inode stays open in Joyose
#   Joyose writes something in the next few ms -> creates SmartP.db-journal
#     for the *unlinked* old inode, but at the *same path*
#   next open sees a hot journal -> rolls the OLD pages back over our NEW file
#     -> the first launch reads the pre-edit config
#   the recovery consumed the journal -> the second launch sees the new file
#
# So: stop the process first, drop any stale journal/WAL sidecars (they belong
# to the file we just replaced), then write.

# True when the process is still around. Both probes are toybox built-ins on
# Android; if neither exists we must not claim the stop succeeded.
_pid_alive() {
  if command -v pidof >/dev/null 2>&1; then
    pidof "$PKG" >/dev/null 2>&1
    return $?
  fi
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$PKG" >/dev/null 2>&1
    return $?
  fi
  return 0
}

_stop_pkg() {
  if ! command -v am >/dev/null 2>&1; then
    printf 'false'
    return 0
  fi
  local i=0 was=''
  # Sampled before the stop, so the marker means "this was running and we took
  # it down". A phone where it was already stopped is not ours to start later.
  _pid_alive && was=1
  am force-stop "$PKG" >/dev/null 2>&1 || true
  while [ "$i" -lt 20 ]; do
    if ! _pid_alive; then
      if [ -n "$was" ]; then printf '%s\n' "$(date +%s 2>/dev/null || echo 0)" > "$SERVICE_MARKER" 2>/dev/null || true; fi
      printf 'true'
      return 0
    fi
    sleep 0.1 2>/dev/null || sleep 1
    i=$((i + 1))
  done
  printf 'false'
}

# Joyose only reads the DBs when it starts. Leaving it stopped after a write
# meant the first game launch paid for the cold start: the game-side booster
# asked for a config before Joyose had loaded ours, so the edit only showed up
# on the second launch. Starting it here moves that load in front of the user.
# `.MainActivity` is what the other Joyose editors use; if the ROM has no such
# entry `am start` fails quietly and we are back to the old behaviour.
_start_pkg() {
  if ! command -v am >/dev/null 2>&1; then
    printf 'false'
    return 0
  fi
  am start --user 0 -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 30 ]; do
    if _pid_alive; then
      rm -f "$SERVICE_MARKER" 2>/dev/null || true
      printf 'true'
      return 0
    fi
    sleep 0.1 2>/dev/null || sleep 1
    i=$((i + 1))
  done
  printf 'false'
}

# Stopping Joyose is the only thing we do to the phone's runtime state, and it
# is invisible until the user notices the game has no cloud config. Every path
# that gives up after a successful stop must put the service back; $1 records
# whether it was running before we touched it, so a phone where Joyose was
# already stopped is not started by us.
_abort_after_stop() {
  local started restore='not-needed'
  if [ "${1:-false}" = "true" ]; then
    started=$(_start_pkg 2>/dev/null)
    if [ "$started" = "true" ]; then restore='true'; else restore='false'; fi
  fi
  if [ "$restore" = "false" ]; then
    # Swallowing this used to mean the user was told only "write failed" while
    # Joyose stayed down until the next game launch — and nothing said so.
    die "${2:-write aborted}；Joyose 原本在运行，但这次没能重新启动，进游戏前请手动打开一次" "$restore" "${3:-}"
  fi
  die "${2:-write aborted}" "$restore" "${3:-}"
}

# sha256 of a file, or nothing when the ROM has no tool. Callers must treat an
# empty result as "unverified" and say so — never as "matches".
_sha256_file() {
  command -v sha256sum >/dev/null 2>&1 || return 0
  sha256sum "$1" 2>/dev/null | cut -d' ' -f1
}

# Give a staged replacement the live file's ownership and mode.
#
# A database that is byte-perfect but owned by root:root instead of Joyose's
# uid is not a usable database: the app opens it, fails the access check, and
# behaves as if the config were empty. `cp` does not carry this over — the
# staged file is created by us, as root. Restore never had this step; only the
# single-database install path did, and it hard-coded 660 rather than reading
# the original.
_apply_file_attrs() {
  local src="$1" dst="$2" uid gid mode
  uid=$(stat -c '%u' "$src" 2>/dev/null) || return 1
  gid=$(stat -c '%g' "$src" 2>/dev/null) || return 1
  [ -n "$uid" ] && [ -n "$gid" ] || return 1
  mode=$(stat -c '%a' "$src" 2>/dev/null)
  case "$mode" in ''|*[!0-7]*) mode=660 ;; esac
  chown "$uid:$gid" "$dst" 2>/dev/null || return 1
  chmod "$mode" "$dst" 2>/dev/null || return 1
  return 0
}

# SELinux context of a file, or nothing when the ROM cannot tell us. `ls -Z`
# is toybox; `stat -c %C` is coreutils. Neither is universal, which is why the
# caller has to distinguish "unlabelled" from "could not read".
_selinux_context() {
  local out
  if command -v ls >/dev/null 2>&1; then
    # `|| out=''` on both probes: this function runs inside a command
    # substitution of a script with `set -e`, and a `stat -c %C` that exits 1
    # (any ROM without SELinux) used to abort the caller *after* the databases
    # had already been swapped. The write had landed; the UI was told it failed.
    out=$(ls -Zd "$1" 2>/dev/null | awk 'NR==1{print $1}') || out=''
    case "${out:-}" in
      '') ;;
      *:*) printf '%s' "$out"; return 0 ;;
    esac
  fi
  if command -v stat >/dev/null 2>&1; then
    out=$(stat -c '%C' "$1" 2>/dev/null) || out=''
    case "${out:-}" in
      ''|'?') ;;
      *:*) printf '%s' "$out"; return 0 ;;
    esac
  fi
  return 0
}

# Re-label a file with the SELinux context its directory expects. Replacing a
# file creates a new inode, and on Android the label is part of how the app is
# allowed to open it — content correctness alone is not enough.
#
# Prints one of:
#   applied      restorecon ran and the file now carries a label
#   unsupported  no restorecon on this ROM
#   failed       restorecon ran and reported failure
#   unverified   restorecon succeeded but this ROM cannot read labels back
#
# Never fails the caller: on a ROM where restorecon is missing but the label is
# already correct (a plain `cp` into the same directory inherits it), aborting
# would turn a working write into a broken one. The caller reports the state
# instead — the old `restorecon ... || true` reported nothing at all, so a
# failed relabel was indistinguishable from a successful one.
_restore_label() {
  local target="$1" after
  command -v restorecon >/dev/null 2>&1 || { printf 'unsupported'; return 0; }
  if ! restorecon "$target" 2>/dev/null; then
    printf 'failed'
    return 0
  fi
  # restorecon can return 0 on a ROM whose policy does not cover this path, so
  # "it did not complain" is not evidence. Read the label back where possible.
  after=$(_selinux_context "$target")
  if [ -n "$after" ]; then
    printf 'applied'
  else
    printf 'unverified'
  fi
  return 0
}

# Sidecars are per-database-name, not per-inode: after a replace they still
# point at the bytes we just threw away.
_drop_sidecars() {
  rm -f "$1-journal" "$1-wal" "$1-shm" 2>/dev/null || true
}

# ---- WAL -------------------------------------------------------------------
# A `-wal` holds transactions SQLite has committed but not yet merged into the
# main file. Everything else here treats `<db>` as the whole database: `pull`
# reads it, `cmd_backup` copies it, `_drop_sidecars` deletes the `-wal` as part
# of a swap. That is correct for the rollback journal and wrong for WAL — the
# snapshot would be missing its newest commits and the swap would throw them
# away, both reported as success.
#
# One rule, applied everywhere below: before `<db>` is read or replaced as a
# whole, its `-wal` must be empty. sqlite3 can make that true — it copies the
# frames in and truncates the log — so a WAL device that has sqlite3 works like
# any other. A ROM without sqlite3 cannot merge them at all, and there the
# operation stops with `wal-unmerged` instead of handing out half a database.
#
# Ten sample databases under `tests/` all report `rollback`, so no known device
# takes this path. It is a guard rail, not a redesign.
_journal_mode() {
  local f="$1" b
  [ -f "$f" ] || { printf 'absent'; return 0; }
  # Bytes 18/19 of the header are the read/write format versions: 1 = rollback
  # journal, 2 = WAL. Read out of the file, so this needs neither sqlite3 nor
  # the database to be open.
  b=$(od -An -tu1 -j18 -N1 "$f" 2>/dev/null | tr -d ' \n') || b=''
  case "${b:-}" in
    1) printf 'rollback' ;;
    2) printf 'wal' ;;
    *) printf 'unknown' ;;
  esac
}

# Non-empty `-wal`. A zero-length one is what a clean checkpoint leaves behind
# and holds nothing to lose, so it does not count.
_wal_pending() {
  [ -s "$1-wal" ]
}

# Try to make the main file whole. Prints one of:
#   ok      nothing was pending
#   merged  the frames were copied in and the log truncated
#   no-tool this ROM has no sqlite3, so nothing here can merge them
#   busy    sqlite3 ran but the log is still not empty (a writer holds it open)
_wal_checkpoint() {
  local f="$1"
  _wal_pending "$f" || { printf 'ok'; return 0; }
  command -v sqlite3 >/dev/null 2>&1 || { printf 'no-tool'; return 0; }
  # TRUNCATE only truncates when no other connection is holding the log open,
  # and the exit status is not evidence of anything. Read the answer back from
  # the file instead: `_wal_pending` is the only thing that decides.
  sqlite3 "$f" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
  if _wal_pending "$f"; then printf 'busy'; else printf 'merged'; fi
}

# One sentence for every refusal, so the three call sites cannot drift apart
# into three different explanations of the same file.
_wal_reason() {
  local f="$1" why="$2" size
  size=$(stat -c '%s' "$1-wal" 2>/dev/null || echo '?')
  if [ "$why" = "busy" ]; then
    printf '数据库存在未合并的 WAL（%s，%s 字节），sqlite3 未能完成合并（Joyose 可能正持有该库）；继续会把已提交的记录丢掉' \
      "$(basename "$f")-wal" "$size"
  else
    printf '数据库存在未合并的 WAL（%s，%s 字节），本机没有可用的 sqlite3 可以合并它；继续会把已提交的记录丢掉' \
      "$(basename "$f")-wal" "$size"
  fi
}

# Decide whether a settled `-wal` makes a write unsafe. Prints the reason, or
# nothing when the write may go ahead.
#
#   $1 the live database   $2 the digest the caller read   $3 _wal_checkpoint's answer
#   $4 "true" when the new bytes were built by a client from an earlier read
#
# A merge means committed rows just moved into the file the client never saw.
# Its replacement was built before that, so applying it would roll those rows
# back — the same data loss the merge was meant to prevent, one step later.
# A restore is different: it does not depend on anything a client read, and
# merging first is what makes its rollback copy complete.
_wal_write_obstacle() {
  local f="$1" cur="$2" why="$3" from_client="${4:-true}" now
  case "$why" in
    ok) return 0 ;;
    merged)
      if [ "$from_client" != "true" ]; then return 0; fi
      if [ -z "$cur" ] || [ "$cur" = "none" ]; then
        printf '数据库存在未合并的 WAL（%s），已合并；但这次写入没有附带摘要，无法证明它基于合并后的内容' \
          "$(basename "$f")-wal"
        return 0
      fi
      now=$(_sha256_file "$f")
      if [ -z "$now" ] || [ "$now" != "$cur" ]; then
        printf '%s 在读取之后又有提交（原本在 -wal 里，现已合并）；拒绝用基于旧内容的副本覆盖它' \
          "$(basename "$f")"
      fi
      return 0 ;;
    *) _wal_reason "$f" "$why"; return 0 ;;
  esac
}

# Structural fallback for ROMs without sqlite3. A correct magic word is not
# enough: a truncated copy still starts with "SQLite format 3". Read the page
# geometry out of the 100-byte header and require the file to hold every page
# the header promises.
_db_geometry_ok() {
  local f="$1" size psize pcount hex
  size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
  [ "$size" -ge 512 ] || return 1
  head -c 16 "$f" | grep -qa 'SQLite format 3' || return 1
  # Page size: big-endian u16 at offset 16 (1 means 65536).
  hex=$(od -An -tx1 -j16 -N2 "$f" 2>/dev/null | tr -d ' \n')
  [ -n "$hex" ] || return 1
  psize=$((0x$hex))
  [ "$psize" -eq 1 ] && psize=65536
  case "$psize" in
    512|1024|2048|4096|8192|16384|32768|65536) ;;
    *) return 1 ;;
  esac
  # Page count: big-endian u32 at offset 28.
  hex=$(od -An -tx1 -j28 -N4 "$f" 2>/dev/null | tr -d ' \n')
  [ -n "$hex" ] || return 1
  pcount=$((0x$hex))
  [ "$pcount" -gt 0 ] || return 1
  # The header count can lag behind the physical file (freelist / hot journal),
  # so only reject files that are *shorter* than the pages they claim.
  [ "$size" -ge $((psize * pcount)) ] || return 1
  return 0
}

# Verify a database file and print the verification mode on stdout:
#   sqlite3   full PRAGMA quick_check
#   geometry  no sqlite3 on this ROM; header + page geometry only
#   failed    definitely not usable
# Never calls die(): callers decide whether a failure is fatal (pre-write) or
# needs a rollback (post-write).
_verify_db() {
  local f="$1" out
  if command -v sqlite3 >/dev/null 2>&1; then
    out=$(sqlite3 "$f" 'PRAGMA quick_check;' 2>/dev/null || printf 'error')
    [ "$out" = "ok" ] || { printf 'failed'; return 0; }
    sqlite3 "$f" 'SELECT count(*) FROM sqlite_master;' >/dev/null 2>&1 \
      || { printf 'failed'; return 0; }
    printf 'sqlite3'
    return 0
  fi
  if _db_geometry_ok "$f"; then printf 'geometry'; else printf 'failed'; fi
}

# The single database-replacement path. Both `push` (base64 argv) and
# `push-from-stage` (chunked upload) decode first and then land here, so the
# safety checks cannot drift apart between the two entry points.
#
# Order matters: validate the candidate *before* the live file is touched, keep
# a rollback copy across the swap, and restore it if the post-write check
# fails. Nothing here may delete the only good copy.
_install_db() {
  local target="$1" tmp="$2" expect_size="${3:-}" expect_sha="${4:-}" expect_current="${5:-}"
  local uid gid stopped chk size sha rollback cur now_sha was_running=false rb_mode='size' src_sha dst_sha
  local label vby live_checked why obstacle

  [ -f "$tmp" ] || die "staged database missing: $tmp"

  if [ -n "$expect_size" ]; then
    size=$(stat -c '%s' "$tmp" 2>/dev/null || echo 0)
    if [ "$size" != "$expect_size" ]; then
      rm -f "$tmp"
      die "staged database size mismatch ($size != $expect_size)"
    fi
  fi
  # "none" == the WebView has no crypto.subtle, so the caller could not
  # compute a digest. The size check above is then the only guard.
  if [ -n "$expect_sha" ] && [ "$expect_sha" != "none" ]; then
    sha=$(sha256sum "$tmp" 2>/dev/null | cut -d' ' -f1)
    if [ "$sha" != "$expect_sha" ]; then
      rm -f "$tmp"
      die "staged database checksum mismatch"
    fi
  fi

  # 1. candidate must be readable *before* it replaces anything
  chk=$(_verify_db "$tmp")
  if [ "$chk" = "failed" ]; then
    rm -f "$tmp"
    die "staged database failed integrity check"
  fi

  uid=$(stat -c '%u' "$target")
  gid=$(stat -c '%g' "$target")
  if ! _apply_file_attrs "$target" "$tmp"; then
    rm -f "$tmp"
    die "cannot carry the original ownership/mode onto the candidate; refusing to write"
  fi

  # 2. the consumer must be gone, not merely "am did not throw"
  if _pid_alive; then was_running=true; fi
  stopped=$(_stop_pkg)
  if [ "$stopped" != "true" ]; then
    rm -f "$tmp"
    # It is still running, so there is nothing to put back.
    die "Joyose is still running; refusing to replace $target"
  fi

  # 2b. Now that nothing holds the file: a pending `-wal` means the live
  # database is the main file *plus* that log, and everything below — the
  # digest comparison, the rollback copy, `_drop_sidecars` — looks at the main
  # file only. Merge it in first, or stop: swapping in bytes computed without
  # those rows drops them. This runs after the stop because a live connection
  # is exactly what keeps a checkpoint from truncating the log.
  why=$(_wal_checkpoint "$target")
  obstacle=$(_wal_write_obstacle "$target" "$expect_current" "$why" true)
  if [ -n "$obstacle" ]; then
    rm -f "$tmp"
    _abort_after_stop "$was_running" "$obstacle" wal-unmerged
  fi

  # TOCTOU guard: the caller read this file, built a new one, and is now
  # asking us to swap it in. If the live file changed in between (Joyose pulled
  # a fresh cloud config, or committed into the log we just merged), the new
  # bytes were computed on a stale base and applying them would silently roll
  # that update back.
  if [ -n "$expect_current" ] && [ "$expect_current" != "none" ]; then
    cur=$(sha256sum "$target" 2>/dev/null | cut -d' ' -f1)
    if [ "$cur" != "$expect_current" ]; then
      rm -f "$tmp"
      _abort_after_stop "$was_running" "database changed after it was read ($(printf '%s' "$cur" | cut -c1-12) != $(printf '%s' "$expect_current" | cut -c1-12)); refusing to overwrite"
    fi
  fi

  # From here on we already stopped Joyose: every exit must restore it.
  # 3. rollback copy of the live database
  rollback="$target.jedit.rollback.$$"
  src_sha=$(_sha256_file "$target")
  if ! cp -p "$target" "$rollback" 2>/dev/null; then
    rm -f "$tmp"
    _abort_after_stop "$was_running" "cannot create rollback copy for $target"
  fi
  if [ "$(stat -c '%s' "$rollback" 2>/dev/null || echo 0)" != "$(stat -c '%s' "$target" 2>/dev/null || echo 0)" ]; then
    rm -f "$tmp" "$rollback"
    _abort_after_stop "$was_running" "rollback copy is incomplete; refusing to write"
  fi
  # Size alone cannot tell a truncated page from a full one, nor a copy that
  # was written while the file changed. Compare the digest when the ROM has a
  # tool; when it does not, say so instead of implying the copy was verified.
  if [ -n "$src_sha" ]; then
    dst_sha=$(_sha256_file "$rollback")
    rb_mode='sha256'
    if [ "$src_sha" != "$dst_sha" ]; then
      rm -f "$tmp" "$rollback"
      _abort_after_stop "$was_running" "rollback copy does not match the original ($(printf '%s' "$src_sha" | cut -c1-12) != $(printf '%s' "${dst_sha:-?}" | cut -c1-12)); refusing to write"
    fi
  fi

  # 4. atomic swap
  _drop_sidecars "$target"
  if ! mv -f "$tmp" "$target" 2>/dev/null; then
    # Did the live file actually move? If its bytes are still the ones we
    # copied, the swap never happened and the rollback copy is just clutter —
    # leaving it behind would accumulate one per failed write.
    now_sha=$(_sha256_file "$target")
    if [ -n "$src_sha" ] && [ "$now_sha" = "$src_sha" ]; then
      rm -f "$tmp" "$rollback"
    else
      mv -f "$rollback" "$target" 2>/dev/null || true
    fi
    _abort_after_stop "$was_running" "cannot replace $target; original kept"
  fi
  _drop_sidecars "$target"

  # 5. post-write check; on failure put the original back
  chk=$(_verify_db "$target")
  if [ "$chk" = "failed" ]; then
    if mv -f "$rollback" "$target" 2>/dev/null; then
      _drop_sidecars "$target"
      _abort_after_stop "$was_running" "post-write integrity check failed; original database restored"
    fi
    _abort_after_stop "$was_running" "post-write integrity check failed and rollback failed: $rollback kept"
  fi

  rm -f "$rollback"
  label=$(_restore_label "$target")
  # Digest of the bytes that actually landed. The WebUI stores it in the
  # history record so a later rollback can tell "this database is still the one
  # my delta was computed against" from "somebody replaced it since".
  dst_sha=$(_sha256_file "$target")
  # How strong the two guards actually were. "checked" used to be implied by
  # the absence of an error, which read as "sha256-verified" even when the
  # WebView had no crypto.subtle and the only check was a byte count.
  vby='none'
  if [ -n "$expect_size" ]; then vby='length'; fi
  if [ -n "$expect_sha" ] && [ "$expect_sha" != "none" ]; then vby='sha256'; fi
  live_checked=false
  if [ -n "$expect_current" ] && [ "$expect_current" != "none" ]; then live_checked=true; fi
  # `stopped` means "we confirmed the process is gone before swapping"; it is
  # not the final state. `wasRunning` records whether it was up beforehand, so
  # the caller can tell "still running" from "was never running". The restart
  # result comes from cmd_restart, not from here.
  printf '{"ok":true,"path":"%s","uid":%s,"gid":%s,"stopConfirmed":true,"wasRunning":%s,"verified":"%s","rollback":"%s","sha256":"%s","verifiedBy":"%s","liveChecked":%s,"labelRestored":"%s"}\n' \
    "$target" "$uid" "$gid" "$was_running" "$chk" "$rb_mode" "$dst_sha" "$vby" "$live_checked" "$label"
}


stat_one() {
  local f="$1" key="$2"
  if [ -f "$f" ]; then
    local mtime size uid gid pending=false wb=0
    mtime=$(stat -c '%Y' "$f" 2>/dev/null || echo 0)
    size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
    uid=$(stat -c '%u' "$f" 2>/dev/null || echo 0)
    gid=$(stat -c '%g' "$f" 2>/dev/null || echo 0)
    # A pending `-wal` means the file on disk is not the whole database, and
    # the UI should say so rather than show a size and a date as if it were.
    if _wal_pending "$f"; then pending=true; fi
    wb=$(stat -c '%s' "$f-wal" 2>/dev/null || echo 0)
    printf '"%s":{"exists":true,"path":"%s","mtime":%s,"size":%s,"uid":%s,"gid":%s,"journal":"%s","wal_pending":%s,"wal_bytes":%s}' \
      "$key" "$f" "$mtime" "$size" "$uid" "$gid" "$(_journal_mode "$f")" "$pending" "$wb"
  else
    printf '"%s":{"exists":false,"path":"%s"}' "$key" "$f"
  fi
}

# ---- subcommands ----------------------------------------------------------
cmd_stat() {
  printf '{"ok":true,'
  printf '"pkg":"%s",' "$PKG"
  printf '"data_root":"%s",' "$DATA_ROOT"
  stat_one "$SMARTP" smartp
  printf ','
  stat_one "$TEG" teg
  printf ',"backup_count":%s' "$(ls "$DATA_ROOT/backup" 2>/dev/null | wc -l | tr -d ' \n')"
  printf ',"history_count":%s' "$(ls "$DATA_ROOT/history" 2>/dev/null | wc -l | tr -d ' \n')"
  # A leftover transaction record means the last pair write was interrupted and
  # nothing has touched the databases since. `recovery` is the last time one was
  # resolved automatically — the UI shows it once, keyed by the timestamp, so an
  # auto-repair never goes unmentioned but also never repeats.
  if [ -f "$PENDING_PAIR" ]; then printf ',"pending":true'; else printf ',"pending":false'; fi
  # `service_stopped` means a write took Joyose down and nothing has brought it
  # back: the WebUI restarts it, because the phone would otherwise run without
  # a cloud config until the user opens the app by hand. It is not "is Joyose
  # running now" — that needs a probe this command does not do — it is "we owe
  # the user a start".
  if [ -f "$SERVICE_MARKER" ]; then printf ',"service_stopped":true'; else printf ',"service_stopped":false'; fi
  if [ -f "$RECOVERY_NOTE" ]; then
    printf ',"recovery":{"kind":"%s","at":%s}' \
      "$(awk 'NR==1{print $2}' "$RECOVERY_NOTE" 2>/dev/null)" \
      "$(awk 'NR==1{print $1}' "$RECOVERY_NOTE" 2>/dev/null || echo 0)"
  else
    printf ',"recovery":null'
  fi
  printf '}\n'
}

cmd_pull() {
  local target why
  target=$(resolve_db "$1")
  [ -f "$target" ] || die "missing: $target"
  # Serving the main file alone would hand the WebView a database without its
  # newest commits — and every write computed from it would then drop them.
  if _wal_pending "$target"; then
    why=$(_wal_checkpoint "$target")
    case "$why" in
      ok|merged) ;;
      *) die "$(_wal_reason "$target" "$why")" not-needed wal-unmerged ;;
    esac
  fi
  # base64 -w0 — single line so the WebUI can slurp it directly.
  base64 -w0 "$target"
  echo
}

# Content digest of both DBs. mtime has one-second resolution and size barely
# moves when a JSON blob is edited in place, so "mtime#size" cannot tell two
# edits apart — two commits in the same second, or a cloud push that rewrote
# an equally long payload, both slipped past the conflict check.
cmd_digest() {
  local key f d
  printf '{"ok":true'
  for key in smartp teg; do
    f=$(resolve_db "$key")
    if [ -f "$f" ]; then
      d=$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)
      printf ',"%s":"%s"' "$key" "${d:-}"
    else
      printf ',"%s":null' "$key"
    fi
  done
  printf '}\n'
}

# Single tail for both write entry points. `cmd_push` (one base64 argv) and
# `cmd_push_from_stage` (chunked upload) differ only in where the base64 comes
# from; everything after decoding — SQLite sanity check, size/digest guards,
# TOCTOU guard, rollback copy, post-write check — must be identical or one
# entry point silently becomes the weak one.
_finish_staged_write() {
  local target="$1" tmp="$2" expect_size="${3:-}" expect_sha="${4:-}" expect_current="${5:-}"
  [ -s "$tmp" ] || { rm -f "$tmp"; die "decoded database is empty"; }
  head -c 16 "$tmp" | grep -qa 'SQLite format 3' || { rm -f "$tmp"; die "not a sqlite db"; }
  _install_db "$target" "$tmp" "$expect_size" "$expect_sha" "$expect_current"
}

# Validate a staged database against the numbers the WebUI sent and against the
# live file it is about to replace. The single-database path has these checks
# inline; the pair path needs the same guards for both files, and duplicating
# them was how the two paths drifted apart before.
_check_staged_db() {
  local file="$1" size="$2" sha="$3" live="$4" cur="$5" label="$6" chk
  [ -f "$file" ] || die "staged $label missing: $file"
  if [ -n "$size" ]; then
    [ "$(stat -c '%s' "$file" 2>/dev/null || echo 0)" = "$size" ] \
      || { rm -f "$file"; die "staged $label size mismatch"; }
  fi
  if [ -n "$sha" ] && [ "$sha" != "none" ]; then
    [ "$(_sha256_file "$file")" = "$sha" ] \
      || { rm -f "$file"; die "staged $label checksum mismatch"; }
  fi
  # A pending `-wal` is settled in _restore_pair, after the stop — a live
  # connection is what keeps a checkpoint from truncating the log. This
  # comparison is the early one; the same digest is checked again once the log
  # is merged, where a merge that moved rows shows up as a mismatch.
  if [ -n "$cur" ] && [ "$cur" != "none" ]; then
    [ "$(_sha256_file "$live")" = "$cur" ] \
      || { rm -f "$file"; die "$label changed after it was read; refusing to overwrite"; }
  fi
  chk=$(_verify_db "$file")
  [ "$chk" != "failed" ] || { rm -f "$file"; die "staged $label failed integrity check"; }
}

# Replace BOTH databases as one transaction.
#
# `pushCore` used to call bridge.push twice. SmartP landing and teg failing left
# the phone with a config combination that never existed, while the UI said
# "提交失败" — so the user retried a write that was already half applied.
# The staging, stopping, rollback copies and post-checks are the same ones the
# file-level restore uses: `_restore_pair` already implements "both or neither"
# and is covered by the failure-injection tests, so this path reuses it instead
# of growing a second implementation.
cmd_push_pair_from_stage() {
  local sp_stage="$1" teg_stage="$2" sp_size="$3" sp_sha="$4" sp_cur="$5"
  local teg_size="$6" teg_sha="$7" teg_cur="$8"
  local dir="$STAGE_DIR/pair.$$" sp teg vby
  safe_name "$sp_stage" || die "invalid stage name"
  safe_name "$teg_stage" || die "invalid stage name"
  sp="$dir/SmartP.db"
  teg="$dir/teg_config.db"
  mkdir "$dir" 2>/dev/null || { rm -rf "$dir"; die "cannot create pair staging directory"; }
  base64 -d < "$STAGE_DIR/$sp_stage" > "$sp" 2>/dev/null || { rm -rf "$dir"; die "SmartP base64 decode failed"; }
  base64 -d < "$STAGE_DIR/$teg_stage" > "$teg" 2>/dev/null || { rm -rf "$dir"; die "teg base64 decode failed"; }

  _check_staged_db "$sp" "$sp_size" "$sp_sha" "$SMARTP" "$sp_cur" "SmartP.db"
  _check_staged_db "$teg" "$teg_size" "$teg_sha" "$TEG" "$teg_cur" "teg_config.db"

  _RESTORE_WAS_RUNNING=false
  _RESTORE_SKIPPED=''
  _RESTORE_LABEL_SP=''
  _RESTORE_LABEL_TEG=''
  # Exits on failure, having put both databases back. On success both live
  # files now hold the new bytes and Joyose is stopped. The digests go along so
  # a `-wal` merged after the stop can be compared against what was read.
  _restore_pair "$dir" "$sp_cur" "$teg_cur" true

  # What the two uploads were actually checked against. "sha256" only when both
  # sides carried a digest; otherwise the write was guarded by length alone and
  # the caller has to say so.
  vby='length'
  if [ -n "$sp_sha" ] && [ "$sp_sha" != "none" ] && [ -n "$teg_sha" ] && [ "$teg_sha" != "none" ]; then
    vby='sha256'
  fi
  rm -rf "$dir" 2>/dev/null || true
  rm -f "$STAGE_DIR/$sp_stage" "$STAGE_DIR/$teg_stage" 2>/dev/null || true
  printf '{"ok":true,"stopConfirmed":true,"wasRunning":%s,"verified":"pair","atomic":true,"verifiedBy":"%s","label":{"smartp":"%s","teg":"%s"}}\n' \
    "$_RESTORE_WAS_RUNNING" "$vby" "${_RESTORE_LABEL_SP:-}" "${_RESTORE_LABEL_TEG:-}"
}

# Fingerprint of the database pair: a snapshot is only worth taking when one of
# them changed. SmartP alone missed the boot where only teg moved.
# "Is this the pair we last snapshotted?" — answered from the bytes, not from
# the file's metadata. `%Y#%s#%i` was the whole answer before, and it happens to
# be stable across an in-place rewrite of the same length inside the same second
# (the common shape of a Joyose write, which edits a JSON blob in place), so the
# boot snapshot could be skipped for a database that had in fact changed.
#
# Prefixing the mode keeps the two evidence levels apart: a phone that gains or
# loses `sha256sum` between boots re-snapshots once instead of comparing a hash
# against a stat line and concluding "unchanged".
_db_pair_fingerprint() {
  local out='' f sha
  for f in "$SMARTP" "$TEG"; do
    if [ ! -f "$f" ]; then
      out="$out-;"
      continue
    fi
    sha=$(_sha256_file "$f")
    if [ -n "$sha" ]; then
      out="$out sha256:$sha;"
    else
        out="$out stat:$(stat -c '%Y#%s#%i' "$f" 2>/dev/null || echo -);"
    fi
    # A `-wal` that has grown holds commits the main file does not, and hashing
    # the main file alone says "unchanged" while the contents moved. Only
    # appended when something is pending, so devices without one keep the exact
    # stamp they already have and take no extra snapshot on upgrade.
    if _wal_pending "$f"; then
      out="$out wal:$(stat -c '%s' "$f-wal" 2>/dev/null || echo 0);"
    fi
  done
  # Components are glued with a leading space each, so the whole string used to
  # start with one — and that string is written verbatim into the stamp file.
  # Anything reading that file line by line got a value with a stray space in
  # front of the first digest.
  printf '%s' "${out# }"
}

# Boot-time baseline snapshot, called by service.sh once the owner's CE storage
# is up. It used to be a bare `cp` in service.sh: no lock, so it could copy a
# database while a commit was halfway through replacing it, and no integrity
# check beyond a size comparison, so a torn copy passed as a "known good
# baseline". This runs the same snapshot a manual backup takes — exclusive
# directory, quiesced consumer, integrity check, COMPLETE marker — under the
# device lock, so the two can never overlap.
cmd_bootstrap_backup() {
  local fp last
  if [ ! -f "$SMARTP" ] && [ ! -f "$TEG" ]; then
    printf '{"ok":true,"skipped":"no-databases"}\n'
    return 0
  fi
  fp=$(_db_pair_fingerprint)
  last=$(cat "$BOOTSTRAP_STAMP" 2>/dev/null || true)
  # Stamps written before the leading space was taken out still compare equal.
  # Without this every installed device would owe one more snapshot on the
  # first boot after the upgrade — a backup nobody changed anything for.
  last=${last# }
  if [ -n "$fp" ] && [ "$fp" = "$last" ]; then
    printf '{"ok":true,"skipped":"unchanged"}\n'
    return 0
  fi
  # `cmd_backup` exits on any failure, having removed its half-written
  # directory, so reaching the next line means the snapshot is complete and
  # marked. The stamp is written last for the same reason: a boot that failed
  # must be retried, not remembered as done.
  cmd_backup --no-restore initial
  printf '%s\n' "$fp" > "$BOOTSTRAP_STAMP" 2>/dev/null || true
}

cmd_push() {
  local sel="$1" b64="$2"
  local expect_size="${3:-}" expect_sha="${4:-}" expect_current="${5:-}"
  local target tmp
  [ -n "$b64" ] || die "push: missing base64 payload"
  target=$(resolve_db "$sel")
  [ -f "$target" ] || die "missing: $target"
  tmp="$target.jedit.$$"
  # decode directly into the sibling tmp, then rename atomically.
  printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "base64 decode failed"; }
  _finish_staged_write "$target" "$tmp" "$expect_size" "$expect_sha" "$expect_current"
}

# ---- backup completeness ---------------------------------------------------
# A directory under backup/ is not evidence that the snapshot finished. Kill the
# process between the two `cp` calls and the leftover directory looks exactly
# like a backup of a device that only had one database — so a later revert
# restores half the pair and calls it success. The marker is written last and
# records both digests; a restore refuses a directory it cannot account for.
#
# Plain `key=value` lines instead of JSON: this file is read by shell, and the
# device-side JSON parser would be a grep pretending to be a parser.
BACKUP_MARKER=COMPLETE

_write_backup_marker() {
  local dir="$1"
  local t f sha size
  t="$dir/$BACKUP_MARKER.$$"
  {
    printf 'schema=1\n'
    printf 'created=%s\n' "$(date +%s)"
    for f in SmartP teg_config; do
      if [ -f "$dir/$f.db" ]; then
        sha=$(_sha256_file "$dir/$f.db")
        size=$(stat -c '%s' "$dir/$f.db" 2>/dev/null || echo 0)
      else
        sha=''
        size=''
      fi
      printf '%s_sha=%s\n' "$f" "$sha"
      printf '%s_size=%s\n' "$f" "$size"
    done
  } > "$t" 2>/dev/null || { rm -f "$t"; return 1; }
  # rename: a truncated marker must not look like a finished snapshot
  mv -f "$t" "$dir/$BACKUP_MARKER" 2>/dev/null || { rm -f "$t"; return 1; }
  return 0
}

# Read one key from a marker file.
_marker_get() {
  local file="$1" key="$2" line k v
  [ -f "$file" ] || return 0
  while IFS= read -r line; do
    k=${line%%=*}
    if [ "$k" = "$key" ]; then
      v=${line#*=}
      printf '%s' "$v"
      return 0
    fi
  done < "$file"
  return 0
}

# Confirm the files in a backup still match what was recorded when it was
# taken. Prints "ok", "no-marker" or "mismatch:<file>".
_verify_backup_marker() {
  local dir="$1"
  local marker f want_sha want_size got_sha got_size
  marker="$dir/$BACKUP_MARKER"
  [ -f "$marker" ] || { printf 'no-marker'; return 0; }
  for f in SmartP teg_config; do
    [ -f "$dir/$f.db" ] || continue
    want_sha=$(_marker_get "$marker" "${f}_sha")
    want_size=$(_marker_get "$marker" "${f}_size")
    got_size=$(stat -c '%s' "$dir/$f.db" 2>/dev/null || echo -1)
    if [ -n "$want_sha" ]; then
      got_sha=$(_sha256_file "$dir/$f.db")
      if [ "$got_sha" != "$want_sha" ]; then printf 'mismatch:%s.db' "$f"; return 0; fi
    elif [ -n "$want_size" ] && [ "$got_size" != "$want_size" ]; then
      # No digest on this ROM at snapshot time: size is the only claim the
      # marker can make, and it still has to hold.
      printf 'mismatch:%s.db' "$f"
      return 0
    fi
  done
  printf 'ok'
}

cmd_backup() {
  local label="" restore="restore" arg stamp base dir n stopped chk was started f why
  for arg in "$@"; do
    case "$arg" in
      --no-restore) restore="no-restore" ;;
      *) label="$arg" ;;
    esac
  done
  stamp=$(date +%s)
  if [ -n "$label" ]; then
    safe_name "$label" || die "invalid label"
    base="$DATA_ROOT/backup/${stamp}-${label}"
  else
    base="$DATA_ROOT/backup/${stamp}"
  fi
  # Exclusive create. `mkdir -p` silently reused an existing directory, so two
  # backups in the same second with the same label shared one path — and the
  # failure paths below `rm -rf` that path, deleting the older copy. A numeric
  # suffix keeps both, and this process only ever removes a directory it
  # created itself.
  dir="$base"
  n=0
  while ! mkdir "$dir" 2>/dev/null; do
    [ -d "$dir" ] || die "cannot create backup directory: $dir"
    n=$((n + 1))
    [ "$n" -le 100 ] || die "cannot find a free backup name under $base"
    dir="$base-$n"
  done
  chmod 700 "$dir"
  # Remember whether Joyose was up before we quiesce it: a manual backup must
  # not leave the phone with the game service stopped until the next launch.
  was=false
  if _pid_alive; then was=true; fi
  # A file-level copy of a database that a live process is writing can capture
  # a page or a rollback journal mid-transaction, which turns into a corrupt
  # (or silently rolled-back) restore later. Quiesce first — pushAll calls
  # backup immediately before it writes, so this costs nothing there.
  stopped=$(_stop_pkg)
  if [ "$stopped" != "true" ]; then
    rm -rf "$dir"
    die "Joyose is still running; refusing to snapshot an open database"
  fi
  # Past this line the service is stopped: every failure has to restart it.
  # `cp` inside an `&&` list used to fail silently under `set -e`, which both
  # hid the reason and skipped the restart.
  local copied=0
  # Quiesced, so a checkpoint can complete. A snapshot of the main file alone
  # while a `-wal` still holds committed transactions would be marked COMPLETE
  # and restore short — the one failure this whole command exists to prevent.
  for f in "$SMARTP" "$TEG"; do
    [ -f "$f" ] || continue
    why=$(_wal_checkpoint "$f")
    case "$why" in
      ok|merged) ;;
      *)
        rm -rf "$dir"
        _abort_after_stop "$was" "$(_wal_reason "$f" "$why")" wal-unmerged
        ;;
    esac
  done
  if [ -f "$SMARTP" ]; then
    if ! cp -f "$SMARTP" "$dir/SmartP.db" 2>/dev/null; then
      rm -rf "$dir"
      _abort_after_stop "$was" "cannot copy SmartP into the backup (disk full or permission denied)"
    fi
    copied=$((copied + 1))
  fi
  if [ -f "$TEG" ]; then
    if ! cp -f "$TEG" "$dir/teg_config.db" 2>/dev/null; then
      rm -rf "$dir"
      _abort_after_stop "$was" "cannot copy teg into the backup (disk full or permission denied)"
    fi
    copied=$((copied + 1))
  fi
  if [ "$copied" -eq 0 ]; then
    rm -rf "$dir"
    _abort_after_stop "$was" "no database found to back up"
  fi
  for f in "$dir/SmartP.db" "$dir/teg_config.db"; do
    [ -f "$f" ] || continue
    chk=$(_verify_db "$f")
    if [ "$chk" = "failed" ]; then
      rm -rf "$dir"
      _abort_after_stop "$was" "backup snapshot failed integrity check ($(basename "$f"))"
    fi
  done
  # Last step that can fail: everything is on disk and verified, so the
  # directory may now claim to be a complete snapshot.
  if ! _write_backup_marker "$dir"; then
    rm -rf "$dir"
    _abort_after_stop "$was" "cannot record the backup manifest; snapshot discarded"
  fi
  prune_backups 10
  # A commit takes its backup immediately before writing, and the write path
  # restarts Joyose itself — starting it here would only add a cold start to
  # every commit. Manual backups restore the previous state by default.
  started=false
  if [ "$restore" != "no-restore" ] && [ "$was" = "true" ]; then
    started=$(_start_pkg)
  fi
  printf '{"ok":true,"dir":"%s","name":"%s","stopped":%s,"wasRunning":%s,"restarted":%s,"kept":10}\n' \
    "$dir" "$(basename "$dir")" "$stopped" "$was" "$started"
}

# Keep only the newest N backup directories (default 10). Covers every backup
# (initial-*, labelled, plain epoch) so the count cannot creep up over months.
# The pipe-based loop works on Android's mksh/dash, where `read` in the parent
# shell of a pipeline would not persist.
prune_backups() {
  local keep="${1:-10}" i=0 d
  case "$keep" in ''|*[!0-9]*) keep=10 ;; esac
  ls -dt "$DATA_ROOT/backup"/*/ 2>/dev/null | while IFS= read -r d; do
    i=$((i+1))
    if [ "$i" -gt "$keep" ]; then rm -rf "$d"; fi
  done
}

# ---- crash recovery for the two-database swap ------------------------------
# Two renames cannot be atomic: the phone can lose power between them, and
# afterwards nothing on disk says which half landed. This is the smallest thing
# that closes that window: before the first rename, record what is about to
# happen; after the second database verifies, delete the record. Every mutating
# subcommand looks for a leftover record before it does anything else and
# finishes the job the dead process started.
#
# Deliberately not a state machine. The swap is milliseconds long and the file
# digests are the only state that matters; a seven-state log would add states
# that nothing can distinguish from the outside. A record that the digests
# cannot resolve is left in place and blocks further writes — after an
# interrupted swap, guessing is worse than stopping.
PENDING_PAIR="$DATA_ROOT/.pending-pair"
RECOVERY_NOTE="$DATA_ROOT/.pending-pair.note"

# $1 sp_rb  $2 teg_rb  $3 sp_old  $4 teg_old  $5 sp_new  $6 teg_new
# $7 sp_old_size $8 teg_old_size $9 sp_new_size  ${10} teg_new_size
# ${11} sp_used ${12} teg_used ${13} was_running
_pending_write() {
  local tmp="$PENDING_PAIR.$$"
  {
    printf 'created=%s\n' "$(date +%s)"
    printf 'sp_rb=%s\n' "$1"
    printf 'teg_rb=%s\n' "$2"
    printf 'sp_old=%s\n' "$3"
    printf 'teg_old=%s\n' "$4"
    printf 'sp_new=%s\n' "$5"
    printf 'teg_new=%s\n' "$6"
    printf 'sp_old_size=%s\n' "$7"
    printf 'teg_old_size=%s\n' "$8"
    printf 'sp_new_size=%s\n' "$9"
    printf 'teg_new_size=%s\n' "${10}"
    printf 'sp_used=%s\n' "${11}"
    printf 'teg_used=%s\n' "${12}"
    printf 'was_running=%s\n' "${13}"
  } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  # rename, so a half-written record can never be mistaken for a real one
  mv -f "$tmp" "$PENDING_PAIR" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}

_pending_clear() {
  rm -f "$PENDING_PAIR" 2>/dev/null || true
}

# One line: "<epoch> <kind>". cmd_stat reads it so the UI can say that a
# previous operation was interrupted and what happened to it.
_pending_note() {
  printf '%s %s\n' "$(date +%s)" "$1" > "$RECOVERY_NOTE" 2>/dev/null || true
}

# Where is this database relative to the transaction that was in flight?
#   old | new | missing | other | ambiguous
# Digests when the ROM has sha256sum, sizes otherwise: a size match is weak
# evidence, so it is only trusted when there is nothing better.
#
# `ambiguous` is the size-only case where the old and new files are the same
# length: both comparisons below would pass, and the first one used to win,
# silently reporting "new" for a file that still holds the old bytes. That is
# how an interrupted pair swap (SmartP new, teg old) could be declared
# committed and have its rollback copies deleted — see _recover_pending_pair.
_pair_state() {
  local f="$1" old="$2" new="$3" old_size="$4" new_size="$5" now size
  [ -f "$f" ] || { printf 'missing'; return 0; }
  now=$(_sha256_file "$f")
  if [ -n "$now" ] && [ -n "$old" ] && [ -n "$new" ]; then
    if [ "$now" = "$new" ]; then printf 'new'; return 0; fi
    if [ "$now" = "$old" ]; then printf 'old'; return 0; fi
    printf 'other'
    return 0
  fi
  size=$(stat -c '%s' "$f" 2>/dev/null || echo -1)
  if [ -n "$old_size" ] && [ -n "$new_size" ] && [ "$old_size" = "$new_size" ] \
     && [ "$size" = "$new_size" ]; then
    printf 'ambiguous'
    return 0
  fi
  if [ -n "$new_size" ] && [ "$size" = "$new_size" ]; then printf 'new'; return 0; fi
  if [ -n "$old_size" ] && [ "$size" = "$old_size" ]; then printf 'old'; return 0; fi
  printf 'other'
}

# Resolve a leftover record. Returns 0 when there is nothing left to do (or the
# record was resolved), 1 when the state cannot be decided from the evidence —
# the caller must refuse to write rather than build on a half-applied pair.
_recover_pending_pair() {
  [ -f "$PENDING_PAIR" ] || return 0
  local sp_rb='' teg_rb='' sp_old='' teg_old='' sp_new='' teg_new=''
  local sp_old_size='' teg_old_size='' sp_new_size='' teg_new_size=''
  local sp_used=true teg_used=true was='false'
  local k v line sp_state teg_state left

  while IFS= read -r line; do
    k=${line%%=*}
    v=${line#*=}
    case "$k" in
      sp_rb) sp_rb=$v ;;
      teg_rb) teg_rb=$v ;;
      sp_old) sp_old=$v ;;
      teg_old) teg_old=$v ;;
      sp_new) sp_new=$v ;;
      teg_new) teg_new=$v ;;
      sp_old_size) sp_old_size=$v ;;
      teg_old_size) teg_old_size=$v ;;
      sp_new_size) sp_new_size=$v ;;
      teg_new_size) teg_new_size=$v ;;
      sp_used) sp_used=$v ;;
      teg_used) teg_used=$v ;;
      was_running) was=$v ;;
    esac
  done < "$PENDING_PAIR"

  sp_state='skip'
  teg_state='skip'
  if [ "$sp_used" = "true" ]; then
    sp_state=$(_pair_state "$SMARTP" "$sp_old" "$sp_new" "$sp_old_size" "$sp_new_size")
  fi
  if [ "$teg_used" = "true" ]; then
    teg_state=$(_pair_state "$TEG" "$teg_old" "$teg_new" "$teg_old_size" "$teg_new_size")
  fi
  # A file that vanished, that matches neither side, or whose old and new
  # lengths are identical (so size cannot tell them apart) means the evidence
  # is not good enough. Guessing "committed" here deletes the rollback copies
  # and leaves a half-applied pair behind; stop instead and keep everything.
  for left in "$sp_state" "$teg_state"; do
    case "$left" in
      other|missing|ambiguous) return 1 ;;
    esac
  done

  # Both participating databases are on the same side of the swap: nothing to
  # repair. Either the swap never started (both old) or it finished and only
  # the record was left behind (both new).
  if [ "$sp_state" = "$teg_state" ] || [ "$sp_state" = "skip" ] || [ "$teg_state" = "skip" ]; then
    case "$sp_state$teg_state" in
      oldold|newnew|oldskip|newskip|skipold|skipnew|skipskip)
        if [ "$sp_state" = "new" ] || [ "$teg_state" = "new" ]; then
          _pending_note "committed"
        else
          _pending_note "discarded"
        fi
        _pending_clear
        rm -f "$sp_rb" "$teg_rb" 2>/dev/null || true
        return 0
        ;;
    esac
  fi

  # One side landed, the other did not. Put the landed side back. The rollback
  # copy is the only thing that can do that, and it has to still match the bytes
  # we recorded — anything else means it was clobbered by a later run.
  local st rb oldf od
  for st in sp teg; do
    if [ "$st" = "sp" ]; then rb=$sp_rb; oldf=$SMARTP; od=$sp_old; k=$sp_state
    else rb=$teg_rb; oldf=$TEG; od=$teg_old; k=$teg_state; fi
    if [ "$k" != "new" ]; then continue; fi
    if [ ! -f "$rb" ]; then return 1; fi
    if [ -n "$od" ] && [ "$(_sha256_file "$rb")" != "$od" ]; then return 1; fi
    _drop_sidecars "$oldf"
    mv -f "$rb" "$oldf" 2>/dev/null || return 1
    _drop_sidecars "$oldf"
  done

  # Prove the rollback before declaring it done.
  if [ "$sp_used" = "true" ]; then
    [ "$(_pair_state "$SMARTP" "$sp_old" "$sp_new" "$sp_old_size" "$sp_new_size")" = "old" ] || return 1
  fi
  if [ "$teg_used" = "true" ]; then
    [ "$(_pair_state "$TEG" "$teg_old" "$teg_new" "$teg_old_size" "$teg_new_size")" = "old" ] || return 1
  fi

  _pending_clear
  rm -f "$sp_rb" "$teg_rb" 2>/dev/null || true
  if [ "$was" = "true" ]; then _start_pkg >/dev/null 2>&1 || true; fi
  _pending_note "rolled-back"
  return 0
}

# Restore SmartP *and* teg as one transaction. Two independent _install_db calls
# (the old behaviour) could leave one database restored and the other still new
# if the second one failed — a combination that never existed on the device and
# that nothing can recover from without guessing. Order here is:
#   stage+verify both  ->  stop  ->  rollback copies for both  ->  swap both
#   ->  verify both  ->  on any failure put BOTH back.
# Leaves Joyose stopped on success; the caller decides whether to start it.
_restore_pair() {
  local dir="$1" sp_cur="${2:-}" teg_cur="${3:-}" from_client="${4:-false}"
  local sp_bak="$dir/SmartP.db" teg_bak="$dir/teg_config.db"
  local sp_tmp="$SMARTP.jedit.$$" teg_tmp="$TEG.jedit.$$"
  local sp_rb="$SMARTP.jedit.rb.$$" teg_rb="$TEG.jedit.rb.$$"
  local use_sp=false use_teg=false was_running=false failed='' rb_failed=''
  # s1/s2 are read by the transaction record even when one side is not being
  # written, so they must exist (under `set -u`) rather than be declared name-only.
  local chk s1='' r1='' s2='' r2='' skipped='' n1='' n2=''
  local ospsz=0 otgsz=0 nspsz=0 ntgsz=0 why obstacle

  # A backup that holds both databases says the device had both when it was
  # taken. If one of them is gone now, restoring only the survivor is a
  # different operation than the user asked for — report it instead of quietly
  # doing half the job.
  if [ -f "$sp_bak" ] && [ ! -f "$SMARTP" ]; then skipped="$skipped SmartP.db"; fi
  if [ -f "$teg_bak" ] && [ ! -f "$TEG" ]; then skipped="$skipped teg_config.db"; fi
  _RESTORE_SKIPPED=$skipped

  [ -f "$sp_bak" ] && [ -f "$SMARTP" ] && use_sp=true
  [ -f "$teg_bak" ] && [ -f "$TEG" ] && use_teg=true
  if [ "$use_sp" = false ] && [ "$use_teg" = false ]; then
    die "backup contains no database that exists on this device: $dir"
  fi

  # 1. stage and verify everything before a single live file is touched
  if [ "$use_sp" = true ]; then
    cp -f "$sp_bak" "$sp_tmp" 2>/dev/null || die "cannot stage the SmartP backup copy"
    chk=$(_verify_db "$sp_tmp")
    if [ "$chk" = "failed" ]; then
      rm -f "$sp_tmp"
      die "staged SmartP copy failed integrity check"
    fi
    if ! _apply_file_attrs "$SMARTP" "$sp_tmp"; then
      rm -f "$sp_tmp"
      die "cannot carry SmartP's ownership/mode onto the restored copy; refusing to restore"
    fi
  fi
  if [ "$use_teg" = true ]; then
    cp -f "$teg_bak" "$teg_tmp" 2>/dev/null || { rm -f "$sp_tmp"; die "cannot stage the teg backup copy"; }
    chk=$(_verify_db "$teg_tmp")
    if [ "$chk" = "failed" ]; then
      rm -f "$sp_tmp" "$teg_tmp"
      die "staged teg copy failed integrity check"
    fi
    if ! _apply_file_attrs "$TEG" "$teg_tmp"; then
      rm -f "$sp_tmp" "$teg_tmp"
      die "cannot carry teg's ownership/mode onto the restored copy; refusing to restore"
    fi
  fi

  # 2. quiesce once for both databases
  if _pid_alive; then was_running=true; fi
  # The caller needs this to decide whether to start Joyose afterwards, and it
  # must come from here: asking _pid_alive again after the stop always says
  # "not running".
  _RESTORE_WAS_RUNNING=$was_running
  if [ "$(_stop_pkg)" != "true" ]; then
    rm -f "$sp_tmp" "$teg_tmp"
    die "Joyose is still running; refusing to restore"
  fi

  # Quiesced: merge any pending `-wal` into the file we are about to copy.
  # Without this the rollback copy would be missing the rows in the log, and a
  # failed restore would put back a database that never existed. `$2`/`$3` are
  # the digests the caller read, when it has them — a merge that moved rows
  # makes their copy stale, and that is exactly what they are compared against.
  if [ "$use_sp" = true ]; then
    why=$(_wal_checkpoint "$SMARTP")
    obstacle=$(_wal_write_obstacle "$SMARTP" "$sp_cur" "$why" "$from_client")
    if [ -n "$obstacle" ]; then
      rm -f "$sp_tmp" "$teg_tmp"
      _abort_after_stop "$was_running" "$obstacle" wal-unmerged
    fi
  fi
  if [ "$use_teg" = true ]; then
    why=$(_wal_checkpoint "$TEG")
    obstacle=$(_wal_write_obstacle "$TEG" "$teg_cur" "$why" "$from_client")
    if [ -n "$obstacle" ]; then
      rm -f "$sp_tmp" "$teg_tmp"
      _abort_after_stop "$was_running" "$obstacle" wal-unmerged
    fi
  fi

  # 3. rollback copies for every target we are about to replace
  if [ "$use_sp" = true ]; then
    if ! cp -p "$SMARTP" "$sp_rb" 2>/dev/null; then
      rm -f "$sp_tmp" "$teg_tmp"
      _abort_after_stop "$was_running" "cannot create rollback copy for SmartP"
    fi
    s1=$(_sha256_file "$SMARTP")
    r1=$(_sha256_file "$sp_rb")
    if [ -n "$s1" ]; then
      if [ "$s1" != "$r1" ]; then
        rm -f "$sp_tmp" "$teg_tmp" "$sp_rb"
        _abort_after_stop "$was_running" "rollback copy for SmartP does not match the original; refusing to restore"
      fi
    elif [ "$(stat -c '%s' "$SMARTP" 2>/dev/null || echo 0)" != "$(stat -c '%s' "$sp_rb" 2>/dev/null || echo -1)" ]; then
      # No digest tool on this ROM: size is the only guard left, and skipping
      # it entirely (the old behaviour) meant a truncated rollback copy was
      # treated as valid. The single-database path already degraded to size;
      # this one silently did not.
      rm -f "$sp_tmp" "$teg_tmp" "$sp_rb"
      _abort_after_stop "$was_running" "rollback copy for SmartP is incomplete (size mismatch, no sha256 tool); refusing to restore"
    fi
  fi
  if [ "$use_teg" = true ]; then
    if ! cp -p "$TEG" "$teg_rb" 2>/dev/null; then
      rm -f "$sp_tmp" "$teg_tmp" "$sp_rb"
      _abort_after_stop "$was_running" "cannot create rollback copy for teg"
    fi
    s2=$(_sha256_file "$TEG")
    r2=$(_sha256_file "$teg_rb")
    if [ -n "$s2" ]; then
      if [ "$s2" != "$r2" ]; then
        rm -f "$sp_tmp" "$teg_tmp" "$sp_rb" "$teg_rb"
        _abort_after_stop "$was_running" "rollback copy for teg does not match the original; refusing to restore"
      fi
    elif [ "$(stat -c '%s' "$TEG" 2>/dev/null || echo 0)" != "$(stat -c '%s' "$teg_rb" 2>/dev/null || echo -1)" ]; then
      rm -f "$sp_tmp" "$teg_tmp" "$sp_rb" "$teg_rb"
      _abort_after_stop "$was_running" "rollback copy for teg is incomplete (size mismatch, no sha256 tool); refusing to restore"
    fi
  fi

  # Record the intent before the first rename. A kill between the two swaps
  # leaves a half-applied pair that no amount of error handling in this process
  # can undo, because this process is gone. The next mutating command reads this
  # record and puts both databases back (see _recover_pending_pair).
  if [ "$use_sp" = true ]; then
    n1=$(_sha256_file "$sp_tmp")
    ospsz=$(stat -c '%s' "$SMARTP" 2>/dev/null || echo 0)
    nspsz=$(stat -c '%s' "$sp_tmp" 2>/dev/null || echo 0)
  fi
  if [ "$use_teg" = true ]; then
    n2=$(_sha256_file "$teg_tmp")
    otgsz=$(stat -c '%s' "$TEG" 2>/dev/null || echo 0)
    ntgsz=$(stat -c '%s' "$teg_tmp" 2>/dev/null || echo 0)
  fi
  if ! _pending_write "$sp_rb" "$teg_rb" "$s1" "$s2" "$n1" "$n2" \
      "$ospsz" "$otgsz" "$nspsz" "$ntgsz" "$use_sp" "$use_teg" "$was_running"; then
    rm -f "$sp_tmp" "$teg_tmp"
    _abort_after_stop "$was_running" "cannot record the transaction on disk; refusing to swap"
  fi

  # 4. swap, then verify; the second swap is skipped if the first one failed
  if [ "$use_sp" = true ]; then
    _drop_sidecars "$SMARTP"
    mv -f "$sp_tmp" "$SMARTP" 2>/dev/null || failed='SmartP'
  fi
  if [ -z "$failed" ] && [ "$use_teg" = true ]; then
    _drop_sidecars "$TEG"
    mv -f "$teg_tmp" "$TEG" 2>/dev/null || failed='teg'
  fi
  if [ -z "$failed" ] && [ "$use_sp" = true ] && [ "$(_verify_db "$SMARTP")" = "failed" ]; then
    failed='SmartP'
  fi
  if [ -z "$failed" ] && [ "$use_teg" = true ] && [ "$(_verify_db "$TEG")" = "failed" ]; then
    failed='teg'
  fi

  # 5. any failure: put back only what actually changed
  if [ -n "$failed" ]; then
    local now_sha
    if [ "$use_sp" = true ] && [ -f "$sp_rb" ]; then
      now_sha=$(_sha256_file "$SMARTP")
      if [ -z "$s1" ] || [ "$now_sha" != "$s1" ]; then
        mv -f "$sp_rb" "$SMARTP" 2>/dev/null || rb_failed="$rb_failed SmartP"
        _drop_sidecars "$SMARTP"
      else
        # Same bytes as before the swap: nothing to undo, keep it as it is.
        rm -f "$sp_rb"
      fi
    fi
    if [ "$use_teg" = true ] && [ -f "$teg_rb" ]; then
      now_sha=$(_sha256_file "$TEG")
      if [ -z "$s2" ] || [ "$now_sha" != "$s2" ]; then
        mv -f "$teg_rb" "$TEG" 2>/dev/null || rb_failed="$rb_failed teg"
        _drop_sidecars "$TEG"
      else
        rm -f "$teg_rb"
      fi
    fi
    rm -f "$sp_tmp" "$teg_tmp"
    if [ -n "$rb_failed" ]; then
      # Do not start Joyose here: the database state is unknown and a cold start
      # would only make the failure look like a config problem.
      die "restore failed on $failed and the original could not be put back for:$rb_failed. Rollback copies kept: $sp_rb $teg_rb — restore them by hand or reboot before using Joyose"
    fi
    # Both databases are provably back on their old bytes: the record has done
    # its job and must not block the next write.
    _pending_clear
    _abort_after_stop "$was_running" "restore failed on $failed; both databases are back to their previous contents"
  fi

  # The bytes are right; make the filesystem agree. A fresh inode carries the
  # directory's default label, which on some ROMs is not the one Joyose is
  # allowed to open.
  _RESTORE_LABEL_SP=''
  _RESTORE_LABEL_TEG=''
  if [ "$use_sp" = true ]; then _RESTORE_LABEL_SP=$(_restore_label "$SMARTP"); fi
  if [ "$use_teg" = true ]; then _RESTORE_LABEL_TEG=$(_restore_label "$TEG"); fi
  # Both databases are verified and labelled: the swap is committed, so the
  # record must go before the rollback copies do. A crash after this line
  # leaves only stray .rb files, which the next run ignores.
  _pending_clear
  rm -f "$sp_rb" "$teg_rb" "$sp_tmp" "$teg_tmp"
}

_revert_from_dir() {
  local dir="$1" f chk started missing='' marker legacy=false
  [ -d "$dir" ] || die "no such backup: $dir"

  # A backup has to contain every database the device has right now. One that
  # does not is either a legacy snapshot (taken when the phone only had one) or
  # the remains of a run that was killed between its two copies — and restoring
  # the survivor alone is not what "回滚到备份" means. Do it silently and the
  # phone ends up holding a pair that never existed on any boot.
  if [ -f "$SMARTP" ] && [ ! -f "$dir/SmartP.db" ]; then missing="$missing SmartP.db"; fi
  if [ -f "$TEG" ] && [ ! -f "$dir/teg_config.db" ]; then missing="$missing teg_config.db"; fi
  if [ -n "$missing" ]; then
    die "备份不完整：缺少${missing}（设备上存在该库）。请换用完整备份，或先确认这个库可以单独丢弃" not-needed incomplete-backup
  fi

  marker=$(_verify_backup_marker "$dir")
  case "$marker" in
    ok) ;;
    no-marker)
      # Older backups predate the marker. They are allowed (the completeness
      # rule above already ran), but the caller is told this snapshot could not
      # prove it is untouched.
      legacy=true
      ;;
    mismatch:*)
      die "备份内容与生成时的摘要不符（${marker#mismatch:}），可能已损坏或被改动；已拒绝回滚" not-needed backup-corrupt
      ;;
  esac

  # Refuse to restore a corrupt backup: the whole point is that this file is
  # the known-good copy. Check both before touching either live database.
  for f in "$dir/SmartP.db" "$dir/teg_config.db"; do
    [ -f "$f" ] || continue
    chk=$(_verify_db "$f")
    if [ "$chk" = "failed" ]; then
      die "backup file failed integrity check: $(basename "$f")"
    fi
  done

  # One transaction for both databases: either the pair is restored, or neither
  # is. _restore_pair keeps a rollback copy of each live file and puts both back
  # if any step fails, so a half-restored pair cannot reach the phone.
  _RESTORE_WAS_RUNNING=false
  _RESTORE_SKIPPED=''
  _RESTORE_LABEL_SP=''
  _RESTORE_LABEL_TEG=''
  _restore_pair "$dir"

  started=false
  if [ "$_RESTORE_WAS_RUNNING" = "true" ]; then
    started=$(_start_pkg)
  fi
  printf '{"ok":true,"from":"%s","wasRunning":%s,"stopped":true,"restarted":%s,"atomic":true,"skipped":%s,"legacy":%s,"label":{"smartp":"%s","teg":"%s"}}\n' \
    "$dir" "$_RESTORE_WAS_RUNNING" "$started" "$(printf '%s' "${_RESTORE_SKIPPED# }" | _json_string)" \
    "$legacy" "${_RESTORE_LABEL_SP:-}" "${_RESTORE_LABEL_TEG:-}"
}

cmd_revert() {
  safe_name "$1" || die "invalid backup name"
  _revert_from_dir "$DATA_ROOT/backup/$1"
}

cmd_revert_latest() {
  local latest
  latest=$(ls -1t "$DATA_ROOT/backup" 2>/dev/null | head -n1)
  [ -n "$latest" ] || die "no backups yet"
  _revert_from_dir "$DATA_ROOT/backup/$latest"
}

cmd_restart() {
  local stopped started
  # Only start a service we are responsible for. There are two reasons Joyose
  # can be down when this runs, and they look identical from the outside:
  #
  #   - a write took it down and still owes it a start  → `$SERVICE_MARKER`
  #   - the user had it off before the module ever ran  → no marker
  #
  # Restarting on the second one turns "edit a config" into "launch an app I
  # had turned off", which nobody asked for and which the stop path already
  # refuses to do (`_stop_pkg` only writes the marker when it saw it running).
  # A process that is *up* is the third case: it is running against the old
  # bytes, so the restart is exactly what is needed.
  if [ ! -f "$SERVICE_MARKER" ] && ! _pid_alive; then
    printf '{"ok":true,"pkg":"%s","stopped":false,"started":false,"skipped":"not-running"}\n' "$PKG"
    return 0
  fi
  stopped=$(_stop_pkg)
  started=$(_start_pkg)
  printf '{"ok":true,"pkg":"%s","stopped":%s,"started":%s}\n' "$PKG" "$stopped" "$started"
}

cmd_history_list() {
  # Emit newline-delimited file names, newest first.
  ls -1t "$DATA_ROOT/history" 2>/dev/null || true
}

cmd_history_get() {
  safe_name "$1" || die "invalid history name"
  cat "$DATA_ROOT/history/$1"
}

cmd_history_clear() {
  local keep="$1"
  case "$keep" in ''|*[!0-9]*) die "keep must be a non-negative integer" ;; esac
  # Ordered by seq, not by mtime. Two commits inside the same second share an
  # mtime, and `ls -1t` then broke the tie by directory order — the prune could
  # delete the newer record and keep the older one, which silently cuts the
  # chain the "rollback to this record" replay walks.
  ls -1 "$DATA_ROOT/history" 2>/dev/null \
    | sed -n 's/^[0-9][0-9]*-\([0-9][0-9]*\)\.json$/\1 &/p' \
    | sort -k1,1nr \
    | tail -n +$((keep + 1)) \
    | while read -r _keep f; do
        [ -n "$f" ] && rm -f "$DATA_ROOT/history/$f"
      done
  printf '{"ok":true,"kept":%s}\n' "$keep"
}

cmd_cat_wasm() {
  local f=/data/adb/modules/joyose-edit/webroot/assets/sql-wasm.wasm
  [ -f "$f" ] || die "sql-wasm.wasm missing: $f"
  base64 -w0 "$f"
  echo
}

# Report whether the two vendor props that gate com.miui.securitycenter's
# GameBoxVisionEnhanceUtils.needInitService() are set. If both are false, the
# game assistant UI refuses to render FI / SR controls regardless of cloud DB
# content. We do NOT write the props ourselves — that is a user decision — but
# the WebUI can show the state and guide the user.
cmd_vision_status() {
  local frc sr
  frc=$(getprop ro.vendor.gpp.frc.support 2>/dev/null)
  sr=$(getprop ro.vendor.xiaomi.sr.support 2>/dev/null)
  printf '{"ok":true,"frc_support":"%s","sr_support":"%s"}\n' "$frc" "$sr"
}

# Version facts for the diagnosis page. Every field is optional on purpose:
# an odd ROM without getprop/dumpsys should still produce a usable report that
# says "unknown", not a failed command that hides the rest.
cmd_system_info() {
  local android hyperos joyose_ver module_ver
  android=$(getprop ro.build.version.release 2>/dev/null || true)
  hyperos=$(getprop ro.mi.os.version.name 2>/dev/null || true)
  [ -n "$hyperos" ] || hyperos=$(getprop ro.miui.ui.version.name 2>/dev/null || true)
  joyose_ver=$(dumpsys package "$PKG" 2>/dev/null \
    | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -n 1 || true)
  module_ver=$(sed -n 's/^version=//p' "$(dirname "$0")/../module.prop" 2>/dev/null | head -n 1 || true)
  printf '{"ok":true,"android":%s,"hyperos":%s,"joyose":%s,"module":%s}\n' \
    "$(printf '%s' "$android" | _json_string)" \
    "$(printf '%s' "$hyperos" | _json_string)" \
    "$(printf '%s' "$joyose_ver" | _json_string)" \
    "$(printf '%s' "$module_ver" | _json_string)"
}

# ---- teg SDK max-version freeze ------------------------------------------
# Joyose uses the MIUI teg cloud-config SDK (com.xiaomi.teg.config) for its
# runtime config. teg tracks its own `pref_local_max_version` in a
# SharedPreferences XML, completely independent of SmartP.db.cloud_config.version
# and teg_config.db.rules.rule_version. Every ~13 min (or on broadcast) teg SDK
# does:
#   local  = sp.getLong("pref_local_max_version", 0)
#   cloud  = HTTP POST .../getData body={version: local}
#   if (cloud.data.maxVersion == local) -> no-op
#   else -> apply delete/insert of rules to teg_config.db (NO per-rule
#           version check), bump SP, notify observers -> f.f.u() reloads
#           Joyose's in-memory state from teg_config.db via CloudConfig.
# So the only way to truly stop cloud from overwriting a user's edits is to
# write Long.MAX_VALUE into pref_local_max_version — teg then always sees
# "up to date" and never reapplies rules. Side effect: ALL teg cloud updates
# (including unrelated modules) are frozen.
TEG_SP=/data/user/0/com.xiaomi.joyose/shared_prefs/teg_config_pref.xml
TEG_MAX_VALUE=9223372036854775807
# Freezing used to be one-way: unfreeze wrote a hard-coded 0, which is not the
# state the device was in before. Keep the pre-freeze value here so unfreeze
# can put it back.
TEG_ORIGINAL_FILE="$DATA_ROOT/teg_original_version"

_teg_current_max() {
  [ -f "$TEG_SP" ] || { echo 0; return; }
  grep 'pref_local_max_version' "$TEG_SP" 2>/dev/null \
    | sed -E 's|.*value="([^"]*)".*|\1|' | head -n1
}

_teg_saved_original() {
  [ -f "$TEG_ORIGINAL_FILE" ] || return 0
  tr -d ' \r\n' < "$TEG_ORIGINAL_FILE"
}

cmd_teg_status() {
  if [ ! -f "$TEG_SP" ]; then
    printf '{"ok":true,"exists":false,"path":"%s"}\n' "$TEG_SP"
    return
  fi
  local cur frozen saved
  cur=$(_teg_current_max)
  [ -n "$cur" ] || cur=0
  if [ "$cur" = "$TEG_MAX_VALUE" ]; then frozen=true; else frozen=false; fi
  saved=$(_teg_saved_original)
  printf '{"ok":true,"exists":true,"path":"%s","pref_local_max_version":"%s","frozen":%s,"original":"%s"}\n' \
    "$TEG_SP" "$cur" "$frozen" "$saved"
}

# Write one value into the SharedPreferences XML and read it back. Returns
# non-zero when the file did not end up holding the requested value.
_teg_write_value() {
  local new_value="$1" tmp uid gid
  uid=$(stat -c '%u' "$TEG_SP")
  gid=$(stat -c '%g' "$TEG_SP")
  tmp="$TEG_SP.jedit.$$"
  if grep -q 'pref_local_max_version' "$TEG_SP" 2>/dev/null; then
    sed -E 's|(<long name="pref_local_max_version" value=")[^"]*(")|\1'"$new_value"'\2|' \
      "$TEG_SP" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  else
    awk -v ins="    <long name=\"pref_local_max_version\" value=\"$new_value\" />" '
      /<\/map>/ { print ins } { print }
    ' "$TEG_SP" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  fi
  chown "$uid:$gid" "$tmp" 2>/dev/null || true
  chmod 660 "$tmp"
  mv -f "$tmp" "$TEG_SP" || { rm -f "$tmp"; return 1; }
  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$TEG_SP" 2>/dev/null || true
  fi
  [ "$(_teg_current_max)" = "$new_value" ]
}

_teg_rewrite() {
  local mode="$1" cur saved new_value was stopped started wrote
  [ -f "$TEG_SP" ] || die "teg SDK SP file does not exist yet: $TEG_SP. Let Joyose initialise teg SDK first (e.g. push once)."

  cur=$(_teg_current_max)
  [ -n "$cur" ] || cur=0
  saved=$(_teg_saved_original)

  if [ "$mode" = "freeze" ]; then
    # Keep the first value we ever saw. Freezing while already frozen must not
    # overwrite it with MAX_VALUE, or unfreeze would "restore" the freeze.
    if [ -z "$saved" ] && [ "$cur" != "$TEG_MAX_VALUE" ]; then
      printf '%s\n' "$cur" > "$TEG_ORIGINAL_FILE" 2>/dev/null || die "cannot save original pref value"
      chmod 600 "$TEG_ORIGINAL_FILE" 2>/dev/null || true
      saved=$cur
    fi
    new_value="$TEG_MAX_VALUE"
  else
    if [ -n "$saved" ]; then
      new_value="$saved"
    else
      new_value=0
    fi
  fi

  was=false
  if _pid_alive; then was=true; fi
  # SharedPreferences keeps a per-process cache, so the file edit only takes
  # effect when the process is recreated — and must not race a live writer.
  stopped=$(_stop_pkg)
  if [ "$stopped" != "true" ]; then
    die "Joyose is still running; refusing to edit teg_config_pref.xml"
  fi

  if ! _teg_write_value "$new_value"; then
    # Joyose is already stopped at this point. Dying here left it down with
    # nothing said about it: the user saw only "write verification failed",
    # and the phone kept running without a config until the next cold start.
    if _teg_write_value "$cur" >/dev/null 2>&1; then
      _abort_after_stop "$was" "pref_local_max_version 写入校验失败（目标 $new_value），已把原值 $cur 写回"
    fi
    _abort_after_stop "$was" "pref_local_max_version 写入校验失败（目标 $new_value），原值 $cur 也没能写回，请在设置里确认 teg 版本后再试"
  fi
  wrote=$(_teg_current_max)

  started=false
  if [ "$was" = "true" ]; then
    started=$(_start_pkg)
  fi

  if [ "$mode" = "unfreeze" ]; then
    rm -f "$TEG_ORIGINAL_FILE" 2>/dev/null || true
  fi
  if [ "$wrote" = "$TEG_MAX_VALUE" ]; then frozen=true; else frozen=false; fi
  printf '{"ok":true,"path":"%s","pref_local_max_version":"%s","mode":"%s","original":"%s","wasRunning":%s,"stopped":true,"restarted":%s,"frozen":%s}\n' \
    "$TEG_SP" "$wrote" "$mode" "$saved" "$was" "$started" "$frozen"
}

cmd_teg_freeze()   { _teg_rewrite freeze; }
cmd_teg_unfreeze() { _teg_rewrite unfreeze; }

# ---- staging (for payloads that would overflow ARG_MAX) ------------------
# WebUI uses these to upload big base64 blobs in chunks instead of a single
# huge argv (shell rejects ~100+ KB argv with "Argument list too long").
#
# A failed upload leaves its partial file behind on purpose: the next attempt
# reuses it via stage-append, and push-from-stage deletes it after a
# successful write. Without a reaper, though, every aborted export / history
# save would add one more file forever. `_stage_gc` runs at the start of each
# upload: anything untouched for an hour cannot belong to an upload in flight.
STAGE_TTL=3600
STAGE_KEEP=40

_stage_gc() {
  local f name now mtime age removed=0
  now=$(date +%s)
  [ -d "$STAGE_DIR" ] || return 0
  for f in "$STAGE_DIR"/*; do
    [ -f "$f" ] || continue
    mtime=$(stat -c '%Y' "$f" 2>/dev/null || echo "$now")
    age=$((now - mtime))
    if [ "$age" -gt "$STAGE_TTL" ]; then
      rm -f "$f" 2>/dev/null && removed=$((removed + 1))
    fi
  done
  # Belt and braces: a burst of failures inside the TTL can still pile up.
  # `ls -t` is oldest-last; the tail beyond STAGE_KEEP is dropped.
  local total
  total=$(ls -1 "$STAGE_DIR" 2>/dev/null | wc -l | tr -d ' \n')
  if [ "${total:-0}" -gt "$STAGE_KEEP" ]; then
    ls -1t "$STAGE_DIR" 2>/dev/null | tail -n +$((STAGE_KEEP + 1)) | while IFS= read -r name; do
      rm -f "$STAGE_DIR/$name" 2>/dev/null && removed=$((removed + 1))
    done
  fi
  return 0
}

cmd_stage_gc() {
  local before after
  before=$(ls -1 "$STAGE_DIR" 2>/dev/null | wc -l | tr -d ' \n')
  _stage_gc
  after=$(ls -1 "$STAGE_DIR" 2>/dev/null | wc -l | tr -d ' \n')
  printf '{"ok":true,"removed":%s,"kept":%s}\n' "$((before - after))" "$after"
}

cmd_stage_clear() {
  safe_name "$1" || die "invalid stage name"
  _stage_gc
  : > "$STAGE_DIR/$1"
  chmod 600 "$STAGE_DIR/$1"
  printf '{"ok":true,"stage":"%s"}\n' "$1"
}

cmd_stage_append() {
  safe_name "$1" || die "invalid stage name"
  local chunk="$2"
  [ -n "$chunk" ] || die "stage-append: missing chunk"
  [ -f "$STAGE_DIR/$1" ] || die "stage not initialised: $1 (call stage-clear first)"
  printf '%s' "$chunk" >> "$STAGE_DIR/$1"
  printf '{"ok":true}\n'
}

cmd_push_from_stage() {
  local sel="$1" stage="$2" expect_size="${3:-}" expect_sha="${4:-}" expect_current="${5:-}"
  local target tmp stage_file
  safe_name "$stage" || die "invalid stage name"
  target=$(resolve_db "$sel")
  [ -f "$target" ] || die "missing: $target"
  stage_file="$STAGE_DIR/$stage"
  [ -f "$stage_file" ] || die "stage file missing: $stage"
  tmp="$target.jedit.$$"
  base64 -d < "$stage_file" > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "base64 decode failed"; }
  # Same guard chain as cmd_push. _install_db exits on failure, so the stage
  # file survives for a retry.
  _finish_staged_write "$target" "$tmp" "$expect_size" "$expect_sha" "$expect_current"
  rm -f "$stage_file"
}

cmd_history_save_from_stage() {
  safe_name "$1" || die "invalid history name"
  safe_name "$2" || die "invalid stage name"
  local f="$DATA_ROOT/history/$1"
  # Temp lives in the stage directory, not next to the target: a crash leaves a
  # file the stage GC already knows how to prune, never a half-written record
  # inside `history/`.
  local tmp="$STAGE_DIR/hist-$1.$$"
  local stage_file="$STAGE_DIR/$2"
  [ -f "$stage_file" ] || die "stage file missing: $2"
  umask 077
  # Decode next to the target, never over it: a kill mid-decode used to leave a
  # truncated record under its final name, and the next reader treated it as a
  # valid parent in the chain.
  base64 -d < "$stage_file" > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "base64 decode failed"; }
  chmod 600 "$tmp" 2>/dev/null || true
  # The seq is chosen by the WebView from a directory listing, so two of them
  # can pick the same number. `ln` is create-or-fail everywhere Android has
  # filesystems: the loser is told, instead of silently overwriting a record
  # the other WebView just wrote.
  if ! ln "$tmp" "$f" 2>/dev/null; then
    rm -f "$tmp"
    die "history name already taken: $1" not-needed duplicate-history
  fi
  rm -f "$tmp"
  rm -f "$stage_file"
  printf '{"ok":true,"path":"%s"}\n' "$f"
}

# Export a staged payload into the shared Download folder. The WebView cannot
# be trusted to honour a Blob download (KernelSU's WebView often ignores it, and
# the file lands nowhere), so the export is written by root at a fixed path.
cmd_save_dl_from_stage() {
  safe_name "$1" || die "invalid download name"
  safe_name "$2" || die "invalid stage name"
  local dir=/sdcard/Download/joyose-edit
  local f="$dir/$1"
  local stage_file="$STAGE_DIR/$2"
  [ -f "$stage_file" ] || die "stage file missing: $2"
  mkdir -p "$dir" 2>/dev/null || die "cannot create $dir"
  umask 022
  base64 -d < "$stage_file" > "$f" 2>/dev/null || { rm -f "$f"; die "base64 decode failed"; }
  chmod 644 "$f" 2>/dev/null || true
  rm -f "$stage_file"
  printf '{"ok":true,"path":"%s"}\n' "$f"
}

# Reset Joyose's cloud state: wipe app data so the next launch re-downloads
# everything, then wake the cloud service / receivers so it happens promptly
# instead of on the next 13-minute tick. Destructive by design — the WebUI
# gates this behind an explicit confirmation.
# Every step used to be `|| true` and the command printed `ok` unconditionally,
# so a failed `pm clear` looked exactly like a successful reset: the UI said
# "cleared", the data was still there, and the user retried into the same state.
#
# `pm clear` is the only step whose failure means "nothing happened" — the rest
# are best-effort re-enable / wake-ups that Joyose repeats on its own next
# launch. So: report every failure, mark the reset failed only when the data was
# not actually cleared.
cmd_reset_cloud() {
  local failed='' cleared=false
  # NB: every call is written as `cmd || _mark_fail name`, never as a bare
  # function call that returns 1 — `set -e` would abort the whole helper on the
  # first failure and the caller would see no JSON at all.
  _mark_fail() {
    failed="${failed:+$failed,}\"$1\""
  }

  if pm clear "$PKG" >/dev/null 2>&1; then
    cleared=true
  else
    _mark_fail pm_clear
  fi
  am force-stop "$PKG" >/dev/null 2>&1 || _mark_fail force_stop
  pm enable "$PKG/com.xiaomi.joyose.smartop.SmartOpService" >/dev/null 2>&1 || _mark_fail enable_op
  pm enable "$PKG/com.xiaomi.joyose.cloud.CloudServerReceiver" >/dev/null 2>&1 || _mark_fail enable_cloud
  am broadcast -a android.intent.action.BOOT_COMPLETED -p "$PKG" >/dev/null 2>&1 || _mark_fail boot_broadcast
  am broadcast "$PKG/com.xiaomi.joyose.cloud.CloudServerReceiver" >/dev/null 2>&1 || _mark_fail cloud_broadcast
  am broadcast "$PKG/com.xiaomi.joyose.JoyoseBroadCastReceiver" >/dev/null 2>&1 || _mark_fail joyose_broadcast
  am broadcast -a android.intent.action.BOOT_COMPLETED -n "$PKG/com.xiaomi.joyose.JoyoseBroadCastReceiver" >/dev/null 2>&1 || _mark_fail boot_receiver

  if [ "$cleared" = true ]; then
    printf '{"ok":true,"cleared":true,"failed":[%s]}\n' "$failed"
  else
    printf '{"ok":false,"cleared":false,"failed":[%s]}\n' "$failed"
  fi
}

cmd_install_ts() {
  local f=/data/adb/modules/joyose-edit/.install_ts
  if [ -f "$f" ]; then cat "$f"; else printf '0'; fi
}

# ---- WebUI preferences ----------------------------------------------------
# Stored next to the backups instead of in the WebView's localStorage: the
# per-manager WebUI origin (and its storage) is not stable across manager
# switches / WebView data resets, which silently reset the source and
# write-target pickers back to their defaults.
PREFS_FILE="$DATA_ROOT/settings.json"

cmd_prefs_read() {
  if [ -f "$PREFS_FILE" ]; then cat "$PREFS_FILE"; else printf '{}'; fi
}

cmd_prefs_write() {
  local b64="${1:-}"
  local tmp="$PREFS_FILE.tmp.$$"
  [ -n "$b64" ] || die "prefs-write: missing base64 payload"
  mkdir -p "$DATA_ROOT"
  # Decode into a sibling temp file and rename: a half-written settings file
  # would make every later read fall back to the defaults.
  if ! printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    die "prefs-write: base64 decode failed"
  fi
  # The exit code is not the verdict. toybox's `base64 -d` (the one Android
  # ships) skips characters outside the alphabet and still exits 0, so a
  # payload of `!!!` decoded to nothing and the rename below replaced the
  # settings file with an empty one — the next read fell back to defaults and
  # said nothing. Empty is never a settings document, and neither is anything
  # that does not open an object.
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "prefs-write: payload decoded to nothing"
  fi
  case "$(head -c 1 "$tmp" 2>/dev/null || true)" in
    '{') ;;
    *) rm -f "$tmp"; die "prefs-write: payload is not a JSON object" ;;
  esac
  chmod 600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$PREFS_FILE"
  printf 'ok'
}

cmd_lock_status() {
  local pid='' ts='' start='' token='' kind='' now age overdue=false
  if _lock_owner_alive; then
    read -r pid ts start token kind < "$LOCK_DIR/owner" 2>/dev/null || true
    now=$(date +%s)
    age=$((now - ${ts:-$now}))
    # Long-running but healthy. Reported instead of acted on: age alone must
    # never turn a live holder's lock into a free one.
    [ "$age" -ge "$LOCK_TTL" ] && overdue=true
    printf '{"locked":true,"pid":%s,"ageSeconds":%s,"op":%s,"overdue":%s}\n' \
      "${pid:-0}" "$age" "$(printf '%s' "${kind:-}" | _json_string)" "$overdue"
  elif [ -d "$LOCK_DIR" ]; then
    printf '{"locked":false,"stale":true}\n'
  else
    printf '{"locked":false}\n'
  fi
}

# ---- dispatch -------------------------------------------------------------
cmd="${1:-}"
[ -n "$cmd" ] || die "missing subcommand"
shift

# Every command that can stop Joyose or change a file takes the device lock.
# Read-only probes (stat/digest/pull/status) stay lock-free so a long upload
# never blocks the dashboard.
#
# `push-pair-from-stage` belongs here more than anything else does: it is the
# command the WebUI uses for a normal commit (both databases move as one), and
# for a while it was the only mutating command missing from this list — the
# single-database path was serialised while the common one was not. A missing
# entry also skipped `_recover_pending_pair`, so a commit could overwrite the
# record left by an interrupted one.
#
# `history-save-from-stage` / `history-clear` write and delete files the next
# commit reads (seq allocation scans the same directory), and they are called
# by every WebView, so they need the same mutex.
#
# `bootstrap-backup` is the boot snapshot: it stops Joyose and copies both
# databases, which is exactly the window a commit must not share.
case "$cmd" in
  push|push-from-stage|push-pair-from-stage|backup|bootstrap-backup|revert|revert-latest|reset-cloud|teg-freeze|teg-unfreeze|restart|history-save-from-stage|history-clear)
    _acquire_lock "$cmd" ;;
esac

case "$cmd" in
  stat)           cmd_stat ;;
  digest)         cmd_digest ;;
  install-ts)     cmd_install_ts ;;
  prefs-read)     cmd_prefs_read ;;
  prefs-write)    cmd_prefs_write "${1:-}" ;;
  save-dl-from-stage) cmd_save_dl_from_stage "${1:-}" "${2:-}" ;;
  reset-cloud)    cmd_reset_cloud ;;
  pull)           cmd_pull "${1:-}" ;;
  push)           cmd_push "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  backup)         cmd_backup "$@" ;;
  prune-backups)  prune_backups "${1:-10}" ;;
  revert)         cmd_revert "${1:-}" ;;
  revert-latest)  cmd_revert_latest ;;
  restart)        cmd_restart ;;
  history-list)   cmd_history_list ;;
  history-get)    cmd_history_get "${1:-}" ;;
  history-clear)  cmd_history_clear "${1:-}" ;;
  cat-wasm)       cmd_cat_wasm ;;
  vision-status)  cmd_vision_status ;;
  system-info)    cmd_system_info ;;
  teg-status)     cmd_teg_status ;;
  teg-freeze)     cmd_teg_freeze ;;
  teg-unfreeze)   cmd_teg_unfreeze ;;
  stage-clear)    cmd_stage_clear "${1:-}" ;;
  stage-gc)       cmd_stage_gc ;;
  stage-append)   cmd_stage_append "${1:-}" "${2:-}" ;;
  bootstrap-backup)        cmd_bootstrap_backup ;;
  push-from-stage)         cmd_push_from_stage "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  push-pair-from-stage)    cmd_push_pair_from_stage "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}" "${8:-}" ;;
  lock-status)             cmd_lock_status ;;
  history-save-from-stage) cmd_history_save_from_stage "${1:-}" "${2:-}" ;;
  *) die "unknown subcommand: $cmd" ;;
esac
