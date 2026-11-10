#!/usr/bin/env bash
# =============================================================================
# accounts-fanout.sh — 把本已安装的插件补装到"后来才创建"的多用户账号
# =============================================================================
# 背景：规格 #7 要求插件装到「宿主 profile + 所有已存在账号」。
# 但新机首次安装时多用户网关还没注册任何账号，$DSH_HOME/multi-user/users
# 并不存在，此时 install.sh 只能装宿主 profile，并把本包登记进
#   $DSH_HOME/.publish-pending/fanout.list
# 等管理员在网关注册账号后，跑本脚本即可补齐（幂等，可重复执行）。
#
# 用法：
#   bash accounts-fanout.sh              # 补装所有登记过的包
#   bash accounts-fanout.sh --list       # 只看还差什么
#   bash accounts-fanout.sh <包名>        # 只补某个包
# =============================================================================
set -uo pipefail

RST=$'\033[0m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; CYA=$'\033[36m'
ok(){ echo "${GRN}✓${RST} $*"; }
warn(){ echo "${YEL}!${RST} $*"; }
err(){ echo "${RED}✗${RST} $*"; }
info(){ echo "${CYA}·${RST} $*"; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 定位 DSH_HOME（与 install.sh 一致的探测顺序）
if [ -z "${DSH_HOME:-}" ]; then
  for cand in "$HOME/.dsh" /home/*/.dsh; do
    [ -d "$cand" ] && { DSH_HOME="$cand"; break; }
  done
fi
[ -z "${DSH_HOME:-}" ] && { err "找不到 DSH_HOME，请先 export DSH_HOME=..."; exit 1; }

USERS_DIR="$DSH_HOME/multi-user/users"
PENDING="$DSH_HOME/.publish-pending/fanout.list"
LIST_ONLY=0
ONLY=""

for a in "$@"; do  case "$a" in
    --list) LIST_ONLY=1 ;;
    -*) err "未知参数 $a"; exit 2 ;;
    *) ONLY="$a" ;;
  esac
done

# ---- 收集待补装项：登记表 + 当前目录（若本目录就是包解压处） ----
declare -A WANT     # 包名 -> 插件相对名
[[ -f "$PENDING" ]] && while IFS='|' read -r n p; do
  [ -n "${n:-}" ] && [ -n "${p:-}" ] && WANT["$n"]="$p"
done < "$PENDING"

# 若本脚本所在的包里就有 PAYLOAD/plugin，把它也算进来
if [ -d "$SELF_DIR/PAYLOAD/plugin" ] && [ -f "$SELF_DIR/manifest.json" ]; then
  pj=$(python3 - "$SELF_DIR/manifest.json" <<'PY' 2>/dev/null
import json,sys
m=json.load(open(sys.argv[1]))
print(m.get("pluginDir") or "")
PY
)
  nm=$(python3 - "$SELF_DIR/manifest.json" <<'PY' 2>/dev/null
import json,sys
m=json.load(open(sys.argv[1]))
print(m.get("name") or "")
PY
)
  [ -n "$nm" ] && [ -n "$pj" ] && WANT["$nm"]="$pj"
fi

if [ "${#WANT[@]}" -eq 0 ]; then
  ok "没有待补装的插件"
  exit 0
fi

# ---- 列账号 ----
if [ ! -d "$USERS_DIR" ]; then
  warn "还没有任何多用户账号：$USERS_DIR 不存在"
  warn "请先在多用户网关注册账号，然后重跑本脚本"
  echo
  echo "待补装清单（${#WANT[@]} 个）："
  for k in "${!WANT[@]}"; do echo "  - $k  ->  ${WANT[$k]}"; done
  exit 0
fi

mapfile -t ACCTS < <(find "$USERS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
echo "发现 ${#ACCTS[@]} 个账号: ${ACCTS[*]}"

if [ "$LIST_ONLY" = "1" ]; then
  echo
  for k in "${!WANT[@]}"; do
    echo "包 $k -> ${WANT[$k]}"
    for a in "${ACCTS[@]}"; do
      t="$USERS_DIR/$a/home/profiles/web/node_modules/${WANT[$k]}"
      [ -e "$t" ] && echo "    $a: 已装" || echo "    $a: 缺"
    done
  done
  exit 0
fi

# ---- 执行补装 ----
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

DONE_ANY=0
for k in "${!WANT[@]}"; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$k" ] && continue
  pj="${WANT[$k]}"
  src=""
  for c in "$SELF_DIR" "$SELF_DIR/.." /tmp; do
    [ -d "$c/PAYLOAD/plugin" ] && { src="$c/PAYLOAD/plugin"; break; }
  done
  if [ -z "$src" ]; then
    warn "$k: 找不到包内 PAYLOAD/plugin（请在本包解压目录内运行）"
    continue
  fi
  for a in "${ACCTS[@]}"; do
    nm="$USERS_DIR/$a/home/profiles/web/node_modules"
    [ -d "$nm" ] || { warn "  $a: 无 node_modules，跳过"; continue; }
    for pd in "$src"/*/; do
      bn=$(basename "$pd")
      case "$pj" in
        @local/*) $SUDO mkdir -p "$nm/@local"; tgt="$nm/@local/$bn" ;;
        *) tgt="$nm/$bn" ;;
      esac
      $SUDO rm -rf "$tgt"
      $SUDO cp -a "$pd" "$tgt"
      DONE_ANY=1
    done
    ok "  $a: $k -> $pj"
  done
done

# 全部补齐后清掉登记表里的对应条目
if [ "$DONE_ANY" = "1" ] && [ -z "$ONLY" ] && [ -f "$PENDING" ]; then
  : > "$PENDING"
  ok "登记表已清空"
fi

echo
ok "补装完成。重启网关生效：sudo systemctl restart dsh-web"
