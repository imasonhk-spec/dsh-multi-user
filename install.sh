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

# ---------------------------------------------------------------------------
# 鲁棒下载：解决"网络间歇性连不上 release-assets.githubusercontent.com"
#
# 🔴 实测现象（14 号机，2026-11-02）：
#    同一个 URL、同一条命令，第一次 `curl -L` 卡死超时（http=000），
#    隔 30 秒再跑就 200 且完整下完 13.08 MB。
#    更进一步：先取 302 的 Location 再单独打，反而失败；
#    直接 `curl -L` 又成功 —— 说明是**链路抖动**，不是域名被墙、不是 URL 写错。
#    所以不能靠"单次失败就放弃"，必须重试到成功或用尽次数。
#
# 参数：fetch <输出文件> <URL...>   （URL 可以是多个候选，依次尝试）
# 返回：0 = 拿到有效文件；1 = 全失败
# ---------------------------------------------------------------------------
fetch(){
  local out="$1"; shift
  local urls=("$@")
  local try=0
  local conf=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    conf="$(mktemp)"; chmod 600 "$conf"
    printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" > "$conf"
  fi
  for u in "${urls[@]}"; do
    [ -z "$u" ] && continue
    for attempt in 1 2 3 4 5; do
      try=$((try+1))
      echo "    [下载 $attempt/5] $u"
      # 关键参数说明：
      #   --retry-all-errors  连"连接被重置/超时"也重试（默认只重试 5xx）
      #   --speed-limit/-time 60 秒内低于 1 KB/s 视为卡死，主动断开重来
      if [ -n "$conf" ]; then
        curl -sSL --retry 2 --retry-all-errors --retry-delay 2 \
             --connect-timeout 20 --max-time 3600 \
             --speed-limit 1024 --speed-time 60 \
             -K "$conf" -o "$out" "$u" 2>/dev/null
      else
        curl -sSL --retry 2 --retry-all-errors --retry-delay 2 \
             --connect-timeout 20 --max-time 3600 \
             --speed-limit 1024 --speed-time 60 \
             -o "$out" "$u" 2>/dev/null
      fi
      # 🔴 不能只看 curl 返回码：403/404 页面、代理错误页也会"成功"落盘。
      #    gzip 文件必须以 1f 8b 开头，否则一律当失败重来。
      if [ -s "$out" ] && [ "$(head -c2 "$out" | xxd -p)" = "1f8b" ]; then
        [ -n "$conf" ] && rm -f "$conf"
        return 0
      fi
      sleep $(( attempt * 2 ))
    done
  done
  [ -n "$conf" ] && rm -f "$conf"
  return 1
}

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

  # 🔴 私有仓库的下载姿势（实测结论，别走弯路）：
  #    1) 匿名访问：`/releases/download/<tag>/<asset>` 一律 **404**
  #       （GitHub 对私有资源返回 404 而非 401，掩盖存在性 —— 极易误判成
  #        "资产不存在/名字写错"，实测在 14 号机上正是这样卡住的）
  #    2) 带 Authorization 打 `/releases/download/...`：**仍然 404**
  #       —— 该路径是浏览器重定向链，不吃 Bearer 头
  #    3) 唯一有效路径：**API 的 asset 端点**
  #         GET /repos/{owner}/{repo}/releases/tags/{tag}      -> release id
  #         GET /repos/{owner}/{repo}/releases/{id}/assets     -> asset id
  #         GET /repos/{owner}/{repo}/releases/assets/{aid}
  #             -H 'Accept: application/octet-stream'          -> 302 到签名 URL
  #       实测：882 MB 包 3 分钟下完，tar 校验 2826 个条目正常。
  local short="${BASE_REPO##*/}"
  local ver="${BASE_TAG#v}"
  local cands=("${short}-${ver}.tar.gz" "dsh-base-${ver}.tar.gz")

  # 凭据来源优先级：GITHUB_TOKEN 环境变量 > ~/.ghtok > ~/.config/dsh/ghtok > /root/.ghtok
  local tk=""
  for f in "${GITHUB_TOKEN:-}" "$(cat "$HOME/.ghtok" 2>/dev/null)" \
           "$(cat "$HOME/.config/dsh/ghtok" 2>/dev/null)" \
           "$(cat /root/.ghtok 2>/dev/null)"; do
    [ -n "$f" ] && { tk="$f"; break; }
  done
  local got=""
  local dcfg="$tmp/.dl.cfg"

  if [ -n "$tk" ]; then
    ok "已加载 GitHub 凭据（私有仓库）"
    printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/octet-stream"\n' "$tk" > "$dcfg"
    chmod 600 "$dcfg"
    local acfg="$tmp/.api.cfg"
    printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\n' "$tk" > "$acfg"
    chmod 600 "$acfg"

    local rid
    rid=$(curl -sS --max-time 40 -K "$acfg" \
            "https://api.github.com/repos/$BASE_REPO/releases/tags/$BASE_TAG" 2>/dev/null \
          | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [ -n "$rid" ]; then
      ok "release $BASE_TAG id=$rid"
      for c in "${cands[@]}"; do
        local aid
        aid=$(curl -sS --max-time 40 -K "$acfg" \
                "https://api.github.com/repos/$BASE_REPO/releases/$rid/assets" 2>/dev/null \
              | C="$c" python3 -c "
import json,os,sys
want=os.environ.get('C','')
for a in json.load(sys.stdin):
    if a.get('name')==want:
        print(a['id']); break
" 2>/dev/null)
        [ -z "$aid" ] && { echo "  资产 $c 不在该 release 中"; continue; }
        echo "  下载 $c（asset id=$aid）"
        if curl -sSL --retry 3 --retry-all-errors --retry-delay 2 \
                --connect-timeout 20 --max-time 3600 \
                --speed-limit 1024 --speed-time 60 \
                -K "$dcfg" -o "$tmp/base.tar.gz" \
                "https://api.github.com/repos/$BASE_REPO/releases/assets/$aid" 2>/dev/null \
           && tar -tzf "$tmp/base.tar.gz" >/dev/null 2>&1; then
          ok "下载完成并校验通过（$c, $(du -sm "$tmp/base.tar.gz" | cut -f1) MB）"
          got="1"; break
        fi
        warn "  $c 下载不完整，换下一个候选"
        rm -f "$tmp/base.tar.gz"
      done
    else
      warn "  取 release 失败（token 权限不足？需要 repo 读权限）"
    fi
  else
    warn "未找到 GitHub 凭据：若是私有仓库会 404（本批仓库已设为 public，通常无需 token）"
  fi

  # 匿名路径（仓库为 public 时走这条；也是无 token 场景的默认路径）
  if [ -z "$got" ]; then
    local urls=()
    for c in "${cands[@]}"; do
      urls+=("https://github.com/$BASE_REPO/releases/download/$BASE_TAG/$c")
      urls+=("https://gh-proxy.com/https://github.com/$BASE_REPO/releases/download/$BASE_TAG/$c")
    done
    if fetch "$tmp/base.tar.gz" "${urls[@]}" \
       && tar -tzf "$tmp/base.tar.gz" >/dev/null 2>&1; then
      ok "下载完成并校验通过（$(du -sm "$tmp/base.tar.gz" | cut -f1) MB）"
      got="1"
    fi
  fi

  if [ -z "$got" ]; then
    err "底座下载失败（已重试多轮）"
    echo "  仓库: https://github.com/$BASE_REPO/releases/tag/$BASE_TAG"
    echo "  可在能上网的机器上手动下载该 tar.gz，拷到本机后执行："
    echo "    tar -xzf <包名>.tar.gz && cd <包名> && ./install.sh"
    exit 1
  fi
  rm -f "$dcfg" "${acfg:-}" 2>/dev/null || true
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
# 🔴 底座包不能做"DSH 是否已安装"的前置检查。
#    实测（2026-11-02，14 号机从零验收）：拿到 dsh-base 包执行 install.sh，
#    第 0 步就因为 $DSH_HOME/profiles/web 不存在而 exit 1，提示
#    「这是一台没有 DSH 的机器。本包只含插件，不含 DSH 底座」—— 
#    而它**本身就是底座**。新机从零装的第一步必然死在这里，
#    且 --with-base 也救不了：底座包里 WITH_BASE 分支拉取的还是它自己。
#    插件包保留该检查（它们确实需要先有底座）。
if [ "$PKG_KIND" = "base" ]; then
  if [ -d "$PROFILE_DIR" ]; then
    ok "已存在 DSH profile，将就地升级/覆盖: $PROFILE_DIR"
  else
    ok "全新安装：本包即 DSH 底座，将创建 $PROFILE_DIR"
  fi
elif [ ! -d "$PROFILE_DIR" ]; then
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
      [ -d "$pd" ] || continue
      local bn; bn=$(basename "$pd")
      # 🔴 落点必须按该插件 package.json 里的 **真实包名** 决定，不能一律套用
      #    本包的 PLUGIN_DIR 命名空间。
      #    实测 dsh-workbench-bot 的 PLUGIN_DIR=@local/dsh-workbench-bot，
      #    它还带 extra_plugins=["ds-bot"]；早期写法会把 ds-bot 也塞进
      #    node_modules/@local/ds-bot —— 而 profile 里声明的是 "ds-bot"，
      #    loader 去 node_modules/ds-bot 找，找不到 → 该 Bot 静默消失。
      local realname="$bn"
      if [ -f "$pd/package.json" ] && command -v python3 >/dev/null 2>&1; then
        local rn; rn=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8')).get('name',''))" "$pd/package.json" 2>/dev/null || true)
        [ -n "$rn" ] && realname="$rn"
      fi
      # 兜底：package.json 缺失时沿用旧逻辑（按 PLUGIN_DIR 命名空间）
      case "$realname" in
        */*) : ;;
        *) [ "$bn" = "${PLUGIN_DIR##*/}" ] && realname="$PLUGIN_DIR" ;;
      esac
      local rel="${realname#@}"
      case "$realname" in
        @*) local tgt="$nm/${rel%%/*}/${rel#*/}" ;;
        *)  local tgt="$nm/$realname" ;;
      esac
      rm -rf "$tgt"
      mkdir -p "$(dirname "$tgt")"
      cp -a "$pd" "$tgt"
      ok "  $label: $realname -> ${tgt#$target_profile/}"
    done
    # 权限：插件目录必须归 DSH 属主，否则 harness 读不了
    if [ "$(id -u)" -eq 0 ] && [ -n "$DSH_OWNER" ]; then
      chown -R "$DSH_OWNER" "$nm/@local" 2>/dev/null || true
      case "$PLUGIN_DIR" in
        @local/*) : ;;
        *) [ -n "$PLUGIN_DIR" ] && chown -R "$DSH_OWNER" "$nm/$PLUGIN_DIR" 2>/dev/null || true ;;
      esac
    fi

    # 🔴🔴 「包文件在位」≠「已加载」。
    #    DSH 的 loader 按 package.json 的 dsh.profile.bundles 决定挂载哪些插件；
    #    只把目录拷进 node_modules 而不注册 bundle，面板永远不会出现，
    #    且**没有任何报错**（这是本机长期踩的坑，见记忆里的插件加载机制）。
    #    bundles 还必须遵守「单点声明」：包自身 patch 已 insert 同名 id 时，
    #    profile 再插会让 Loader 崩（repeated id）。
    register_bundles "$target_profile" "$label"
  fi
}

register_bundles(){
  local prof="$1" label="$2"
  local pj="$prof/package.json"
  [ -f "$pj" ] || { warn "  $label 无 package.json，跳过 bundle 注册"; return 0; }
  command -v python3 >/dev/null || { warn "  无 python3，跳过 bundle 注册"; return 0; }

  # 本包要注册的 bundle id 列表：plugin_dir + extra_plugins
  local ids="$PLUGIN_DIR"
  if [ -f "$PAYLOAD/extra-bundles.txt" ]; then
    while IFS= read -r l; do
      [ -n "$l" ] && ids="$ids $l"
    done < "$PAYLOAD/extra-bundles.txt"
  fi
  [ -z "$(echo "$ids" | tr -d ' ')" ] && return 0

  local out
  out=$(python3 - "$pj" $ids <<'PYEOF'
import json, os, sys
pj, ids = sys.argv[1], sys.argv[2:]
try:
    d = json.load(open(pj, encoding="utf-8"))
except Exception as e:
    print("ERR\t%s" % e); sys.exit(0)
bundles = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
added = []
for i in ids:
    if not i: continue
    if i in bundles: continue
    # 🔴 顺序敏感：插件必须排在 @deepseek-ai/dsh-base 与 dsh-web-app 之后，
    #    否则其 patch 会在核心插件树就绪前 apply，表现是 fiber=failed。
    bundles.append(i)
    added.append(i)
if added:
    tmp = pj + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, pj)
print("OK\t%s" % " ".join(added))
PYEOF
)
  case "$out" in
    OK*) local a="${out#OK	}"
         [ -n "$a" ] && ok "  $label: bundle 已注册 [$a]" \
                     || ok "  $label: bundle 已存在，无需重复注册" ;;
    ERR*) warn "  $label: bundle 注册失败（${out#ERR	}）" ;;
  esac
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
    # 第 1 列 src / 第 2 列 dst / 第 3 列 type / 第 4 列 basename（仅 harness-dir 用）
    print("\t".join([e.get("src",""), e.get("dst",""),
                     e.get("type","file"), e.get("basename","")]))
PYEOF

  local bakdir="/var/backups/dsh-${PKG_NAME}-${PKG_VERSION}"
  local count=0
  while IFS=$'\t' read -r src dst typ hbase; do
    [ -n "$src" ] || continue
    # 🔴 harness 是独立条目（dst="harness"，不是 fs/ 前缀）：
    #    它必须落到 $USER_HOME/<basename>，也就是 dsh-web.service 的
    #    WorkingDirectory。早期它只被打进 PAYLOAD/harness 却没有任何
    #    fsEntry，安装器根本不认这个目录 —— 2091 MB 采了白采，
    #    目标机上 WorkingDirectory 不存在，`cd` 失败，服务起不来。
    #    ⚠️ 落点目录名必须来自 manifest 的 basename（如
    #       deepseek-harness.dsh-v0.1.7-alpha.2），不能写死 "harness" ——
    #       否则装到 $USER_HOME/harness，WorkingDirectory 依然对不上。
    if [ "$typ" = "harness-dir" ]; then
      local hbn="${hbase:-harness}"
      local htgt="$USER_HOME/$hbn"
      if [ "$DRY" = "1" ]; then ok "  [dry] harness -> $htgt"; continue; fi
      if [ ! -d "$PAYLOAD/harness" ]; then warn "  缺件 PAYLOAD/harness"; continue; fi
      $SUDO mkdir -p "$htgt"
      $SUDO cp -a "$PAYLOAD/harness/." "$htgt/"
      [ -n "${DSH_OWNER:-}" ] && $SUDO chown -R "$DSH_OWNER" "$htgt" 2>/dev/null || true
      count=$((count+1))
      ok "  harness -> $htgt ($(du -sm "$htgt" 2>/dev/null | cut -f1) MB)"
      continue
    fi
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
      # 🔴 脚本类文件里的绝对路径必须重映射。
      #    实测 dsh-web-start.sh 正文写死 `cd /home/lgsj/deepseek-harness.dsh-v0.1.7-alpha.2`，
      #    若目标机用户名不是 lgsj，服务起来后 cd 到不存在的目录 → 立即退出。
      #    unit 文件在上面的 fix_shared_service() 里已做同样处理，这里补齐 fs 文件。
      case "$tgt" in
        *.sh)
          if grep -q '/home/lgsj' "$tgt" 2>/dev/null; then
            $SUDO sed -i -e "s|/home/lgsj/\.dsh|$DSH_HOME|g" \
                          -e "s|/home/lgsj|$USER_HOME|g" "$tgt"
          fi
          ;;
      esac
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
