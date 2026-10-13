#!/bin/sh
# Linux single-user development deployment entry point.
# Run: sh scripts/deploy.sh
# Use --env-file deploy/.env.production for the production profile.
set -eu
set +x
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
command -v python3 >/dev/null 2>&1 || { echo 'Install Python 3 first.' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'Install Docker Engine and Compose v2 first.' >&2; exit 1; }
if [ "$#" -eq 0 ]; then
  set -- --env-file deploy/.env.development
fi
exec python3 scripts/deploy_lumate.py "$@"
