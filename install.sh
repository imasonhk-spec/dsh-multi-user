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

WITH_BASE=0; SKIP_RESTART=0; DRY=0; FORCE=0; PORT_BASE=""; IGNORE_APT=0
for a in "$@"; do
  case $a in
    --with-base) WITH_BASE=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    --ignore-apt) IGNORE_APT=1 ;;
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
# 前置函数定义（必须在 step 0 之前，bash 按顺序解析）
# =============================================================================
# 目标用户 home：优先 SUDO_USER -> DSH_HOME 推导 -> 当前用户
# 🔴 直接 root 跑时 SUDO_USER 为空，若退回 $HOME 会得到 /root，
#    导致 /home/lgsj/xxx 被错误重映射到 /root/xxx
resolve_user_home(){
  local u=""
  if [ -n "${SUDO_USER:-}" ]; then
    u="$SUDO_USER"
  elif [ -n "${DSH_HOME:-}" ]; then
    u="$(basename "$(dirname "$DSH_HOME")")"
  fi
  local h=""
  [ -n "$u" ] && h="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)"
  if [ -z "$h" ]; then
    # 从 DSH_HOME 反推（.../home/<user>/.dsh）
    case "$DSH_HOME" in
      /home/*/.dsh) h="${DSH_HOME%/.dsh}" ;;
    esac
  fi
  [ -z "$h" ] && h="$HOME"
  printf '%s' "$h"
}
USER_HOME="$(resolve_user_home)"

install_base(){
  step "安装 DSH 底座（从 $BASE_REPO@$BASE_TAG）"
  local tmp; tmp=$(mktemp -d)
  # 🔴 资产名必须与发布脚本产出的名字一致：`{repo}-{ver}.tar.gz`
  #    本包 BASE_REPO=imasonhk-spec/dsh、BASE_TAG=v0.2.0
  #      => dsh-0.2.0.tar.gz
  #    早期写死成 `dsh-base-${TAG#v}.tar.gz`，而 Release 里实际的资产名叫
  #    `dsh-0.2.0.tar.gz`（dsh 仓的 repo 名就是 dsh，没有 base 后缀），
  #    结果 --with-base 必然 404 —— 新机从零安装第一步就断。
  #    这里改为从包名推导，同时保留旧名做兜底（远端若真叫 dsh-base-* 也能取到）。
  local short="${BASE_REPO##*/}"
  local ver="${BASE_TAG#v}"
  local cands=("${short}-${ver}.tar.gz" "dsh-base-${ver}.tar.gz")
  local got=""
  for c in "${cands[@]}"; do
    local u="https://github.com/$BASE_REPO/releases/download/$BASE_TAG/$c"
    echo "  下载 $u"
    if curl -fL --retry 3 --connect-timeout 15 -o "$tmp/base.tar.gz" "$u" 2>/dev/null; then
      ok "直连下载成功（$c）"; got="1"; break
    fi
    echo "  试镜像 https://gh-proxy.com/$u"
    if curl -fL --retry 3 --connect-timeout 15 -o "$tmp/base.tar.gz" "https://gh-proxy.com/$u" 2>/dev/null; then
      ok "镜像下载成功（$c）"; got="1"; break
    fi
  done
  if [ -z "$got" ]; then
    err "底座下载失败（尝试过: ${cands[*]}）"
    echo "  请手动下载后解包运行其 install.sh："
    echo "    https://github.com/$BASE_REPO/releases/tag/$BASE_TAG"
    exit 1
  fi
  # 下载完整性：GitHub 对大文件会给 HTML 错误页而不是 tar
  if ! tar -tzf "$tmp/base.tar.gz" >/dev/null 2>&1; then
    err "下载到的不是有效 tar.gz（可能是代理错误页），请重试或手动安装"
    ls -la "$tmp/base.tar.gz"; exit 1
  fi
  tar -xzf "$tmp/base.tar.gz" -C "$tmp"
  # 底座的 install.sh 在解出的 <repo>-<ver>/ 目录里
  local idir; idir=$(find "$tmp" -maxdepth 2 -name install.sh -printf '%h\n' | head -1)
  [ -z "$idir" ] && { err "底座包里找不到 install.sh"; exit 1; }
  bash "$idir/install.sh" --skip-restart
  rm -rf "$tmp"
}

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

# 发行版依赖检查（本包不内联这些系统二进制，需目标机 apt 已有）
APT_MISSING=""
for b in ; do
  [ -n "$b" ] || continue
  if [ ! -e "$b" ]; then
    APT_MISSING="$APT_MISSING $b"
  fi
done
if [ -n "$APT_MISSING" ]; then
  warn "目标机缺少以下系统程序（本包不内联，需系统提供）："
  for b in $APT_MISSING; do echo "      $b"; done
  if [ "$IGNORE_APT" = "1" ]; then
    warn "  已指定 --ignore-apt，继续安装（相关服务可能起不来）"
  else
    err "  请先安装：apt-get install -y wine nftables redis-server nginx iproute2"
    err "  或加 --ignore-apt 强行继续"
    exit 2
  fi
fi


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
ACCT_COUNT=0
PENDING_ACCT=0
if [ -d "$USERS_DIR" ]; then
  for u in "$USERS_DIR"/*/; do
    [ -d "$u" ] || continue
    acct=$(basename "$u")
    up="$u/home/profiles/web"
    if [ ! -d "$up" ]; then
      warn "  账号 $acct 无 profiles/web，跳过（该账号可能尚未初始化）"
      continue
    fi
    install_plugin_to "$up" "账号 $acct"
    ACCT_COUNT=$((ACCT_COUNT+1))
  done
  [ "$ACCT_COUNT" -eq 0 ] && PENDING_ACCT=1
else
  # 🔴 新机首次安装时 $USERS_DIR 还不存在：多用户网关注册第一个账号后才会创建。
  #    此时静默跳过会让"已装好"的结论变假 —— 宿主 profile 有插件、账号里没有。
  warn "  无多用户目录 $USERS_DIR（尚未创建任何账号）"
  PENDING_ACCT=1
fi

if [ "$PENDING_ACCT" = "1" ] && [ -n "$PLUGIN_DIR" ]; then
  # 记录待补装，供 accounts-fanout.sh 在多用户网关注册账号后补齐
  mkdir -p "$DSH_HOME/.publish-pending" 2>/dev/null || true
  echo "$PKG_NAME|$PLUGIN_DIR" >> "$DSH_HOME/.publish-pending/fanout.list" 2>/dev/null || true
  warn "  已登记待补装：账号创建后执行 accounts-fanout.sh 即可补齐（不装也行，仅影响账号级面板）"
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
step "3. 还原绝对路径（fs overlay，自包含核心）"
# =============================================================================
# 🔴 关键：systemd unit 里写的是 /usr/local/sbin/xxx、/opt/zhihui、/home/xxx/.dsh/...
#    这类绝对路径。包里按原路径存在 PAYLOAD/fs/ 下，这里原样铺回去。
#    同时做路径前缀重映射：/home/lgsj/.dsh -> 本机 $DSH_HOME，/home/lgsj -> 本机用户 home
#    （目标机的用户名/DSH 根未必和打包机一致）
restore_fs_from_manifest(){
  local mf="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/manifest.json"
  [ -f "$mf" ] || { warn "无 manifest.json"; return 0; }
  command -v python3 >/dev/null || { warn "无 python3，跳过 fs 还原"; return 0; }

  python3 - "$mf" <<'PYEOF' > /tmp/_dsh_fs_plan.$$
import json,sys
m=json.load(open(sys.argv[1]))
for e in m.get("fsEntries",[]):
    print(e["src"]+"\t"+e["dst"]+"\t"+e.get("type","file"))
PYEOF

  local bakdir="/var/backups/dsh-${PKG_NAME}-${PKG_VERSION}"
  local count=0
  while IFS=$'\t' read -r src dst typ; do
    [ -n "$src" ] || continue
    local rel="${dst#fs/}"
    local tgt="/$rel"
    if [ "$rel" = "home/lgsj/.dsh" ] || case "$rel" in home/lgsj/.dsh/*) true;; *) false;; esac; then
      tgt="$DSH_HOME${rel#home/lgsj/.dsh}"
    elif [ "$rel" = "home/lgsj" ] || case "$rel" in home/lgsj/*) true;; *) false;; esac; then
      tgt="$USER_HOME${rel#home/lgsj}"
    fi
    if [ "$DRY" = "1" ]; then ok "  [dry] $rel -> $tgt"; continue; fi
    # 包内缺件判定：悬空软链接也算存在（-e 对悬空链接为假）
    if [ ! -e "$PAYLOAD/$dst" ] && [ ! -L "$PAYLOAD/$dst" ]; then
      warn "  缺件 $dst"; continue
    fi
    $SUDO mkdir -p "$(dirname "$tgt")"
    if [ -e "$tgt" ] && [ ! -d "$tgt" ]; then
      $SUDO mkdir -p "$bakdir$(dirname "$tgt")"
      $SUDO cp -a "$tgt" "$bakdir$tgt" 2>/dev/null || true
    fi
    if [ "$typ" = "symlink" ]; then
      local lk; lk="$(readlink "$PAYLOAD/$dst")"
      $SUDO rm -f "$tgt"
      $SUDO ln -sfn "$lk" "$tgt"
    elif [ "$typ" = "dir" ]; then
      $SUDO mkdir -p "$tgt"
      $SUDO cp -a "$PAYLOAD/$dst/." "$tgt/"
    else
      $SUDO cp -af "$PAYLOAD/$dst" "$tgt"
    fi
    count=$((count+1))
    ok "  $src -> $tgt"
  done < /tmp/_dsh_fs_plan.$$
  rm -f /tmp/_dsh_fs_plan.$$
  ok "  fs overlay: 共还原 $count 项"
}

restore_fs_from_manifest

# =============================================================================
step "4. 后台服务"
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
    # 路径重映射：/home/lgsj/.dsh -> $DSH_HOME，/home/lgsj -> $USER_HOME
    sed -e "s|/home/lgsj/\.dsh|$DSH_HOME|g" \
        -e "s|/home/lgsj|$USER_HOME|g" \
        "$PAYLOAD/services/$name.service" > /tmp/_dsh_svc_unit.$$
    # 现场生成 __GEN__ 密钥
    while grep -q '__GEN__' /tmp/_dsh_svc_unit.$$ 2>/dev/null; do
      local v; v=$(gen_secret 32)
      sed -i "0,/__GEN__/s|__GEN__|$v|" /tmp/_dsh_svc_unit.$$
    done
    $SUDO cp /tmp/_dsh_svc_unit.$$ "/etc/systemd/system/$name.service"
    chmod 644 /tmp/_dsh_svc_unit.$$ 2>/dev/null || true
    rm -f /tmp/_dsh_svc_unit.$$
  fi
  if [ -d "$PAYLOAD/services/$name.service.d" ]; then
    $SUDO mkdir -p "/etc/systemd/system/$name.service.d"
    for f in "$PAYLOAD/services/$name.service.d"/*; do
      [ -f "$f" ] || continue
      sed -e "s|/home/lgsj/\.dsh|$DSH_HOME|g" -e "s|/home/lgsj|$USER_HOME|g" \
        "$f" > /tmp/_dsh_drop.$$
      $SUDO cp /tmp/_dsh_drop.$$ "/etc/systemd/system/$name.service.d/$(basename "$f")"
      rm -f /tmp/_dsh_drop.$$
    done
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
step "5. 渲染配置与密钥（现场生成，规格 #10）"
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
step "5b. JSON 配置密钥现场生成"
# =============================================================================
# 🔴 打包时 sanitize_json_secrets() 会把 config.json 里的 token/apiKey 等字段
#    脱敏成字符串 "__GEN__"。但安装器早期只处理 systemd unit 与 KEY=__GEN__
#    形式的 env 文件，JSON 里的 "__GEN__" 被原样留下 —— 后果是 raganything
#    sidecar 拿着字面量 "__GEN__" 当 token 启动：进程活着、端口通、健康检查过，
#    但 /shared/* 一律 401，前端表现为「知识库未连接」，且日志里没有任何报错。
#    这里按 manifest 的 fsEntries 精确回填（不做全盘 grep，避免误伤大目录）。
render_json_secrets(){
  local mf="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/manifest.json"
  [ -f "$mf" ] || { warn "无 manifest.json，跳过"; return 0; }
  command -v python3 >/dev/null || { warn "无 python3，跳过 JSON 密钥生成"; return 0; }
  if [ "$DRY" = "1" ]; then ok "  [dry] would render JSON __GEN__ under $DSH_HOME"; return 0; fi

  local out
  out=$(python3 - "$mf" "$PAYLOAD" "$DSH_HOME" "$USER_HOME" <<'PYEOF'
import json, os, re, secrets, sys

mf, payload, dsh_home, user_home = sys.argv[1:5]
try:
    m = json.load(open(mf))
except Exception as e:
    print("ERR\tmanifest 解析失败: %s" % e); sys.exit(0)

dsh_home = dsh_home.rstrip("/")
user_home = user_home.rstrip("/")

def map_tgt(dst):
    """与 restore_fs_from_manifest() 的 bash 逻辑严格一致。"""
    rel = dst[3:] if dst.startswith("fs/") else dst.lstrip("/")
    if rel == "home/lgsj/.dsh" or rel.startswith("home/lgsj/.dsh/"):
        return dsh_home + rel[len("home/lgsj/.dsh"):]
    if rel == "home/lgsj" or rel.startswith("home/lgsj/"):
        return user_home + rel[len("home/lgsj"):]
    return "/" + rel

# 只处理本次包真的带来的 .json（config.json / settings.json / *.credentials.json ...）
targets, seen = [], set()
for e in m.get("fsEntries", []):
    dst = e.get("dst", "")
    if not dst.lower().endswith(".json"):
        continue
    if e.get("type", "file") != "file":
        continue
    tgt = map_tgt(dst)
    if tgt in seen:
        continue
    seen.add(tgt)
    if os.path.isfile(tgt):
        targets.append(tgt)

if not targets:
    print("NONE\t0"); sys.exit(0)

# 秘钥字段名 —— 与包端 sanitize_json_secrets() 的 SECRET_KEY_RE 保持同源
KEY_RE = re.compile(
    r"(?i)^(token|access_token|refresh_token|api_?key|apikey|secret|client_secret|"
    r"password|passwd|salt|private_?key|auth_?token|session_?key|jwt_?secret)$")
# 值为 "__GEN__" 的字段一律替换；不依赖字段名（有些配置用自定义键名）
GEN = "__GEN__"
total = 0

def walk(o, depth=0):
    global total
    if depth > 12:
        return
    if isinstance(o, dict):
        for k, v in list(o.items()):
            if isinstance(v, str) and v.strip() == GEN:
                o[k] = secrets.token_hex(32)     # 64 位 hex，与原 token 形态一致
                total += 1
            elif isinstance(v, dict):
                walk(v, depth + 1)
            elif isinstance(v, list):
                for it in v:
                    if isinstance(it, dict):
                        walk(it, depth + 1)
    elif isinstance(o, list):
        for it in o:
            walk(it, depth + 1)

for path in targets:
    try:
        raw = open(path, encoding="utf-8").read()
    except Exception:
        continue
    if GEN not in raw:
        continue
    try:
        data = json.loads(raw)
    except Exception:
        # 非严格 JSON（带注释/尾逗号）：退化为纯文本替换
        n = raw.count(GEN)
        txt = re.sub(re.escape(GEN), lambda _m: secrets.token_hex(32), raw)
        try:
            open(path, "w", encoding="utf-8").write(txt)
            print("OK\t%s\t%d\traw" % (path, n))
        except Exception as e:
            print("ERR\t%s\t%s" % (path, e))
        continue
    before = total
    walk(data)
    if total > before:
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print("OK\t%s\t%d\tjson" % (path, total - before))
        except Exception as e:
            print("ERR\t%s\t%s" % (path, e))
PYEOF
)

  local any=0
  while IFS=$'\t' read -r st path cnt mode; do
    [ -n "${st:-}" ] || continue
    case "$st" in
      OK)
        any=1
        # 含密钥的文件收权限，与 env 文件同规格
        $SUDO chmod 600 "$path" 2>/dev/null || true
        ok "  密钥已生成: ${path}（${cnt} 项，${mode}）"
        ;;
      ERR) warn "  ${path}: ${cnt}" ;;
      NONE) : ;;
    esac
  done <<< "$out"
  [ "$any" = "0" ] && ok "  JSON 无 __GEN__ 占位，无需处理"
}

render_json_secrets

# 服务里如果引用了刚生成密钥的那个 JSON，必须重启一次才能读到新值
if [ -n "$SERVICES" ] && [ "$DRY" = "0" ]; then
  for s in $SERVICES; do
    [ "$(systemctl is-active "$s" 2>/dev/null)" = "active" ] || continue
    $SUDO systemctl restart "$s" >/dev/null 2>&1 || true
    ok "  $s: 已重启（加载新密钥）"
  done
  sleep 2
fi

# =============================================================================
step "6. 重启 DSH 使插件生效"
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
echo "  安装位置: 宿主 profile + ${ACCT_COUNT} 个账号"
if [ "$PENDING_ACCT" = "1" ] && [ -n "$PLUGIN_DIR" ]; then
  echo "  ${YEL}注意${RST}: 当前无已初始化账号，账号级面板需在创建账号后跑 accounts-fanout.sh"
fi
echo
echo "  验证："
echo "    systemctl status ${SERVICES%% *} 2>/dev/null | head -5"
echo "    浏览器打开 DSH，查看对应面板是否出现"
