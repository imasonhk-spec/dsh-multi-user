#!/usr/bin/env bash
# =============================================================================
# DSH 自包含插件安装器（模板，打包时替换 @TOKEN@）
#
# 实现规格：
#   #4  默认不自带 DSH 底座；--with-base 时从 dsh 仓 Release 拉取
#   #6  venv 已精简（无 CUDA）
#   #7  安装到宿主 profile + 所有已存在账号
#   #9  共享服务已 active -> 跳过；inactive/failed -> 重写并重启
#   #10 密钥模板 + 现场生成
# =============================================================================
set -euo pipefail

PKG_NAME="dsh-multi-user"
PKG_VERSION="1.2.0"
PKG_KIND="plugin"
PLUGIN_DIR="dsh-multi-user"
SERVICES=""
PORTS=""
HAS_VENV="0"
HAS_NODE="0"
HAS_HARNESS="0"
BASE_REPO="imasonhk-spec/dsh"
BASE_TAG="v0.2.0"

DSH_HOME="${DSH_HOME:-}"
# 自动探测 DSH 根目录：优先环境变量 -> 目标用户的 ~/.dsh -> 常见位置
if [ -z "$DSH_HOME" ]; then
  for cand in "${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)/.dsh}" \
              "$HOME/.dsh" \
              /home/lgsj/.dsh; do
    [ -n "$cand" ] && [ -d "$cand/profiles/web" ] && { DSH_HOME="$cand"; break; }
  done
fi
[ -z "$DSH_HOME" ] && DSH_HOME="$HOME/.dsh"
PROFILE_DIR="$DSH_HOME/profiles/web"
USERS_DIR="$DSH_HOME/multi-user/users"
# DSH 属主（用于 chown，避免 root 装完 lgsj 读不了）
DSH_OWNER="${DSH_OWNER:-$(stat -c '%U:%G' "$DSH_HOME" 2>/dev/null || echo "$(id -un):$(id -gn)")}"
PAYLOAD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/PAYLOAD"

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; CYA=$'\033[36m'; RST=$'\033[0m'
ok(){ echo "${GREEN}  ✓${RST} $*"; }
warn(){ echo "${YEL}  !${RST} $*"; }
err(){ echo "${RED}  ✗${RST} $*" >&2; }
step(){ echo; echo "${CYA}==> $*${RST}"; }

WITH_BASE=0; SKIP_RESTART=0; DRY=0; FORCE=0; PORT_BASE=""
for a in "$@"; do
  case $a in
    --with-base) WITH_BASE=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    --port-base=*) PORT_BASE="${a#*=}" ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
  esac
done

# 端口冲突检查（新机器上 3080/3082 常被别的服务占用）
check_port(){
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p$" && return 1
  fi
  return 0
}
for p in $PORTS; do
  if ! check_port "$p"; then
    warn "端口 $p 已被占用"
    if [ -n "$PORT_BASE" ]; then
      newp=$(( PORT_BASE + (p % 100) ))
      warn "  按 --port-base=$PORT_BASE 映射为 $newp"
    else
      warn "  若安装失败，请用 --port-base=<基址> 错开端口，例如 --port-base=4000"
    fi
  fi
done

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    err "需要 root 或 sudo"; exit 1
  fi
fi

gen_secret(){ openssl rand -hex "${1:-24}" 2>/dev/null || head -c "${1:-24}" /dev/urandom | xxd -p | head -c $(( ${1:-24}*2 )); }

# =============================================================================
step "0. 环境检查"
# =============================================================================
if [ ! -d "$PROFILE_DIR" ]; then
  if [ "$WITH_BASE" = "1" ]; then
    warn "未检测到 DSH（$PROFILE_DIR），将先安装底座"
    install_base
  else
    err "未检测到 DSH 安装：$PROFILE_DIR 不存在"
    echo
    echo "  这是一台没有 DSH 的机器。本包只含插件，不含 DSH 底座。"
    echo "  请二选一："
    echo "    1) 先安装 dsh 底座： https://github.com/$BASE_REPO/releases/tag/$BASE_TAG"
    echo "    2) 重跑本安装器并加 --with-base，自动拉取底座"
    exit 1
  fi
fi
ok "DSH profile: $PROFILE_DIR"

command -v systemctl >/dev/null && ok "systemd 可用" || warn "无 systemd，服务不会自启"

if [ "$HAS_VENV" = "1" ]; then
  command -v python3 >/dev/null || { err "venv 需要 python3"; exit 1; }
  ok "python3: $(python3 -V 2>&1)"
fi

# =============================================================================
install_base(){
  step "安装 DSH 底座（从 $BASE_REPO@$BASE_TAG）"
  local tmp; tmp=$(mktemp -d)
  local url="https://github.com/$BASE_REPO/releases/download/$BASE_TAG/dsh-base-${BASE_TAG#v}.tar.gz"
  local mirror="https://gh-proxy.com/$url"
  echo "  下载 $url"
  if curl -fL --retry 3 -o "$tmp/base.tar.gz" "$url" 2>/dev/null; then
    ok "直连下载成功"
  elif curl -fL --retry 3 -o "$tmp/base.tar.gz" "$mirror" 2>/dev/null; then
    ok "镜像下载成功"
  else
    err "底座下载失败，请手动下载后解包运行其 install.sh"; exit 1
  fi
  tar -xzf "$tmp/base.tar.gz" -C "$tmp"
  bash "$tmp"/install.sh --skip-restart
  rm -rf "$tmp"
}

# =============================================================================
step "1. 安装插件文件"
# =============================================================================
install_plugin_to(){
  local target_profile="$1" label="$2"
  local nm="$target_profile/node_modules"
  [ -d "$nm" ] || { warn "  $label 无 node_modules，跳过"; return 0; }
  if [ "$DRY" = "1" ]; then ok "  [dry] would install to $label"; return 0; fi

  if [ -n "$PLUGIN_DIR" ] && [ -d "$PAYLOAD/plugin" ]; then
    for pd in "$PAYLOAD"/plugin/*/; do
      local bn; bn=$(basename "$pd")
      # 判定目标命名空间：@local/* 还是顶层
      if echo "$PLUGIN_DIR" | grep -q '^@local/'; then
        mkdir -p "$nm/@local"
        rm -rf "$nm/@local/$bn"
        cp -a "$pd" "$nm/@local/$bn"
      else
        rm -rf "$nm/$bn"
        cp -a "$pd" "$nm/$bn"
      fi
    done
    # 权限：插件目录必须归 DSH 属主，否则 harness 读不了
    if [ "$(id -u)" -eq 0 ] && [ -n "$DSH_OWNER" ]; then
      chown -R "$DSH_OWNER" "$nm/@local" 2>/dev/null || true
      [ -n "$PLUGIN_DIR" ] && case "$PLUGIN_DIR" in
        @local/*) : ;;
        *) chown -R "$DSH_OWNER" "$nm/$PLUGIN_DIR" 2>/dev/null || true ;;
      esac
    fi
    ok "  $label: $(ls "$PAYLOAD/plugin" | tr '\n' ' ')"
  fi
}

install_plugin_to "$PROFILE_DIR" "宿主 profile"

# 规格 #7：扇出到所有已存在账号
if [ -d "$USERS_DIR" ]; then
  for u in "$USERS_DIR"/*/; do
    acct=$(basename "$u")
    up="$u/home/profiles/web"
    [ -d "$up" ] || continue
    install_plugin_to "$up" "账号 $acct"
  done
else
  warn "无多用户目录 $USERS_DIR"
fi

# =============================================================================
step "2. Python venv（如含）"
# =============================================================================
if [ "$HAS_VENV" = "1" ] && [ -d "$PAYLOAD/venv" ]; then
  VENV_DST="$DSH_HOME/raganything/venv"
  if [ -d "$VENV_DST" ] && [ "$FORCE" != "1" ]; then
    warn "venv 已存在，跳过（--force 可覆盖）：$VENV_DST"
  else
    if [ "$DRY" = "1" ]; then ok "  [dry] would install venv -> $VENV_DST"
    else
      mkdir -p "$(dirname "$VENV_DST")"
      rm -rf "$VENV_DST"
      cp -a "$PAYLOAD/venv" "$VENV_DST"
      # 修绝对路径：包内路径 -> 目标路径
      sed -i "s|^home = .*|home = $VENV_DST|" "$VENV_DST/pyvenv.cfg" 2>/dev/null || true
      ok "  venv -> $VENV_DST ($(du -sm "$VENV_DST" | cut -f1) MB)"
    fi
  fi
fi

# =============================================================================
step "3. 后台服务"
# =============================================================================
fix_shared_service(){
  local name="$1"
  local state; state=$(systemctl is-active "$name" 2>/dev/null || true)
  case "$state" in
    active)
      ok "  $name: 已运行，跳过（规格 #9）"; return 0 ;;
    activating)
      warn "  $name: 正在启动，等待..."; sleep 3
      [ "$(systemctl is-active "$name" 2>/dev/null)" = "active" ] && { ok "  $name: 已起"; return 0; } ;;
  esac
  # inactive / failed / unknown -> 重写并启动
  warn "  $name: 状态=$state，重写 unit 并重启"
  [ "$DRY" = "1" ] && return 0
  if [ -f "$PAYLOAD/services/$name.service" ]; then
    $SUDO cp "$PAYLOAD/services/$name.service" "/etc/systemd/system/$name.service"
  fi
  if [ -d "$PAYLOAD/services/$name.service.d" ]; then
    $SUDO mkdir -p "/etc/systemd/system/$name.service.d"
    $SUDO cp -a "$PAYLOAD/services/$name.service.d/." "/etc/systemd/system/$name.service.d/"
  fi
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$name" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$name" >/dev/null 2>&1 || true
  sleep 2
  if [ "$(systemctl is-active "$name" 2>/dev/null)" = "active" ]; then
    ok "  $name: 已修复并启动"
  else
    err "  $name: 启动失败，见 journalctl -u $name -n 30"
  fi
}

if [ -n "$SERVICES" ] && [ -d "$PAYLOAD/services" ]; then
  # 先装 app 目录
  for a in "$PAYLOAD"/services/app/*/; do
    [ -d "$a" ] || continue
    bn=$(basename "$a")
    tgt="/opt/dsh-svc/$bn"
    [ "$DRY" = "1" ] && { ok "  [dry] app $bn -> $tgt"; continue; }
    $SUDO mkdir -p "$(dirname "$tgt")"
    $SUDO rm -rf "$tgt"; $SUDO cp -a "$a" "$tgt"
    ok "  app $bn -> $tgt"
  done

  # 再装 unit
  for s in $SERVICES; do
    fix_shared_service "$s"
  done
else
  warn "本包不含后台服务"
fi

# =============================================================================
step "4. 渲染配置与密钥（现场生成，规格 #10）"
# =============================================================================
if [ -d "$PAYLOAD/services/env" ]; then
  mkdir -p "$DSH_HOME/publish-env"
  for tmpl in "$PAYLOAD"/services/env/*.example; do
    [ -f "$tmpl" ] || continue
    bn=$(basename "$tmpl" .example)
    dst="$DSH_HOME/publish-env/$bn"
    # 实际渲染位置：优先已存在的同名真实文件
    real="/home/$(id -un)/.dsh/$bn"
    if [ "$DRY" = "1" ]; then ok "  [dry] would render $bn"; continue; fi
    if [ -f "$dst" ] && [ "$FORCE" != "1" ]; then ok "  $bn: 已存在，保留"; continue; fi
    cp "$tmpl" "$dst"
    # 把 __GEN__ 替换成随机值
    while IFS= read -r line; do
      case "$line" in
        *=__GEN__)
          k="${line%%=*}"
          v=$(gen_secret 24)
          sed -i "s|^${k}=__GEN__$|${k}=${v}|" "$dst"
          ;;
      esac
    done < "$tmpl"
    chmod 600 "$dst"
    ok "  $bn: 已生成（chmod 600）"
  done
fi

# =============================================================================
step "5. 重启 DSH 使插件生效"
# =============================================================================
if [ "$SKIP_RESTART" = "0" ] && [ "$DRY" = "0" ]; then
  if systemctl is-enabled dsh-web >/dev/null 2>&1 || systemctl list-units --all | grep -q dsh-web; then
    $SUDO systemctl restart dsh-web
    sleep 4
    # 多用户网关重启后不自起，需触发一次 login（9.9 的已知行为）
    if systemctl is-active dsh-web >/dev/null 2>&1; then
      ok "dsh-web 已重启"
    else
      warn "dsh-web 未起来，见 journalctl -u dsh-web -n 50"
    fi
  else
    warn "无 dsh-web.service，跳过重启"
  fi
else
  warn "跳过重启"
fi

# =============================================================================
step "完成"
# =============================================================================
echo "  $PKG_NAME $PKG_VERSION 安装完成"
[ -n "$PORTS" ] && echo "  端口: $PORTS"
echo "  安装位置: 宿主 profile + $( [ -d "$USERS_DIR" ] && ls -1 "$USERS_DIR" | wc -l || echo 0 ) 个账号"
echo
echo "  验证："
echo "    systemctl status ${SERVICES%% *} 2>/dev/null | head -5"
echo "    浏览器打开 DSH，查看对应面板是否出现"
