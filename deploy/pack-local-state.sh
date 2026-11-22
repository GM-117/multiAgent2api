#!/usr/bin/env bash
# 打包本机 multiAgent2Api 状态目录，用于迁移到服务器
#
# 用法：
#   bash deploy/pack-local-state.sh [输出文件路径]
#
# 迁移前**必须**先停掉本机实例：两边同时用同一批 refresh_token 续期会互相踢下线。
# 本脚本会检查本机 8080 端口是否还有进程监听，有则拒绝打包。
set -euo pipefail

STATE_HOME="${MULTIAGENT2API_HOME:-$HOME/.multiAgent2Api}"
OUT="${1:-/tmp/multiagent2api-state-$(date +%Y%m%d-%H%M%S).tar.gz}"
PORT_GUESS="${PORT:-8080}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -d "$STATE_HOME" ]] || die "状态目录不存在：$STATE_HOME"

if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT_GUESS" -sTCP:LISTEN >/dev/null 2>&1; then
    die "本机 ${PORT_GUESS} 仍有进程监听。请先停掉本机 multiAgent2Api 再打包：\n  lsof -nP -iTCP:${PORT_GUESS} -sTCP:LISTEN"
  fi
fi

# 只打包运行必需的状态；cache 目录（体积大且可重建）不带走
ITEMS=()
for item in .credentials.yaml admin-key openai-gateway jet-hub caller-keys.json caller-usage attachments; do
  [[ -e "$STATE_HOME/$item" ]] && ITEMS+=("$item")
done
[[ ${#ITEMS[@]} -gt 0 ]] || die "$STATE_HOME 里没有可迁移的状态文件"

tar --exclude='cache' --exclude='*/cache' -czf "$OUT" -C "$STATE_HOME" "${ITEMS[@]}"
chmod 600 "$OUT"
echo "状态包已生成：${OUT}（$(du -h "$OUT" | awk '{print $1}')）"
echo "包含：${ITEMS[*]}"
echo "⚠️ 里面是明文凭据与密钥，用完请删除；传输走 SSH 加密通道。"
