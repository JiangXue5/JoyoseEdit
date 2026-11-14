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
# then take the snapshot. The stamp file keeps it to one snapshot per Joyose
# DB version.

DATA_ROOT=/data/adb/joyose-edit
DB_DIR=/data/user/0/com.xiaomi.joyose/databases
STAMP_FILE="$DATA_ROOT/.bootstrap-version"

mkdir -p "$DATA_ROOT/backup"
chmod 700 "$DATA_ROOT"

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

# Fingerprint: mtime#size#inode of SmartP.db — cheap, stable, no extra tools.
FP="$(stat -c '%Y#%s#%i' "$DB_DIR/SmartP.db" 2>/dev/null)"
[ -n "$FP" ] || exit 0

LAST=""
[ -f "$STAMP_FILE" ] && LAST="$(cat "$STAMP_FILE" 2>/dev/null)"

if [ "$FP" = "$LAST" ]; then
  exit 0
fi

TARGET="$DATA_ROOT/backup/initial-$(date +%s)"
mkdir -p "$TARGET" 2>/dev/null || exit 0

# Both copies have to land before the stamp is written. The stamp is what makes
# the next boot skip the snapshot, so recording it after a failed copy meant a
# half-empty "initial" backup was treated as done — forever.
ok=1
if [ -f "$DB_DIR/SmartP.db" ]; then
  cp -f "$DB_DIR/SmartP.db" "$TARGET/SmartP.db" 2>/dev/null || ok=0
  if [ "$ok" = "1" ]; then
    [ "$(stat -c '%s' "$DB_DIR/SmartP.db" 2>/dev/null || echo -1)" = "$(stat -c '%s' "$TARGET/SmartP.db" 2>/dev/null || echo -2)" ] || ok=0
  fi
fi
if [ -f "$DB_DIR/teg_config.db" ]; then
  cp -f "$DB_DIR/teg_config.db" "$TARGET/teg_config.db" 2>/dev/null || ok=0
  if [ "$ok" = "1" ]; then
    [ "$(stat -c '%s' "$DB_DIR/teg_config.db" 2>/dev/null || echo -1)" = "$(stat -c '%s' "$TARGET/teg_config.db" 2>/dev/null || echo -2)" ] || ok=0
  fi
fi

if [ "$ok" != "1" ]; then
  # No stamp: the fingerprint is unchanged, so the next boot tries again.
  rm -rf "$TARGET" 2>/dev/null
  exit 0
fi

chmod 700 "$TARGET"
printf '%s\n' "$FP" > "$STAMP_FILE" 2>/dev/null || true
