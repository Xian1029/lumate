#!/usr/bin/env sh
# Repair Lumate's persistent cloud-LLM configuration on a Docker host.
# Run as root: sh scripts/fix_llm_persistence.sh
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
PROJECT="lumate-customized"
ENV_FILE="deploy/.env.production"
COMPOSE_FILE="docker-compose.deploy.yml"

fail() { printf '%s\n' "ERROR: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
[ "$(id -u)" -eq 0 ] || fail "Run as root or with sudo."
[ -d "$APP_DIR" ] || fail "Lumate directory not found: $APP_DIR"
cd "$APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE."
[ -f "$COMPOSE_FILE" ] || fail "Missing $COMPOSE_FILE."
[ -f apps/api/config.py ] || fail "Not an expected Lumate source tree."
COMPOSE="docker compose --project-name $PROJECT --env-file $ENV_FILE -f $COMPOSE_FILE"

# Load LLM settings from the Lumate-only data volume after Compose variables.
if ! grep -q 'LOCAL_ENV_FILE' apps/api/config.py; then
  grep -q '^settings = Settings()$' apps/api/config.py || fail "Unexpected config.py layout."
  config_tmp=$(mktemp)
  awk '
    /^settings = Settings\(\)$/ {
      print "# Persist runtime LLM settings outside the read-only application image."
      print "_runtime_env_file = os.environ.get(\"LOCAL_ENV_FILE\", \"\").strip()"
      print "if _runtime_env_file:"
      print "    from dotenv import load_dotenv"
      print "    load_dotenv(_runtime_env_file, override=True)"
    }
    { print }
  ' apps/api/config.py > "$config_tmp"
  mv "$config_tmp" apps/api/config.py
fi

# /app/data maps to lumate-customized_data, never an opentutor volume.
if ! grep -q 'LOCAL_ENV_FILE: /app/data/runtime.env' "$COMPOSE_FILE"; then
  grep -q '      UPLOAD_DIR: /app/uploads' "$COMPOSE_FILE" || fail "Unexpected Compose layout."
  sed -i '/      UPLOAD_DIR: \/app\/uploads/a\      LOCAL_ENV_FILE: /app/data/runtime.env' "$COMPOSE_FILE"
fi

printf '%s\n' "Building and starting only the $PROJECT stack ..."
$COMPOSE up -d --build

printf '\n%s\n' "Enter the cloud LLM settings. The key is hidden and never logged."
printf '%s' "Provider [deepseek]: "
IFS= read -r LLM_PROVIDER || true
LLM_PROVIDER=${LLM_PROVIDER:-deepseek}
printf '%s' "Model [deepseek-chat]: "
IFS= read -r LLM_MODEL || true
LLM_MODEL=${LLM_MODEL:-deepseek-chat}
printf '%s' "API key (hidden): "
stty -echo
IFS= read -r LLM_API_KEY || true
stty echo
printf '\n'
[ -n "$LLM_API_KEY" ] || fail "No API key entered."

case "$LLM_PROVIDER" in
  openai) KEY_NAME=OPENAI_API_KEY ;;
  anthropic) KEY_NAME=ANTHROPIC_API_KEY ;;
  deepseek) KEY_NAME=DEEPSEEK_API_KEY ;;
  openrouter) KEY_NAME=OPENROUTER_API_KEY ;;
  gemini) KEY_NAME=GEMINI_API_KEY ;;
  groq) KEY_NAME=GROQ_API_KEY ;;
  *) fail "Unsupported cloud provider: $LLM_PROVIDER" ;;
esac

# Pass the secret on standard input, never through a command-line argument.
printf '%s\000%s\000%s\000%s\000' "$LLM_PROVIDER" "$LLM_MODEL" "$KEY_NAME" "$LLM_API_KEY" | $COMPOSE exec -T api python -c '
import os, sys
from pathlib import Path
from dotenv import set_key
provider, model, key_name, api_key = [x.decode("utf-8") for x in sys.stdin.buffer.read().split(b"\0")[:4]]
path = Path(os.environ["LOCAL_ENV_FILE"])
path.parent.mkdir(parents=True, exist_ok=True)
path.touch(mode=0o600, exist_ok=True)
set_key(path, "LLM_PROVIDER", provider, quote_mode="never")
set_key(path, "LLM_MODEL", model, quote_mode="never")
set_key(path, "LLM_REQUIRED", "true", quote_mode="never")
set_key(path, key_name, api_key, quote_mode="auto")
os.chmod(path, 0o600)
print("Runtime LLM configuration saved to Lumate data volume.")
'
unset LLM_API_KEY

printf '%s\n' "Restarting only the Lumate API ..."
$COMPOSE restart api
sleep 5
$COMPOSE ps
printf '%s\n' "Verifying provider health (no API key is printed) ..."
$COMPOSE exec -T api python -c '
import asyncio
from services.llm.readiness import get_llm_runtime_status
s = asyncio.run(get_llm_runtime_status())
print({k: s[k] for k in ("status", "primary_name", "available_providers", "provider_health")})
'
printf '%s\n' "Done. UI changes persist in lumate-customized_data/runtime.env."
