#!/usr/bin/env bash
# multiAgent2Api 本机打包 + 上传 + 远端安装（在开发机上运行）
#
# 用法：
#   bash deploy/deploy.sh [选项]
#
# 选项：
#   --host root@IP     目标服务器（默认 root@115.120.210.69）
#   --port 7888        对外端口（默认 7888）
#   --state FILE       同时导入状态数据包（配合 deploy/pack-local-state.sh 生成）
#   --force-state      服务器 data/ 已有状态时仍然覆盖导入
#   --skip-build       跳过本机构建（直接复用现有 dist/ 与 dist-server/）
#   --dry-run          只打包，不上传
#
# 做的事：
#   1. pnpm run build（前端 dist/ + 后端 dist-server/）
#   2. 在临时目录为 **linux x64 / glibc** 解析运行期依赖（sharp、wreq-js 的原生绑定）
#   3. 打 tar.gz（dist、dist-server、node_modules、package.json、deploy/）
#   4. scp 上传并在服务器执行 deploy/install.sh
set -euo pipefail

HOST="root@115.120.210.69"
PORT="7888"
STATE_TAR=""
FORCE_STATE=0
SKIP_BUILD=0
DRY_RUN=0
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?--host 需要参数}"; shift 2 ;;
    --port) PORT="${2:?--port 需要参数}"; shift 2 ;;
    --state) STATE_TAR="${2:?--state 需要参数}"; shift 2 ;;
    --force-state) FORCE_STATE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "未知选项：$1" ;;
    *) die "未知参数：$1" ;;
  esac
done

cd "$REPO_ROOT"

# ── 1. 构建 ──
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "构建前端与后端"
  pnpm run build
else
  log "跳过构建（--skip-build）"
fi
[[ -f dist/index.html && -f dist-server/index.js ]] || die "缺少构建产物，请先 pnpm run build"

# ── 2. 为 Linux 解析运行期依赖 ──
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG_DIR="$STAGE/multiagent2api"
mkdir -p "$PKG_DIR"

log "准备 linux/x64/glibc 运行期依赖"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$PKG_DIR/"
if ! grep -q '^supportedArchitectures:' "$PKG_DIR/pnpm-workspace.yaml"; then
  cat >> "$PKG_DIR/pnpm-workspace.yaml" <<'EOF'

# 部署包专用（仅打包暂存目录）：在 macOS 上解析 linux-x64 的可选原生依赖
supportedArchitectures:
  os: [linux]
  cpu: [x64]
  libc: [glibc]
EOF
fi
(cd "$PKG_DIR" && PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --prod --frozen-lockfile)

# 自检：必须带 linux-x64 原生绑定，且不能残留 macOS 绑定
for need in "@img+sharp-linux-x64" "@img+sharp-libvips-linux-x64" "@wreq-js+binding-linux-x64-gnu"; do
  compgen -G "$PKG_DIR/node_modules/.pnpm/${need}@*" >/dev/null || die "依赖自检失败：缺少 ${need}（打包平台可能不是 macOS/未取到 linux 包）"
done
if find "$PKG_DIR/node_modules" -name "*.darwin-*.node" 2>/dev/null | grep -q .; then
  die "依赖自检失败：node_modules 里混入了 darwin 原生模块"
fi

log "组装发布包"
cp -a dist dist-server "$PKG_DIR/"
mkdir -p "$PKG_DIR/deploy"
cp deploy/install.sh deploy/multiagent2api.service "$PKG_DIR/deploy/"

ARCHIVE="$STAGE/multiagent2api-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$ARCHIVE" -C "$PKG_DIR" .
log "包大小：$(du -h "$ARCHIVE" | awk '{print $1}')  →  $ARCHIVE"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "--dry-run：包留在 ${ARCHIVE}（注意：脚本退出时会随临时目录清理）"
  trap - EXIT
  echo "$ARCHIVE"
  exit 0
fi

# ── 3. 上传 ──
REMOTE_PKG="/tmp/$(basename "$ARCHIVE")"
log "上传到 ${HOST}:${REMOTE_PKG}"
scp -q "$ARCHIVE" "${HOST}:${REMOTE_PKG}"

STATE_ARG=""
if [[ -n "$STATE_TAR" ]]; then
  [[ -f "$STATE_TAR" ]] || die "状态包不存在：$STATE_TAR"
  REMOTE_STATE="/tmp/$(basename "$STATE_TAR")"
  log "上传状态数据到 ${HOST}:${REMOTE_STATE}"
  scp -q "$STATE_TAR" "${HOST}:${REMOTE_STATE}"
  STATE_ARG="--state ${REMOTE_STATE}"
  [[ "$FORCE_STATE" -eq 1 ]] && STATE_ARG="${STATE_ARG} --force-state"
fi

# ── 4. 远端安装 ──
log "远端安装（端口 ${PORT}）"
ssh "$HOST" "set -e; rm -rf /tmp/m2a-install && mkdir -p /tmp/m2a-install && \
  tar -xzf '${REMOTE_PKG}' -C /tmp/m2a-install ./deploy && \
  bash /tmp/m2a-install/deploy/install.sh '${REMOTE_PKG}' --port '${PORT}' ${STATE_ARG}"

log "完成。若为首次部署，请确认华为云安全组已放行 入方向 TCP ${PORT}"
