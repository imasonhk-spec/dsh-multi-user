#!/usr/bin/env bash
# dsh-multi-user — portable installer.
#
# Installs the gateway plugin into a DSH profile and (optionally) points the
# machine's existing reverse proxy at it. Every step is idempotent: running it
# twice is safe and produces no duplicate bundle entries.
#
# Usage:
#   SUDO_PW='<pw>' ./install.sh                    # auto-detect everything
#   DSH_ROOT=/path DSH_HOME=/path PROFILE=web ./install.sh
#   WIRE_NGINX=no RESTART=no ./install.sh          # install only, change nothing else
#
# Environment knobs:
#   DSH_ROOT      DSH installation root (the directory that contains apps/cli)
#   DSH_HOME      harness home (default ~/.dsh)
#   PROFILE       DSH profile to install into (default web)
#   GATEWAY_PORT  gateway listen port (default 3090)
#   DSH_WEB_TOKEN launch token to pin on the host instance (generated when absent)
#   WIRE_NGINX    auto|yes|no  point the existing proxy at the gateway (default auto)
#   RESTART       yes|no       restart the DSH service after installing (default yes)
#   SUDO_PW       sudo password for systemd/nginx steps
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="dsh-multi-user"
PKG_VERSION="1.1.0"
TGZ="$HERE/plugin/${PKG_NAME}-${PKG_VERSION}.tgz"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_PREFIX="[dsh-multi-user]"

say()  { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
warn() { printf '%s WARN: %s\n' "$LOG_PREFIX" "$*" >&2; }
die()  { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required on PATH"

# ── 0. locate DSH ────────────────────────────────────────────────────────────
PROFILE="${PROFILE:-web}"
GATEWAY_PORT="${GATEWAY_PORT:-3090}"

detect_dsh_root() {
  if [ -n "${DSH_ROOT:-}" ]; then printf '%s' "$DSH_ROOT"; return; fi
  # The service that serves the web UI knows its own working directory.
  for unit in dsh-web.service dsh.service; do
    if command -v systemctl >/dev/null 2>&1; then
      wd="$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)"
      if [ -n "$wd" ] && [ -f "$wd/apps/cli/src/bin.ts" ]; then printf '%s' "$wd"; return; fi
    fi
  done
  # Fall back to a shallow search of the usual spots.
  for base in "$HOME" /opt /srv /usr/local; do
    found="$(find "$base" -maxdepth 3 -name 'deepseek-harness*' -type d -print -quit 2>/dev/null || true)"
    if [ -n "$found" ] && [ -f "$found/apps/cli/src/bin.ts" ]; then printf '%s' "$found"; return; fi
  done
}

DSH_ROOT="${DSH_ROOT:-$(detect_dsh_root || true)}"
[ -n "$DSH_ROOT" ] && [ -f "$DSH_ROOT/apps/cli/src/bin.ts" ] \
  || die "could not locate the DSH installation root; set DSH_ROOT=/path/to/deepseek-harness"
DSH_ROOT="$(cd "$DSH_ROOT" && pwd)"

if [ -n "${DSH_HOME:-}" ]; then
  :
elif command -v systemctl >/dev/null 2>&1 && systemctl show dsh-web.service -p Environment --value 2>/dev/null | grep -q 'DSH_HOME='; then
  DSH_HOME="$(systemctl show dsh-web.service -p Environment --value | tr ' ' '\n' | sed -n 's/^DSH_HOME=//p' | head -1)"
else
  DSH_HOME="$HOME/.dsh"
fi
DSH_HOME="$(cd "$DSH_HOME" 2>/dev/null && pwd || printf '%s' "$DSH_HOME")"

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
say "DSH root   : $DSH_ROOT"
say "harness home: $DSH_HOME"
say "profile    : $PROFILE  ($PROFILE_DIR)"
say "gateway    : 0.0.0.0:$GATEWAY_PORT"

[ -f "$TGZ" ] || die "package not found: $TGZ"

# pnpm pins a `file:` dependency to the absolute path of the tarball it was
# added from. Delete or move the directory you unpacked the portable bundle into
# and the *next* install dies inside pnpm with ENOENT: it tries to materialise
# the old path before it will accept the new one. Copying the tarball to a
# stable location under $DSH_HOME removes that coupling — the recorded path
# survives upgrades, relocation and cleanup of the download directory.
PLUGIN_STORE="$DSH_HOME/multi-user/plugin"
mkdir -p "$PLUGIN_STORE"
STABLE_TGZ="$PLUGIN_STORE/$(basename "$TGZ")"
cp -f "$TGZ" "$STABLE_TGZ"
say "plugin store: $STABLE_TGZ"

# `dsh` may be exposed as a bin (pnpm-managed) or only through the repo script.
run_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    ( cd "$DSH_ROOT" && dsh "$@" )
  elif command -v pnpm >/dev/null 2>&1; then
    ( cd "$DSH_ROOT" && pnpm --silent dsh "$@" )
  else
    die "neither 'dsh' nor 'pnpm' is on PATH"
  fi
}

# ── 1. back up the current profile manifest ──────────────────────────────────
mkdir -p "$PROFILE_DIR"
if [ -f "$PROFILE_DIR/package.json" ]; then
  cp -a "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-dshmu-$STAMP"
  say "backed up profile package.json -> package.json.bak-dshmu-$STAMP"
fi
[ -f "$PROFILE_DIR/cordis.patch.yml" ] && cp -a "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml.bak-dshmu-$STAMP"
# One backup per run adds up quickly; the two most recent are all anyone needs.
ls -1t "$PROFILE_DIR"/package.json.bak-dshmu-* 2>/dev/null | tail -n +3 | xargs -r rm -f 2>/dev/null || true
ls -1t "$PROFILE_DIR"/cordis.patch.yml.bak-dshmu-* 2>/dev/null | tail -n +3 | xargs -r rm -f 2>/dev/null || true

# If an earlier install recorded a tarball path that has since disappeared,
# pnpm refuses to reconcile the manifest and the add fails before it starts.
# Drop the stale specifier so the add below can succeed.
if [ -f "$PROFILE_DIR/package.json" ]; then
  stale_spec="$(node -e '
const fs = require("node:fs")
const [manifestPath, name] = process.argv.slice(1)
let manifest
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) } catch { process.exit(0) }
const spec = manifest?.dependencies?.[name]
if (typeof spec !== "string" || !spec.startsWith("file:")) process.exit(0)
const target = spec.replace(/^file:/, "")
// pnpm may store it relative to the profile directory.
const resolved = target.startsWith("/") ? target : require("node:path").resolve(require("node:path").dirname(manifestPath), target)
if (!fs.existsSync(resolved)) console.log(spec)
' "$PROFILE_DIR/package.json" "$PKG_NAME" 2>/dev/null || true)"
  if [ -n "$stale_spec" ]; then
    warn "recorded dependency points at a path that no longer exists: $stale_spec"
    warn "removing the stale specifier so the reinstall can proceed"
    ( cd "$PROFILE_DIR" && pnpm remove "$PKG_NAME" --reporter=append-only >/dev/null 2>&1 || true )
  fi
fi

# pnpm resolves a `file:` dependency by *specifier*. Ship new content under an
# unchanged version and it happily keeps the previously linked copy — you edit
# the source, "install" cleanly, and the old behaviour is still there. Compare a
# content hash and force a re-link whenever the tarball actually changed.
INSTALLED_HASH_FILE="$PLUGIN_STORE/.installed-sha256"
tgz_sha() {
  node -e '
const fs = require("node:fs")
const crypto = require("node:crypto")
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))
' "$1"
}
TGZ_SHA="$(tgz_sha "$STABLE_TGZ")"
PREV_SHA="$(cat "$INSTALLED_HASH_FILE" 2>/dev/null || true)"
if [ "$TGZ_SHA" != "$PREV_SHA" ]; then
  if [ -n "$PREV_SHA" ]; then
    warn "plugin content changed under the same version (${PREV_SHA:0:12} -> ${TGZ_SHA:0:12})"
  fi
  warn "forcing a re-link so the installed copy matches this tarball"
  ( cd "$PROFILE_DIR" && pnpm remove "$PKG_NAME" --reporter=append-only >/dev/null 2>&1 || true )
fi

# ── 2. install the plugin ────────────────────────────────────────────────────
say "installing $PKG_NAME $PKG_VERSION ..."
if ! run_dsh plugin --profile "$PROFILE" add "$STABLE_TGZ"; then
  die "plugin installation failed (see the pnpm output above)"
fi
printf '%s\n' "$TGZ_SHA" > "$INSTALLED_HASH_FILE"

# The bundle list is reconciled by dsh itself; verify no duplicate crept in.
dupes="$(node -e '
const fs = require("node:fs")
const file = process.argv[1]
if (!fs.existsSync(file)) { console.log("0"); process.exit(0) }
const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
const bundles = manifest?.dsh?.profile?.bundles ?? []
console.log(String(bundles.filter((b) => b === "dsh-multi-user").length))
' "$PROFILE_DIR/package.json")"
if [ "$dupes" != "1" ]; then
  warn "dsh.profile.bundles lists dsh-multi-user $dupes times (expected exactly 1)"
  node -e '
const fs = require("node:fs")
const file = process.argv[1]
const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
const seen = new Set()
const bundles = (manifest?.dsh?.profile?.bundles ?? []).filter((b) => (seen.has(b) ? false : seen.add(b)))
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
' "$PROFILE_DIR/package.json"
  say "deduplicated dsh.profile.bundles"
fi

installed_version="$(node -e '
const fs = require("node:fs")
const p = process.argv[1]
try { console.log(JSON.parse(fs.readFileSync(p, "utf8")).version) } catch { console.log("missing") }
' "$PROFILE_DIR/node_modules/$PKG_NAME/package.json" 2>/dev/null || echo missing)"
if [ "$installed_version" != "$PKG_VERSION" ]; then
  warn "installed package reports version $installed_version (expected $PKG_VERSION)"
else
  say "installed: $PKG_NAME@$installed_version"
fi

# ── 3. pin a launch token on the host instance ───────────────────────────────
# adminHomeMode "host" means the gateway signs in to this very DSH instance on
# the admin's behalf, which needs a stable DSH_WEB_TOKEN.
ENV_FILE="$DSH_HOME/multi-user/gateway.env"
mkdir -p "$DSH_HOME/multi-user"
TOKEN_VALUE="${DSH_WEB_TOKEN:-}"
if [ -z "$TOKEN_VALUE" ]; then
  # Reuse whatever the running service already has so we never rotate it by accident.
  if command -v systemctl >/dev/null 2>&1; then
    TOKEN_VALUE="$(systemctl show dsh-web.service -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^DSH_WEB_TOKEN=//p' | head -1)"
  fi
fi
if [ -z "$TOKEN_VALUE" ]; then
  TOKEN_VALUE="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
  say "generated a new DSH_WEB_TOKEN"
else
  say "reusing the existing DSH_WEB_TOKEN"
fi
umask 077
printf 'DSH_WEB_TOKEN=%s\n' "$TOKEN_VALUE" > "$ENV_FILE"
say "wrote $ENV_FILE (mode 0600)"
have_systemd=no
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files dsh-web.service >/dev/null 2>&1; then
  have_systemd=yes
fi

if [ "$have_systemd" = yes ] && [ -n "${SUDO_PW:-}" ]; then
  unit_env_ok="$(systemctl show dsh-web.service -p Environment --value 2>/dev/null | grep -c 'DSH_WEB_TOKEN=' || true)"
  if [ "$unit_env_ok" = "0" ]; then
    say "adding DSH_WEB_TOKEN to dsh-web.service (EnvironmentFile=$ENV_FILE)"
    dropin=/etc/systemd/system/dsh-web.service.d
    printf '%s\n' "$SUDO_PW" | sudo -S -p '' bash -c "
      set -e
      mkdir -p '$dropin'
      if [ ! -f '$dropin/50-dsh-multi-user.conf' ]; then
        printf '[Service]\nEnvironmentFile=-$ENV_FILE\n' > '$dropin/50-dsh-multi-user.conf'
      fi
      systemctl daemon-reload
    "
    say "systemd drop-in installed at $dropin/50-dsh-multi-user.conf"
  else
    say "dsh-web.service already declares DSH_WEB_TOKEN"
  fi
else
  warn "could not configure the service environment automatically."
  warn "adminHomeMode 'host' needs DSH_WEB_TOKEN in the DSH process environment."
  warn "Either export it before launching DSH, or read $ENV_FILE and add it yourself."
fi

# ── 4. optionally route the existing proxy at the gateway ────────────────────
WIRE_NGINX="${WIRE_NGINX:-auto}"
nginx_routed=no
if [ "$WIRE_NGINX" != "no" ]; then
  nginx_args=("--gateway-port" "$GATEWAY_PORT" "--dsh-port" "${DSH_PORT:-3080}" "--stamp" "$STAMP")
  if [ -n "${SUDO_PW:-}" ]; then
    nginx_args+=("--sudo-pw" "$SUDO_PW")
  fi
  if python3 "$HERE/tools/patch_nginx.py" "${nginx_args[@]}" ; then
    say "reverse proxy now targets the gateway"
    nginx_routed=yes
  else
    warn "nginx was not changed — point your external entry at 0.0.0.0:$GATEWAY_PORT yourself"
  fi
else
  say "WIRE_NGINX=no — leaving the reverse proxy untouched"
fi

# Behind our own proxy every request arrives from 127.0.0.1, so per-IP login
# throttling needs X-Forwarded-For to tell clients apart. Set it only when we
# actually wired a proxy; otherwise leave the header untrusted.
if [ "$nginx_routed" = yes ]; then
  printf 'DSH_MU_TRUST_PROXY=1\n' >> "$ENV_FILE"
  say "enabled DSH_MU_TRUST_PROXY (login throttling now keys off X-Forwarded-For)"
  say "recommended: set listenHost: '127.0.0.1' in the profile patch so the gateway is reachable only through nginx"
fi

# ── 5. restart DSH so the plugin loads ───────────────────────────────────────
RESTART="${RESTART:-yes}"
if [ "$RESTART" = yes ] && [ "$have_systemd" = yes ]; then
  if [ -n "${SUDO_PW:-}" ]; then
    say "restarting dsh-web.service ..."
    printf '%s\n' "$SUDO_PW" | sudo -S -p '' bash -c 'systemctl restart dsh-web.service'
  else
    warn "set SUDO_PW to allow the installer to restart dsh-web.service"
  fi
elif [ "$RESTART" = yes ]; then
  warn "no systemd unit found — restart your DSH process manually to load the plugin"
fi

# ── 6. wait for the gateway and report ──────────────────────────────────────
say "waiting for the gateway on 127.0.0.1:$GATEWAY_PORT ..."
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$GATEWAY_PORT/mu/login" 2>/dev/null; then
    break
  fi
  sleep 1
done

if curl -fsS -o /dev/null "http://127.0.0.1:$GATEWAY_PORT/mu/login" 2>/dev/null; then
  say "gateway is up."
else
  warn "the gateway did not answer within 60s. Check the DSH log:"
  warn "  journalctl -u dsh-web.service -n 80 --no-pager | grep dsh-multi-user"
fi

cat <<EOF

$LOG_PREFIX done.

  管理控制台  http://<本机IP>:$GATEWAY_PORT/mu/admin
  登录入口    http://<本机IP>:$GATEWAY_PORT/mu/login

  初始管理员账号见：$DSH_HOME/multi-user/INITIAL_ADMIN.txt
  （首次启动自动生成；登录后请立即改密并删除该文件。）

  回滚：$HERE/uninstall.sh
EOF
