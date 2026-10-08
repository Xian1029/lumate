#!/usr/bin/env bash
# Backward-compatible entry point. Keep every local launch on the same
# lifecycle: shut down stale listeners, rebuild against API :8001, then serve
# the production UI on :3003.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${ROOT_DIR}/start.sh"
