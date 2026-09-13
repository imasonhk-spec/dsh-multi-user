#!/usr/bin/env bash
# dsh-multi-user — portable uninstaller.
#
# Removes the plugin, restores the reverse proxy, and drops the systemd
# drop-in. User data is KEPT by default; pass --purge-data to delete it too.
#
# Usage:
#   SUDO_PW='<pw>' ./uninstall.sh
#   ./uninstall.sh --purge-data
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="dsh-multi-user"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_PREFIX="[dsh-multi-user]"

say()  { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
warn() { printf '%s WARN: %s\n' "$LOG_PREFIX" "$*" >&2; }

PURGE_DATA=no
[ "${1:-}" = "--purge-data" ] && PURGE_DATA=yes

PROFILE="${PROFILE:-web}"
if [ -z "${DSH_HOME:-}" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    DSH_HOME="$(systemctl show dsh-web.service -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^DSH_HOME=//p' | head -1)"
  fi
  DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
fi

detect_dsh_root() {
  if [ -n "${DSH_ROOT:-}" ]; then printf '%s' "$DSH_ROOT"; return; fi
  if command -v systemctl >/dev/null 2>&1; then
    wd="$(systemctl show dsh-web.service -p WorkingDirectory --value 2>/dev/null || true)"
    if [ -n "$wd" ] && [ -f "$wd/apps/cli/src/bin.ts" ]; then printf '%s' "$wd"; return; fi
  fi
  for base in "$HOME" /opt /srv /usr/local; do
    found="$(find "$base" -maxdepth 3 -name 'deepseek-harness*' -type d -print -quit 2>/dev/null || true)"
    if [ -n "$found" ] && [ -f "$found/apps/cli/src/bin.ts" ]; then printf '%s' "$found"; return; fi
  done
}
DSH_ROOT="${DSH_ROOT:-$(detect_dsh_root || true)}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

# ── 1. remove the dependency ─────────────────────────────────────────────────
if [ -n "$DSH_ROOT" ] && [ -d "$PROFILE_DIR" ]; then
  [ -f "$PROFILE_DIR/package.json" ] && cp -a "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-uninstall-$STAMP"
  say "removing $PKG_NAME from profile $PROFILE ..."
  if command -v dsh >/dev/null 2>&1; then
    ( cd "$DSH_ROOT" && dsh plugin --profile "$PROFILE" remove "$PKG_NAME" ) || warn "removal reported an error"
  elif command -v pnpm >/dev/null 2>&1; then
    ( cd "$DSH_ROOT" && pnpm --silent dsh plugin --profile "$PROFILE" remove "$PKG_NAME" ) || warn "removal reported an error"
  else
    warn "neither dsh nor pnpm on PATH; remove the dependency manually"
  fi

  # Belt and braces: dsh reconciles bundles itself, but a leftover entry would
  # crash the loader on the next boot.
  node -e '
const fs = require("node:fs")
const file = process.argv[1]
if (!fs.existsSync(file)) process.exit(0)
const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
const bundles = (manifest?.dsh?.profile?.bundles ?? []).filter((b) => b !== "dsh-multi-user")
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
if (manifest.dependencies !== undefined) delete manifest.dependencies["dsh-multi-user"]
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
' "$PROFILE_DIR/package.json"
  say "profile manifest cleaned"
fi

# ── 2. restore the reverse proxy ─────────────────────────────────────────────
if [ -n "${SUDO_PW:-}" ]; then
  printf '%s\n' "$SUDO_PW" | sudo -S -p '' bash -c '
    set -e
    restored=0
    backup_dir=/etc/nginx/.dshmu-backups
    if [ -d "$backup_dir" ]; then
      for backup in "$backup_dir"/*.bak-dshmu-*; do
        [ -e "$backup" ] || continue
        # dsh-web.bak-dshmu-20260911-073347 -> dsh-web
        base="$(basename "$backup")"
        site="${base%%.bak-dshmu-*}"
        for dir in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
          target="$dir/$site"
          if [ -e "$target" ]; then
            real="$(readlink -f "$target")"
            cp -a "$backup" "$real"
            rm -f "$backup"
            echo "restored $real"
            restored=$((restored+1))
            break
          fi
        done
      done
    fi
    # Sweep any stray backup an older build left inside the include directories.
    for dir in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
      [ -d "$dir" ] || continue
      for stray in "$dir"/*.bak-dshmu-*; do
        [ -e "$stray" ] || continue
        mkdir -p "$backup_dir"
        mv -f "$stray" "$backup_dir/" 2>/dev/null || rm -f "$stray"
        echo "removed stray backup from $dir: $(basename "$stray")"
      done
    done
    if [ "$restored" -gt 0 ]; then
      if nginx -t >/dev/null 2>&1; then
        nginx -s reload && echo "nginx reloaded"
      else
        echo "nginx -t failed after restore; NOT reloading" >&2
      fi
    else
      echo "no dsh-multi-user nginx backup found; proxy left as-is"
    fi
  '
else
  warn "SUDO_PW not set — skipping the nginx restore step"
fi

# ── 3. drop the systemd drop-in ──────────────────────────────────────────────
if [ -n "${SUDO_PW:-}" ]; then
  printf '%s\n' "$SUDO_PW" | sudo -S -p '' bash -c '
    set -e
    dropin=/etc/systemd/system/dsh-web.service.d/50-dsh-multi-user.conf
    if [ -f "$dropin" ]; then
      rm -f "$dropin"
      systemctl daemon-reload
      echo "removed $dropin"
    fi
  '
fi

# ── 4. data ─────────────────────────────────────────────────────────────────
DATA_DIR="$DSH_HOME/multi-user"
# The plugin store is an install artifact, not user data: always drop it, even
# when the user's accounts are being kept.
if [ -d "$DATA_DIR/plugin" ]; then
  rm -rf "$DATA_DIR/plugin"
  say "removed the plugin store ($DATA_DIR/plugin)"
fi
if [ "$PURGE_DATA" = yes ]; then
  if [ -d "$DATA_DIR" ]; then
    say "purging $DATA_DIR"
    rm -rf "$DATA_DIR"
  fi
else
  say "user data kept at $DATA_DIR (re-run with --purge-data to delete it)"
fi

# ── 5. restart ───────────────────────────────────────────────────────────────
if [ -n "${SUDO_PW:-}" ]; then
  say "restarting dsh-web.service ..."
  printf '%s\n' "$SUDO_PW" | sudo -S -p '' bash -c 'systemctl restart dsh-web.service || true'
else
  warn "restart DSH manually so the plugin unloads"
fi

say "done."
