#!/usr/bin/env bash
# 停止 OpenTutor 本地服务
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/tmp"
API_PORT=8001
WEB_PORT=3003

# These launchd jobs keep a listener alive by restarting it after SIGTERM.
# Unload only the known Lumate labels; keep their plist files recoverable.
if command -v launchctl >/dev/null 2>&1; then
  LAUNCH_DOMAIN="gui/$(id -u)"
  for label in dev.lumate.api.serve dev.lumate.web.serve; do
    if launchctl print "${LAUNCH_DOMAIN}/${label}" >/dev/null 2>&1; then
      launchctl bootout "${LAUNCH_DOMAIN}/${label}" >/dev/null 2>&1 \
        && echo "✓ 已停止后台托管服务 ${label}" \
        || echo "✗ 无法停止后台托管服务 ${label}" >&2
    fi
  done
fi

stop_pidfile() {
  local f="$1" name="$2"
  if [[ -f "$f" ]]; then
    local pid; pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "✓ 已停止 $name (PID $pid)"
    fi
    rm -f "$f"
  fi
}

stop_pidfile "$LOG_DIR/api.pid" "后端"
stop_pidfile "$LOG_DIR/web.pid" "前端"

# Only terminate the fixed Lumate ports. Broad `pkill` patterns can stop an
# unrelated project that happens to use Next or Uvicorn.
for port in "$API_PORT" "$WEB_PORT"; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
done

echo "✓ OpenTutor 已全部停止"
