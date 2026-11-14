#!/system/bin/sh
# Late-start safety snapshot.
#
# This used to run as post-fs-data.sh, which executes *before* the owner's
# credential-encrypted storage is mounted. On any FBE device (i.e. every
# supported Xiaomi) `/data/user/0/com.xiaomi.joyose/databases` does not exist
# yet at that point, so the `[ -f ... ] || exit 0` guard fired every boot and
# the "pre-edit baseline" backup was never actually created.
#
# Moving to service.sh (late_start service) lets us wait for CE storage and
# then take the snapshot. The stamp file keeps it to one snapshot per version
# of the database pair.
#
# The snapshot itself is taken by the helper, not by this script. It used to be
# a bare `cp` here: no device lock, so a boot that raced a WebUI commit could
# copy one database from before the swap and the other from after it; and no
# integrity check beyond "same size", so a torn copy was stored as the baseline
# the user would later be told to restore. `bootstrap-backup` runs the same
# snapshot a manual backup takes — exclusive directory, quiesced consumer,
# integrity check, COMPLETE marker — under the lock a commit uses.

DATA_ROOT=/data/adb/joyose-edit
DB_DIR=/data/user/0/com.xiaomi.joyose/databases
MODDIR=${0%/*}
HELPER="$MODDIR/bin/joyose-edit.sh"
LOG="$DATA_ROOT/bootstrap.log"

[ -f "$HELPER" ] || exit 0

mkdir -p "$DATA_ROOT/backup"
chmod 700 "$DATA_ROOT" 2>/dev/null

# Wait up to 90 s for the owner's CE storage to appear (first unlock after
# boot). Devices without a secure lockscreen unlock during boot, so this is
# usually immediate.
i=0
while [ "$i" -lt 90 ]; do
  [ -f "$DB_DIR/SmartP.db" ] && break
  sleep 1
  i=$((i + 1))
done

[ -f "$DB_DIR/SmartP.db" ] || exit 0

# Keep the log from growing without bound across boots: it is only useful for
# the last failure, and a boot loop would otherwise fill /data/adb.
if [ -f "$LOG" ] && [ "$(stat -c '%s' "$LOG" 2>/dev/null || echo 0)" -gt 65536 ]; then
  : > "$LOG" 2>/dev/null
fi

# The helper decides whether a snapshot is due (both databases' fingerprints
# against the stamp) and writes the stamp only after the snapshot is complete
# and marked, so a failed boot is retried next time instead of being remembered
# as done.
sh "$HELPER" bootstrap-backup >> "$LOG" 2>&1

exit 0
