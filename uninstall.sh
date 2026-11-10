#!/usr/bin/env bash
# DSH 插件卸载器
set -euo pipefail

PKG_NAME="dsh-multi-user"
PKG_VERSION="1.2.1"
PLUGIN_DIR="dsh-multi-user"
SERVICES=""

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
USERS_DIR="$DSH_HOME/multi-user/users"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "==> 卸载 $PKG_NAME $PKG_VERSION"

remove_from(){
  local p="$1" label="$2"
  local nm="$p/node_modules"
  [ -d "$nm" ] || return 0
  for d in "$PLUGIN_DIR"; do
    bn=$(echo "$d" | sed 's|^@local/||; s|.*/||')
    if echo "$d" | grep -q '^@local/'; then
      rm -rf "$nm/@local/$bn" && echo "  ✓ $label: @local/$bn"
    else
      rm -rf "$nm/$bn" && echo "  ✓ $label: $bn"
    fi
  done
}

remove_from "$PROFILE_DIR" "宿主"
if [ -d "$USERS_DIR" ]; then
  for u in "$USERS_DIR"/*/; do
    remove_from "$u/home/profiles/web" "$(basename "$u")"
  done
fi

for s in $SERVICES; do
  if systemctl list-unit-files | grep -q "^$s.service"; then
    $SUDO systemctl stop "$s" 2>/dev/null || true
    $SUDO systemctl disable "$s" 2>/dev/null || true
    $SUDO rm -f "/etc/systemd/system/$s.service"
    $SUDO rm -rf "/etc/systemd/system/$s.service.d"
    echo "  ✓ 服务已移除: $s"
  fi
done
$SUDO systemctl daemon-reload

echo "==> 完成（venv 与数据目录保留，如需清理请手动处理）"
