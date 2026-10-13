"""Verify the API container's configured LLM and persist it before deployment.

Run with ``python -m services.llm.deployment_preflight`` inside the API image.
Credentials come from that container's environment, exactly as they will when
the application starts; deployment scripts never pass an alternative key.
"""

from __future__ import annotations

import asyncio
import os
import sys

from services.llm.local_config import (
    LLM_ENV_FIELDS,
    PROVIDER_KEY_FIELDS,
    test_llm_connection,
    update_llm_runtime_config,
)


class PreflightConfigurationError(Exception):
    """A fixed, non-secret configuration diagnostic."""


class PreflightTestError(Exception):
    """A sanitized provider request failure."""


class PreflightSaveError(Exception):
    """A sanitized runtime-volume persistence failure."""


async def verify_and_save(*, require_development_single_user: bool = False) -> None:
    if require_development_single_user:
        expected = {
            "ENVIRONMENT": "development",
            "AUTH_ENABLED": "false",
            "DEPLOYMENT_MODE": "single_user",
        }
        for name, value in expected.items():
            if os.environ.get(name, "").lower() != value:
                raise PreflightConfigurationError(f"API container must set {name}={value}.")
    provider = os.environ.get("LLM_PROVIDER", "").strip().lower()
    model = os.environ.get("LLM_MODEL", "").strip()
    field = PROVIDER_KEY_FIELDS.get(provider)
    if not field or not model:
        raise PreflightConfigurationError("A supported cloud provider and model are required.")
    secret = os.environ.get(LLM_ENV_FIELDS[field], "").strip()
    if not secret:
        raise PreflightConfigurationError("The selected provider's API key is missing from the API container.")

    try:
        result = await asyncio.wait_for(test_llm_connection(provider, model, secret), timeout=90)
        if not result["ok"]:
            raise RuntimeError("Unexpected response")
    except Exception as exc:
        raise PreflightTestError(type(exc).__name__) from None
    try:
        update_llm_runtime_config({
            "provider": provider,
            "model": model,
            "llm_required": True,
            "provider_keys": {provider: secret},
        })
    except Exception as exc:
        raise PreflightSaveError(type(exc).__name__) from None


def main(*, require_development_single_user: bool = False) -> int:
    try:
        asyncio.run(verify_and_save(require_development_single_user=require_development_single_user))
    except PreflightConfigurationError as exc:
        print(f"LLM preflight failed: {exc}", file=sys.stderr)
        return 1
    except PreflightTestError as exc:
        print(
            f"LLM test failed: {exc}; check key, quota, model and outbound network.",
            file=sys.stderr,
        )
        return 1
    except PreflightSaveError as exc:
        print(f"LLM configuration save failed: {exc}; check Lumate data-volume permissions.", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"LLM preflight failed unexpectedly: {type(exc).__name__}.", file=sys.stderr)
        return 1
    print("Real LLM request succeeded; configuration saved to Lumate data volume.")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args not in ([], ["--require-development-single-user"]):
        print("LLM preflight failed: unsupported arguments.", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(require_development_single_user=bool(args)))
