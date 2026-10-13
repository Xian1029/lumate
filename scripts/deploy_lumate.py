"""Standard-library Linux deployment helper invoked by the sh entry point."""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "lumate-customized"
PROD = ROOT / "deploy/.env.production"
KEYS = {p: p.upper() + "_API_KEY" for p in
        ("deepseek", "openai", "anthropic", "openrouter", "gemini", "groq")}


def run(args, *, capture=True, data=None, timeout=60):
    return subprocess.run(args, input=data, text=True, capture_output=capture,
                          timeout=timeout, check=True)


def read_env(text):
    """Read literal common dotenv values without shell evaluation."""
    values = {}
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$", line)
        if not match:
            continue
        key, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        values[key] = value
    return values


def missing(value):
    return not value or value.startswith("replace-with-")


def write_env(path, original, updates):
    """Replace duplicate keys atomically and retain unrelated settings."""
    lines = []
    for line in original.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=", line)
        if not match or match[1] not in updates:
            lines.append(line)
    for key, value in updates.items():
        if any(c in value for c in "\r\n\0'"):
            raise ValueError(f"Invalid characters in {key}; use a single-line value.")
        # Compose single quotes prevent interpolation of dollar signs.
        lines.append(f"{key}='{value}'")
    fd, name = tempfile.mkstemp(prefix=".env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as file:
            file.write("\n".join(lines) + "\n")
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def inspect_api():
    result = subprocess.run(["docker", "inspect", "lumate-customized-api"],
                            text=True, capture_output=True, timeout=20)
    if result.returncode:
        return None
    obj = json.loads(result.stdout)[0]
    if obj["Config"].get("Labels", {}).get("com.docker.compose.project") != PROJECT:
        raise ValueError("Existing lumate-customized-api belongs to another project.")
    return obj


def validate(values):
    if len(values["JWT_SECRET_KEY"]) < 32:
        raise ValueError("Existing JWT_SECRET_KEY is shorter than 32 characters; repair it explicitly.")
    try:
        if len(base64.b64decode(values["ENCRYPTION_KEY"], altchars=b"-_", validate=True)) != 32:
            raise ValueError()
    except Exception:
        raise ValueError("Existing ENCRYPTION_KEY is not a valid Fernet key; do not replace an existing encryption key blindly.") from None
    for origin in values["CORS_ORIGINS"].split(","):
        parsed = urlsplit(origin.strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("CORS_ORIGINS must contain complete HTTP(S) origins, separated by commas.")
    for key, default in (("WEB_PORT", "3003"), ("API_PORT", "8001")):
        port = int(values.get(key) or default)
        if not 1 <= port <= 65535:
            raise ValueError(f"Invalid {key}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--configure", action="store_true", help="prompt to change cloud LLM provider/model/key")
    options = parser.parse_args()
    os.chdir(ROOT)
    run(["docker", "info"])
    run(["docker", "compose", "version"])
    existing = inspect_api()
    previous = {}
    if existing:
        previous = dict(item.split("=", 1) for item in existing["Config"].get("Env", []) if "=" in item)
    runtime = {}
    if existing and existing["State"].get("Running"):
        result = subprocess.run(["docker", "exec", "lumate-customized-api", "python", "-c",
            "import json; from dotenv import dotenv_values; print(json.dumps(dict(dotenv_values('/app/data/runtime.env', interpolate=False))))"],
            capture_output=True, text=True, timeout=20)
        if result.returncode == 0:
            runtime = json.loads(result.stdout)
    if PROD.is_symlink():
        raise ValueError("Production env file must be a regular file.")
    source = PROD if PROD.exists() else ROOT / ".env"
    if not source.exists():
        source = ROOT / "deploy/.env.production.example"
    original = source.read_text()
    values = read_env(original)
    updates = {}
    for key in ("JWT_SECRET_KEY", "ENCRYPTION_KEY", "CORS_ORIGINS"):
        if missing(values.get(key)) and not missing(previous.get(key)):
            values[key] = updates[key] = previous[key]
        elif key != "CORS_ORIGINS" and not missing(previous.get(key)) and values.get(key) != previous[key]:
            raise ValueError(f"{key} differs from the running Lumate container. Reconcile the existing key before deploying.")
    if missing(values.get("JWT_SECRET_KEY")):
        values["JWT_SECRET_KEY"] = updates["JWT_SECRET_KEY"] = secrets.token_hex(32)
    if missing(values.get("ENCRYPTION_KEY")):
        values["ENCRYPTION_KEY"] = updates["ENCRYPTION_KEY"] = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    if missing(values.get("CORS_ORIGINS")) or values.get("CORS_ORIGINS") == "http://localhost:3003":
        origin = input("Public origin (e.g. https://learn.example.com): ").strip()
        values["CORS_ORIGINS"] = updates["CORS_ORIGINS"] = origin
    provider = runtime.get("LLM_PROVIDER") or values.get("LLM_PROVIDER") or previous.get("LLM_PROVIDER") or "deepseek"
    if options.configure or provider not in KEYS:
        provider = input("Cloud provider [deepseek]: ").strip().lower() or "deepseek"
    if provider not in KEYS:
        raise ValueError("Supported providers: " + ", ".join(KEYS))
    model = runtime.get("LLM_MODEL") or values.get("LLM_MODEL") or previous.get("LLM_MODEL")
    if options.configure or not model or provider != (runtime.get("LLM_PROVIDER") or values.get("LLM_PROVIDER")):
        model = input("Model name" + (" [deepseek-chat]" if provider == "deepseek" else "") + ": ").strip()
        if not model and provider == "deepseek":
            model = "deepseek-chat"
    if not model:
        raise ValueError("Model name is required.")
    key_name = KEYS[provider]
    key = runtime.get(key_name, values.get(key_name) or previous.get(key_name) or "")
    if options.configure or missing(key):
        if not sys.stdin.isatty():
            raise ValueError("Run in an interactive terminal to enter the API key with hidden input.")
        key = getpass.getpass(f"{provider} API key (hidden): ").strip()
    if missing(key):
        raise ValueError("A real cloud API key is required.")
    updates.update(LLM_PROVIDER=provider, LLM_MODEL=model, LLM_REQUIRED="true")
    updates[key_name] = key
    values.update(updates)
    validate(values)
    PROD.parent.mkdir(parents=True, exist_ok=True)
    # Keep the previous env file recoverable, never overwrite a prior backup.
    if PROD.exists():
        backup = PROD.with_name(".env.production.backup-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3))
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(original)
    write_env(PROD, original, updates)
    compose = ["docker", "compose", "--project-name", PROJECT, "--env-file", str(PROD), "-f", str(ROOT / "docker-compose.deploy.yml")]
    # Remove inherited variable overrides so Compose uses the saved env file.
    for name in values:
        os.environ.pop(name, None)
    config = json.loads(run(compose + ["config", "--format", "json"]).stdout)
    if set(config["services"]) != {"api", "web", "redis"}:
        raise ValueError("Unexpected additional services in deployment Compose file.")
    if config["networks"]["default"]["name"] != PROJECT + "-network":
        raise ValueError("Unexpected network scope in deployment Compose file.")
    for service in ("api", "web", "redis"):
        if config["services"][service]["container_name"] != PROJECT + "-" + service:
            raise ValueError("Unexpected container scope in Compose configuration.")
    for name in ("data", "uploads", "redis"):
        if config["volumes"]["lumate_customized_" + name]["name"] != PROJECT + "_" + name:
            raise ValueError("Unexpected volume scope in Compose configuration.")
    print("Building Lumate API and Web images...", flush=True)
    run(compose + ["build", "api", "web"], capture=False, timeout=3600)
    # The one-off API uses the same image, environment and persistent volume.
    # It runs before replacing live services; credentials are supplied on stdin.
    probe = """
import asyncio,json,sys
from services.llm.local_config import test_llm_connection,update_llm_runtime_config
p=json.load(sys.stdin)
async def check():
    try:
        result=await asyncio.wait_for(test_llm_connection(p['provider'],p['model'],p['key']),timeout=90)
        if not result['ok']: raise RuntimeError('Unexpected response')
    except Exception as e:
        print('LLM test failed: '+type(e).__name__+'; check key, quota, model and outbound network.',file=sys.stderr)
        sys.exit(1)
asyncio.run(check())
update_llm_runtime_config({'provider':p['provider'],'model':p['model'],'llm_required':True,'provider_keys':{p['provider']:p['key']}})
print('Real LLM request succeeded; configuration saved to Lumate data volume.')
"""
    run(compose + ["run", "--rm", "--no-deps", "-T", "api", "python", "-c", probe],
        data=json.dumps({"provider": provider, "model": model, "key": key}), timeout=180)
    print("LLM check passed. Starting Lumate services...", flush=True)
    run(compose + ["up", "-d", "--no-build"], capture=False, timeout=240)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        states = json.loads(run(["docker", "inspect", PROJECT + "-api", PROJECT + "-web", PROJECT + "-redis"]).stdout)
        if all(s["State"].get("Health", {}).get("Status") == "healthy" for s in states):
            print("Deployment successful: API, Web and Redis are healthy. LLM settings survive restarts.")
            return
        time.sleep(3)
    raise ValueError("Services did not become healthy within 180 seconds. Inspect Lumate logs; data volumes are preserved.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        # Captured errors can contain secret-bearing env values; don't dump them.
        print(f"Deployment stopped: Docker command failed (exit {exc.returncode}). Check Docker availability, configuration and Lumate logs.", file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, EOFError, subprocess.TimeoutExpired) as exc:
        print(f"Deployment stopped: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Deployment interrupted.", file=sys.stderr)
        sys.exit(130)
