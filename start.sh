#!/usr/bin/env bash
# OpenTutor 本地启动脚本 (macOS / Apple Silicon)
# 后端: FastAPI uvicorn @ 127.0.0.1:8001
# 前端: Next.js production @ 127.0.0.1:3003
set -euo pipefail

# 绕过 HTTP(S) 代理，确保本机 127.0.0.1 / localhost 服务（含 Ollama :11434）直连
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="localhost,127.0.0.1,::1"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$ROOT/apps/api"
WEB_DIR="$ROOT/apps/web"
LOG_DIR="$ROOT/tmp"
DETACHED_RUNNER="$ROOT/scripts/detached-process.cjs"
mkdir -p "$LOG_DIR" "$ROOT/uploads"

# Fixed local endpoints prevent stale browser tabs from opening an older build.
API_PORT=8001
WEB_PORT=3003
API_PID=""
WEB_PID=""

# Do not override DATABASE_URL or UPLOAD_DIR here.  The API's own .env is the
# single source of truth for local data.  Overriding it in this script created
# a second, empty database for `./start.sh`, while direct API launches used a
# different one — making a healthy start look like lost courses or a broken UI.

if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
  echo "✗ 后端虚拟环境不存在，请先在 apps/api 下创建："
  echo "    uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements-core.txt"
  exit 1
fi

for command in curl lsof npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "✗ 缺少启动所需命令：$command" >&2
    exit 1
  fi
done

if [[ ! -x "$WEB_DIR/node_modules/.bin/next" ]]; then
  echo "✗ 前端依赖未安装，请先在 apps/web 执行 npm install" >&2
  exit 1
fi

if [[ ! -f "$DETACHED_RUNNER" ]]; then
  echo "✗ 缺少本地服务启动器：$DETACHED_RUNNER" >&2
  exit 1
fi

cleanup_failed_start() {
  local status="$?"
  if [[ "$status" -ne 0 ]]; then
    echo "✗ 启动失败，正在清理本次启动的残留进程…" >&2
    [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
    [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
    echo "  后端日志: $LOG_DIR/api.log" >&2
    echo "  前端日志: $LOG_DIR/web.log / $LOG_DIR/web-build.log" >&2
  fi
}
trap cleanup_failed_start EXIT

# ---- 构建完成后用于切换旧服务的端口回收 ----
stop_listener() {
  local port="$1" label="$2" pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  echo "停止旧${label}（端口 ${port}）..."
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 10); do
    lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 1
  done
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { echo "✗ 端口 ${port} 仍被占用。" >&2; exit 1; }
  # lsof returns 1 when no listener exists. Under `set -e`, make that
  # expected post-stop condition an explicit success for this function.
  return 0
}

stop_managed_service() {
  local label="$1" domain="gui/$(id -u)/$1"
  if ! command -v launchctl >/dev/null 2>&1; then return 0; fi
  if launchctl print "$domain" >/dev/null 2>&1; then
    echo "卸载 Lumate 后台托管服务（${label}），避免自动重启占用端口…"
    launchctl bootout "$domain" >/dev/null 2>&1 || {
      echo "✗ 无法停止后台托管服务 ${label}，请检查 launchctl 权限。" >&2
      exit 1
    }
  fi
}

# ---- 先停止旧服务，再构建共享的 .next 目录 ----
# Next production server reads from .next while serving requests. Rebuilding
# that same directory underneath a live server can mix manifests/chunks and
# produce errors such as "Cannot find module './chunks/*.js'".
stop_managed_service "dev.lumate.api.serve"
stop_managed_service "dev.lumate.web.serve"
stop_listener "$API_PORT" "后端"
stop_listener "$WEB_PORT" "前端"

cd "$WEB_DIR"
export NEXT_PUBLIC_API_URL="http://127.0.0.1:${API_PORT}/api"
npm run build > "$LOG_DIR/web-build.log" 2>&1 || {
  echo "✗ 前端构建失败，最近日志：" >&2
  tail -n 60 "$LOG_DIR/web-build.log" >&2 || true
  exit 1
}

cd "$API_DIR"
API_PID="$(node "$DETACHED_RUNNER" "$LOG_DIR/api.log" "$API_DIR" "$API_DIR/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port "$API_PORT")"
echo "$API_PID" > "$LOG_DIR/api.pid"

# ---- 等待后端存活（不依赖可选的 LLM 服务）----
echo "等待后端就绪 …"
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/api/health/live" >/dev/null 2>&1; then
    echo "✓ 后端已就绪 (PID $API_PID)"
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "✗ 后端进程已退出，最近日志：" >&2
    tail -n 80 "$LOG_DIR/api.log" >&2 || true
    exit 1
  fi
  if [[ $i -eq 45 ]]; then
    echo "✗ 后端启动超时，最近日志：" >&2
    tail -n 80 "$LOG_DIR/api.log" >&2 || true
    exit 1
  fi
  sleep 1
done

# ---- 启动已构建的前端 ----
cd "$WEB_DIR"
# Start Next directly (not through npm's wrapper) in an independent session.
# The PID file therefore refers to the actual web listener.
WEB_PID="$(node "$DETACHED_RUNNER" "$LOG_DIR/web.log" "$WEB_DIR" "$WEB_DIR/node_modules/.bin/next" start --hostname 127.0.0.1 --port "$WEB_PORT")"
echo "$WEB_PID" > "$LOG_DIR/web.pid"

# ---- 等待前端 ----
echo "等待前端就绪 ..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
    echo "✓ 前端已就绪 (PID $WEB_PID)"
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "✗ 前端进程已退出，最近日志：" >&2
    tail -n 80 "$LOG_DIR/web.log" >&2 || true
    exit 1
  fi
  if [[ $i -eq 60 ]]; then
    echo "✗ 前端启动超时，最近日志：" >&2
    tail -n 80 "$LOG_DIR/web.log" >&2 || true
    exit 1
  fi
  sleep 1
done

trap - EXIT

echo ""
echo "=============================================="
echo "  OpenTutor 已启动"
echo "  前端  →  http://localhost:${WEB_PORT}"
echo "  后端  →  http://127.0.0.1:${API_PORT}/api"
echo "  文档  →  http://127.0.0.1:${API_PORT}/docs"
echo "----------------------------------------------"
echo "  停止: ./stop.sh"
echo "  日志: tail -f tmp/api.log   /   tail -f tmp/web.log"
echo "=============================================="
