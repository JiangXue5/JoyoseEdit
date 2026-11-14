#!/system/bin/sh
# JoyoseEdit — KernelSU uninstall script.
# Cleans up state that lives OUTSIDE the module directory (which KernelSU
# removes on its own). Two things to roll back:
#   1. /data/adb/joyose-edit/         — backups, history, stage, bootstrap stamp
#   2. pref_local_max_version          — only if we froze it (Long.MAX_VALUE)
# Joyose's own databases are left untouched.

DATA_ROOT=/data/adb/joyose-edit
ORIGINAL_FILE="$DATA_ROOT/teg_original_version"
PKG=com.xiaomi.joyose
TEG_SP=/data/user/0/$PKG/shared_prefs/teg_config_pref.xml
TEG_MAX_VALUE=9223372036854775807

command -v ui_print >/dev/null 2>&1 || ui_print() { echo "$1"; }

# Thaw teg SDK only if our sentinel value is present. Any other value (0, a
# real cloud version, or something a different tool wrote) is left alone.
if [ -f "$TEG_SP" ]; then
  cur=$(grep 'pref_local_max_version' "$TEG_SP" 2>/dev/null \
        | sed -E 's|.*value="([^"]*)".*|\1|' | head -n1)
  if [ "$cur" = "$TEG_MAX_VALUE" ]; then
    # Restore what was there before the freeze, not 0. Unfreeze has always read
    # this file; uninstalling hard-coded 0, so removing the module could
    # permanently drop a version the user had pinned themselves.
    restore_value=0
    if [ -f "$ORIGINAL_FILE" ]; then
      saved=$(tr -d ' \r\n' < "$ORIGINAL_FILE" 2>/dev/null)
      case "$saved" in
        ''|*[!0-9]*) ;;                    # not a number: keep the fallback
        *) restore_value="$saved" ;;
      esac
    fi
    ui_print "- Thawing teg SDK (pref_local_max_version -> $restore_value)"
    am force-stop "$PKG" 2>/dev/null || true
    uid=$(stat -c '%u' "$TEG_SP" 2>/dev/null)
    gid=$(stat -c '%g' "$TEG_SP" 2>/dev/null)
    tmp="$TEG_SP.jedit-uninst.$$"
    if sed -E 's|(<long name="pref_local_max_version" value=")[^"]*(")|\1'"$restore_value"'\2|' \
         "$TEG_SP" > "$tmp" 2>/dev/null; then
      [ -n "$uid" ] && [ -n "$gid" ] && chown "$uid:$gid" "$tmp" 2>/dev/null || true
      chmod 660 "$tmp" 2>/dev/null || true
      mv -f "$tmp" "$TEG_SP" 2>/dev/null || rm -f "$tmp"
      command -v restorecon >/dev/null 2>&1 && restorecon "$TEG_SP" 2>/dev/null || true
      # Read back: a rewrite that silently did nothing would leave the freeze
      # in place after the module that explains it is gone.
      after=$(grep 'pref_local_max_version' "$TEG_SP" 2>/dev/null \
              | sed -E 's|.*value="([^"]*)".*|\1|' | head -n1)
      if [ "$after" != "$restore_value" ]; then
        ui_print "! pref_local_max_version is '$after' after the rewrite (wanted '$restore_value')"
        ui_print "! set it by hand in $TEG_SP before rebooting"
      fi
    else
      rm -f "$tmp"
      ui_print "! sed failed; leaving teg SP untouched"
    fi
  fi
fi

if [ -d "$DATA_ROOT" ]; then
  ui_print "- Removing $DATA_ROOT (backups, history, stage)"
  rm -rf "$DATA_ROOT"
fi

ui_print "- JoyoseEdit uninstall complete"
