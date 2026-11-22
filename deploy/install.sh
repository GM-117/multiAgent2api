#!/usr/bin/env bash
# multiAgent2Api 服务器端安装/升级脚本（在服务器上以 root 运行）
#
# 用法：
#   sudo bash install.sh /tmp/multiagent2api-package.tar.gz [选项]
#
# 选项：
#   --port N            对外端口（默认 7888；写入 /etc/multiagent2api.env）
#   --state FILE        同时导入状态数据 tar.gz（内含 .credentials.yaml / admin-key / jet-hub/ 等）
#   --force-state       数据目录已有状态时仍然覆盖（默认拒绝，避免误删账号）
#   --no-ufw            不改动 ufw 规则
#
# 幂等：重复执行只替换代码与 unit，不动 /opt/multiagent2api/data 里的账号与密钥。
set -euo pipefail

APP_DIR=/opt/multiagent2api
RUN_USER=multiagent2api
SERVICE=multiagent2api
ENV_FILE=/etc/multiagent2api.env
UNIT=/etc/systemd/system/${SERVICE}.service
PORT=7888
STATE_TAR=""
FORCE_STATE=0
USE_UFW=1
PKG=""

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?--port 需要参数}"; shift 2 ;;
    --state) STATE_TAR="${2:?--state 需要参数}"; shift 2 ;;
    --force-state) FORCE_STATE=1; shift ;;
    --no-ufw) USE_UFW=0; shift ;;
    -*) die "未知选项：$1" ;;
    *) [[ -z "$PKG" ]] && PKG="$1" || die "只能指定一个安装包"; shift ;;
  esac
done

[[ $EUID -eq 0 ]] || die "需要 root：sudo bash $0 <package.tar.gz>"
[[ -n "$PKG" && -f "$PKG" ]] || die "用法：sudo bash $0 <package.tar.gz> [--port 7888] [--state state.tar.gz]"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "端口非法：$PORT"

# ── Node 版本检查（engines: ^22.19.0 || ^24.11.0 || >=26.0.0）──
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "未找到 node。请先安装 Node 22.19+/24.11+（本项目不需要 pnpm）。"
"$NODE_BIN" -e '
const [a, b] = process.versions.node.split(".").map(Number)
const ok = (a === 22 && b >= 19) || (a === 24 && b >= 11) || a >= 26
process.exit(ok ? 0 : 1)
' || die "Node 版本过低或不受支持：$("$NODE_BIN" -v)（需要 ^22.19.0 || ^24.11.0 || >=26.0.0）"
log "Node: $NODE_BIN $("$NODE_BIN" -v)"

# ── 解包到临时目录 ──
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
log "解包 $PKG"
tar -xzf "$PKG" -C "$TMP"
[[ -f "$TMP/dist-server/index.js" ]] || die "包内缺少 dist-server/index.js（是不是拿错包了？）"
[[ -f "$TMP/dist/index.html" ]] || die "包内缺少 dist/index.html（前端未构建？）"
[[ -d "$TMP/node_modules" ]] || die "包内缺少 node_modules（运行期依赖未打包？）"
[[ -f "$TMP/package.json" ]] || die "包内缺少 package.json"

# ── 运行用户 ──
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "创建系统用户 $RUN_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi

# ── 停服务，替换代码（保留 data/）──
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  log "停止既有服务 $SERVICE"
  systemctl stop "$SERVICE"
fi

mkdir -p "$APP_DIR/data"
log "落盘代码到 $APP_DIR"
rm -rf "$APP_DIR/dist" "$APP_DIR/dist-server" "$APP_DIR/node_modules" "$APP_DIR/package.json"
cp -a "$TMP"/. "$APP_DIR"/

# ── 状态导入（可选）──
if [[ -n "$STATE_TAR" ]]; then
  [[ -f "$STATE_TAR" ]] || die "状态包不存在：$STATE_TAR"
  if [[ -f "$APP_DIR/data/jet-hub/state.json" && "$FORCE_STATE" -ne 1 ]]; then
    die "$APP_DIR/data 已有账号状态。确认要覆盖请加 --force-state（原数据建议先备份）"
  fi
  log "导入状态数据 $STATE_TAR"
  S_TMP=$(mktemp -d)
  tar -xzf "$STATE_TAR" -C "$S_TMP"
  mkdir -p "$APP_DIR/data"
  cp -a "$S_TMP"/. "$APP_DIR/data"/
  rm -rf "$S_TMP"
fi

# ── 权限：凭据/密钥只给服务用户，0600 ──
log "修正权限"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
chmod 700 "$APP_DIR/data"
find "$APP_DIR/data" -maxdepth 1 -type f -exec chmod 600 {} \;
[[ -f "$APP_DIR/data/.credentials.yaml" ]] && chmod 600 "$APP_DIR/data/.credentials.yaml"
[[ -d "$APP_DIR/data/openai-gateway" ]] && chmod 700 "$APP_DIR/data/openai-gateway" && chmod 600 "$APP_DIR/data/openai-gateway"/* 2>/dev/null || true

# ── 环境变量文件（已存在则保留，不覆盖自定义设置）──
if [[ -f "$ENV_FILE" ]]; then
  log "保留既有 $ENV_FILE"
  # 端口以本次参数为准（部署脚本显式传 --port）
  if grep -q '^PORT=' "$ENV_FILE"; then
    sed -i "s/^PORT=.*/PORT=${PORT}/" "$ENV_FILE"
  else
    echo "PORT=${PORT}" >> "$ENV_FILE"
  fi
else
  log "写入 $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# multiAgent2Api 运行配置（0600）。改完 systemctl restart ${SERVICE}
MULTIAGENT2API_HOME=${APP_DIR}/data
PORT=${PORT}
HOST=0.0.0.0
PROXY_GATEWAY=1
DSH_OPENAI_GATEWAY_PORT=8326
LOG_LEVEL=info
TZ=Asia/Shanghai
EOF
fi
chmod 600 "$ENV_FILE"

# ── systemd unit ──
log "安装 systemd unit"
sed "s|@NODE_BIN@|${NODE_BIN}|g" "$(dirname "$0")/multiagent2api.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# ── 防火墙 ──
if [[ "$USE_UFW" -eq 1 ]] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^Status: active"; then
  if ! ufw status | grep -Eq "^${PORT}/tcp\s+ALLOW"; then
    log "ufw 放行 ${PORT}/tcp"
    ufw allow "${PORT}/tcp" >/dev/null
  fi
fi

# ── 健康检查 ──
log "等待服务就绪"
OK=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done

echo
if [[ "$OK" -eq 1 ]]; then
  echo "=================== 部署完成 ==================="
  curl -fsS "http://127.0.0.1:${PORT}/healthz" | head -c 600; echo
else
  echo "=================== 启动异常 ==================="
  journalctl -u "$SERVICE" -n 40 --no-pager || true
fi
systemctl --no-pager --lines=0 status "$SERVICE" || true
echo
echo "管理界面：http://<公网IP>:${PORT}/admin"
echo "状态目录：${APP_DIR}/data"
echo "管理密钥：${APP_DIR}/data/admin-key"
echo "网关 Key：${APP_DIR}/data/openai-gateway/api-key"
echo "查看日志：journalctl -u ${SERVICE} -f"
echo "⚠️ 还需在华为云安全组放行 入方向 TCP ${PORT}"
echo "================================================"
[[ "$OK" -eq 1 ]] || exit 1
