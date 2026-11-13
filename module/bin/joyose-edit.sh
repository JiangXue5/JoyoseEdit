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
# bridge does not expose stdin, so all payload goes through argv. Modern
# Android has ARG_MAX >= 2 MB which comfortably fits our largest payload
# (~1 MB for the teg_config.db mirror on a K90 Pro Max sample).

set -eu

DATA_ROOT=/data/adb/joyose-edit
STAGE_DIR="$DATA_ROOT/stage"
DB_DIR=/data/user/0/com.xiaomi.joyose/databases
SMARTP="$DB_DIR/SmartP.db"
TEG="$DB_DIR/teg_config.db"
PKG=com.xiaomi.joyose

mkdir -p "$DATA_ROOT/backup" "$DATA_ROOT/history" "$STAGE_DIR"
chmod 700 "$DATA_ROOT" "$DATA_ROOT/backup" "$DATA_ROOT/history" "$STAGE_DIR"

# Errors go to stderr: callers capture stdout in $(...) all over this file
# (resolve_db, prune_backups), and a fatal message printed to stdout was being
# swallowed by command substitution — the user only saw "shell exit 1".
die() { printf '{"ok":false,"error":%s}\n' "$(printf '%s' "$1" | _json_string)" >&2; exit 1; }

# ---- helpers --------------------------------------------------------------
_json_string() {
  # stdin -> JSON string literal (quote + escape). Joins lines with \n but does
  # not append one: a single-line message used to come back as "text\n",
  # which the WebUI then showed or compared with a stray newline attached.
  awk 'BEGIN{printf "\""} {
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

# A lock is stale when its owner is *gone* — never merely because it is old.
# The previous version required `kill -0` AND `age < LOCK_TTL`, so a write that
# took longer than three minutes had its lock declared dead while still running,
# and a second writer could enter the critical section underneath it. Age is now
# only a fallback for the no-procfs / legacy-owner-file case.
_lock_owner_alive() {
  local pid ts start token now nowstart
  [ -f "$LOCK_DIR/owner" ] || return 1
  read -r pid ts start token _ < "$LOCK_DIR/owner" 2>/dev/null || return 1
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

_acquire_lock() {
  local kind="$1" i=0 start
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if ! _lock_owner_alive; then
      # Rename first: only one waiter can move a given inode, so two processes
      # that both judged the lock stale cannot both delete a freshly created
      # one. The loser simply loops and retries.
      if mv "$LOCK_DIR" "$LOCK_DIR.stale.$$" 2>/dev/null; then
        rm -rf "$LOCK_DIR.stale.$$" 2>/dev/null || true
      fi
      continue
    fi
    i=$((i + 1))
    if [ "$i" -ge 100 ]; then
      die "device is busy: another write is still running (pid $(awk '{print $1}' "$LOCK_DIR/owner" 2>/dev/null) · $(awk '{print $5}' "$LOCK_DIR/owner" 2>/dev/null))"
    fi
    sleep 0.2 2>/dev/null || sleep 1
  done
  start=$(_proc_start "$$")
  [ -n "$start" ] || start='-'
  MY_LOCK_TOKEN=$(_new_token)
  [ -n "$MY_LOCK_TOKEN" ] || MY_LOCK_TOKEN="$$-$(date +%s)"
  printf '%s %s %s %s %s\n' "$$" "$(date +%s)" "$start" "$MY_LOCK_TOKEN" "$kind" > "$LOCK_DIR/owner"
  trap '_release_lock' EXIT
  trap '_release_lock; exit 130' INT TERM HUP
}

_release_lock() {
  local pid _ start token
  [ -f "$LOCK_DIR/owner" ] || return 0
  read -r pid _ start token _ < "$LOCK_DIR/owner" 2>/dev/null || return 0
  [ "${pid:-}" = "$$" ] || return 0
  # Pid alone is not identity: after we exit, an unrelated process can inherit
  # our number and create its own lock. Only remove the lock we created.
  if [ -n "${token:-}" ] && [ -n "${MY_LOCK_TOKEN:-}" ] && [ "$token" != "$MY_LOCK_TOKEN" ]; then
    return 0
  fi
  rm -rf "$LOCK_DIR" 2>/dev/null
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
  am force-stop "$PKG" >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 20 ]; do
    if ! _pid_alive; then
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
  if [ "${1:-false}" = "true" ]; then
    _start_pkg >/dev/null 2>&1 || true
  fi
  die "${2:-write aborted}"
}

# sha256 of a file, or nothing when the ROM has no tool. Callers must treat an
# empty result as "unverified" and say so — never as "matches".
_sha256_file() {
  command -v sha256sum >/dev/null 2>&1 || return 0
  sha256sum "$1" 2>/dev/null | cut -d' ' -f1
}

# Sidecars are per-database-name, not per-inode: after a replace they still
# point at the bytes we just threw away.
_drop_sidecars() {
  rm -f "$1-journal" "$1-wal" "$1-shm" 2>/dev/null || true
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
  local uid gid stopped chk size sha rollback cur was_running=false rb_mode='size' src_sha dst_sha

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

  # TOCTOU guard: the caller read this file, built a new one, and is now
  # asking us to swap it in. If the live file changed in between (Joyose pulled
  # a fresh cloud config), the new bytes were computed on a stale base and
  # applying them would silently roll that update back.
  if [ -n "$expect_current" ] && [ "$expect_current" != "none" ]; then
    cur=$(sha256sum "$target" 2>/dev/null | cut -d' ' -f1)
    if [ "$cur" != "$expect_current" ]; then
      rm -f "$tmp"
      die "database changed after it was read ($(printf '%s' "$cur" | cut -c1-12) != $(printf '%s' "$expect_current" | cut -c1-12)); refusing to overwrite"
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
  chown "$uid:$gid" "$tmp" 2>/dev/null || true
  chmod 660 "$tmp"

  # 2. the consumer must be gone, not merely "am did not throw"
  if _pid_alive; then was_running=true; fi
  stopped=$(_stop_pkg)
  if [ "$stopped" != "true" ]; then
    rm -f "$tmp"
    # It is still running, so there is nothing to put back.
    die "Joyose is still running; refusing to replace $target"
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
    mv -f "$rollback" "$target" 2>/dev/null || true
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
  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$target" 2>/dev/null || true
  fi
  printf '{"ok":true,"path":"%s","uid":%s,"gid":%s,"stopped":true,"verified":"%s","rollback":"%s"}\n' \
    "$target" "$uid" "$gid" "$chk" "$rb_mode"
}


stat_one() {
  local f="$1" key="$2"
  if [ -f "$f" ]; then
    local mtime size uid gid
    mtime=$(stat -c '%Y' "$f" 2>/dev/null || echo 0)
    size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
    uid=$(stat -c '%u' "$f" 2>/dev/null || echo 0)
    gid=$(stat -c '%g' "$f" 2>/dev/null || echo 0)
    printf '"%s":{"exists":true,"path":"%s","mtime":%s,"size":%s,"uid":%s,"gid":%s}' \
      "$key" "$f" "$mtime" "$size" "$uid" "$gid"
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
  printf '}\n'
}

cmd_pull() {
  local target
  target=$(resolve_db "$1")
  [ -f "$target" ] || die "missing: $target"
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

cmd_push() {
  local sel="$1" b64="$2" target tmp
  [ -n "$b64" ] || die "push: missing base64 payload"
  target=$(resolve_db "$sel")
  [ -f "$target" ] || die "missing: $target"
  tmp="$target.jedit.$$"
  # decode directly into the sibling tmp, then rename atomically.
  printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "base64 decode failed"; }
  # quick sanity: must be a SQLite file
  head -c 16 "$tmp" | grep -qa 'SQLite format 3' || { rm -f "$tmp"; die "not a sqlite db"; }
  _install_db "$target" "$tmp"
}

cmd_backup() {
  local label="" restore="restore" arg stamp dir stopped chk was started
  for arg in "$@"; do
    case "$arg" in
      --no-restore) restore="no-restore" ;;
      *) label="$arg" ;;
    esac
  done
  stamp=$(date +%s)
  if [ -n "$label" ]; then
    safe_name "$label" || die "invalid label"
    dir="$DATA_ROOT/backup/${stamp}-${label}"
  else
    dir="$DATA_ROOT/backup/${stamp}"
  fi
  mkdir -p "$dir"
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

# Restore SmartP *and* teg as one transaction. Two independent _install_db calls
# (the old behaviour) could leave one database restored and the other still new
# if the second one failed — a combination that never existed on the device and
# that nothing can recover from without guessing. Order here is:
#   stage+verify both  ->  stop  ->  rollback copies for both  ->  swap both
#   ->  verify both  ->  on any failure put BOTH back.
# Leaves Joyose stopped on success; the caller decides whether to start it.
_restore_pair() {
  local dir="$1"
  local sp_bak="$dir/SmartP.db" teg_bak="$dir/teg_config.db"
  local sp_tmp="$SMARTP.jedit.$$" teg_tmp="$TEG.jedit.$$"
  local sp_rb="$SMARTP.jedit.rb.$$" teg_rb="$TEG.jedit.rb.$$"
  local use_sp=false use_teg=false was_running=false failed='' rb_failed=''
  local chk s1 r1 s2 r2

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
  fi
  if [ "$use_teg" = true ]; then
    cp -f "$teg_bak" "$teg_tmp" 2>/dev/null || { rm -f "$sp_tmp"; die "cannot stage the teg backup copy"; }
    chk=$(_verify_db "$teg_tmp")
    if [ "$chk" = "failed" ]; then
      rm -f "$sp_tmp" "$teg_tmp"
      die "staged teg copy failed integrity check"
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

  # 3. rollback copies for every target we are about to replace
  if [ "$use_sp" = true ]; then
    if ! cp -p "$SMARTP" "$sp_rb" 2>/dev/null; then
      rm -f "$sp_tmp" "$teg_tmp"
      _abort_after_stop "$was_running" "cannot create rollback copy for SmartP"
    fi
    s1=$(_sha256_file "$SMARTP")
    r1=$(_sha256_file "$sp_rb")
    if [ -n "$s1" ] && [ "$s1" != "$r1" ]; then
      rm -f "$sp_tmp" "$teg_tmp" "$sp_rb"
      _abort_after_stop "$was_running" "rollback copy for SmartP does not match the original; refusing to restore"
    fi
  fi
  if [ "$use_teg" = true ]; then
    if ! cp -p "$TEG" "$teg_rb" 2>/dev/null; then
      rm -f "$sp_tmp" "$teg_tmp" "$sp_rb"
      _abort_after_stop "$was_running" "cannot create rollback copy for teg"
    fi
    s2=$(_sha256_file "$TEG")
    r2=$(_sha256_file "$teg_rb")
    if [ -n "$s2" ] && [ "$s2" != "$r2" ]; then
      rm -f "$sp_tmp" "$teg_tmp" "$sp_rb" "$teg_rb"
      _abort_after_stop "$was_running" "rollback copy for teg does not match the original; refusing to restore"
    fi
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
    _abort_after_stop "$was_running" "restore failed on $failed; both databases are back to their previous contents"
  fi

  rm -f "$sp_rb" "$teg_rb" "$sp_tmp" "$teg_tmp"
}

_revert_from_dir() {
  local dir="$1" f chk started
  [ -d "$dir" ] || die "no such backup: $dir"

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
  _restore_pair "$dir"

  started=false
  if [ "$_RESTORE_WAS_RUNNING" = "true" ]; then
    started=$(_start_pkg)
  fi
  printf '{"ok":true,"from":"%s","wasRunning":%s,"stopped":true,"restarted":%s,"atomic":true}\n' \
    "$dir" "$_RESTORE_WAS_RUNNING" "$started"
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
  ls -1t "$DATA_ROOT/history" 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r f; do
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
    # Try to put back what was there before we touched it.
    _teg_write_value "$cur" >/dev/null 2>&1 || true
    die "pref_local_max_version write verification failed (wanted $new_value)"
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

cmd_stage_clear() {
  safe_name "$1" || die "invalid stage name"
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
  head -c 16 "$tmp" | grep -qa 'SQLite format 3' || { rm -f "$tmp"; die "not a sqlite db"; }
  # _install_db keeps its own guarantees (pre-check, rollback copy, post-check).
  # It exits on failure, so the stage file survives for a retry.
  _install_db "$target" "$tmp" "$expect_size" "$expect_sha" "$expect_current"
  rm -f "$stage_file"
}

cmd_history_save_from_stage() {
  safe_name "$1" || die "invalid history name"
  safe_name "$2" || die "invalid stage name"
  local f="$DATA_ROOT/history/$1"
  local stage_file="$STAGE_DIR/$2"
  [ -f "$stage_file" ] || die "stage file missing: $2"
  umask 077
  base64 -d < "$stage_file" > "$f" 2>/dev/null || die "base64 decode failed"
  chmod 600 "$f"
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
  local b64="${1:?}"
  local tmp="$PREFS_FILE.tmp.$$"
  mkdir -p "$DATA_ROOT"
  # Decode into a sibling temp file and rename: a half-written settings file
  # would make every later read fall back to the defaults.
  if ! printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    die "prefs-write: base64 decode failed"
  fi
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
case "$cmd" in
  push|push-from-stage|backup|revert|revert-latest|reset-cloud|teg-freeze|teg-unfreeze|restart)
    _acquire_lock "$cmd" ;;
esac

case "$cmd" in
  stat)           cmd_stat ;;
  digest)         cmd_digest ;;
  install-ts)     cmd_install_ts ;;
  prefs-read)     cmd_prefs_read ;;
  prefs-write)    cmd_prefs_write "${1:?}" ;;
  save-dl-from-stage) cmd_save_dl_from_stage "${1:?}" "${2:?}" ;;
  reset-cloud)    cmd_reset_cloud ;;
  pull)           cmd_pull "${1:?}" ;;
  push)           cmd_push "${1:?}" "${2:?}" ;;
  backup)         cmd_backup "$@" ;;
  prune-backups)  prune_backups "${1:-10}" ;;
  revert)         cmd_revert "${1:?}" ;;
  revert-latest)  cmd_revert_latest ;;
  restart)        cmd_restart ;;
  history-list)   cmd_history_list ;;
  history-get)    cmd_history_get "${1:?}" ;;
  history-clear)  cmd_history_clear "${1:?}" ;;
  cat-wasm)       cmd_cat_wasm ;;
  vision-status)  cmd_vision_status ;;
  teg-status)     cmd_teg_status ;;
  teg-freeze)     cmd_teg_freeze ;;
  teg-unfreeze)   cmd_teg_unfreeze ;;
  stage-clear)    cmd_stage_clear "${1:?}" ;;
  stage-append)   cmd_stage_append "${1:?}" "${2:?}" ;;
  push-from-stage)         cmd_push_from_stage "${1:?}" "${2:?}" "${3:-}" "${4:-}" "${5:-}" ;;
  lock-status)             cmd_lock_status ;;
  history-save-from-stage) cmd_history_save_from_stage "${1:?}" "${2:?}" ;;
  *) die "unknown subcommand: $cmd" ;;
esac
