"""The deployment check must exercise the API container's actual environment."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from services.llm import deployment_preflight as preflight


def test_preflight_uses_container_key_and_persists_only_after_success(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("LLM_MODEL", "deepseek-chat")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "container-key")
    with patch.object(preflight, "test_llm_connection", new_callable=AsyncMock, return_value={"ok": True}) as verify, \
         patch.object(preflight, "update_llm_runtime_config") as save:
        asyncio.run(preflight.verify_and_save())
    verify.assert_awaited_once_with("deepseek", "deepseek-chat", "container-key")
    save.assert_called_once_with({
        "provider": "deepseek",
        "model": "deepseek-chat",
        "llm_required": True,
        "provider_keys": {"deepseek": "container-key"},
    })


def test_preflight_auth_failure_does_not_save_or_reveal_key(monkeypatch, capsys):
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("LLM_MODEL", "deepseek-chat")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "secret-container-key")
    with patch.object(preflight, "test_llm_connection", new_callable=AsyncMock,
                      side_effect=ValueError("secret-container-key")), \
         patch.object(preflight, "update_llm_runtime_config") as save:
        assert preflight.main() == 1
    message = capsys.readouterr().err
    assert "LLM test failed: ValueError" in message
    assert "secret-container-key" not in message
    save.assert_not_called()


def test_preflight_missing_key_stops_before_request(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("LLM_MODEL", "deepseek-chat")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with patch.object(preflight, "test_llm_connection", new_callable=AsyncMock) as verify:
        try:
            asyncio.run(preflight.verify_and_save())
        except preflight.PreflightConfigurationError:
            pass
        else:
            raise AssertionError("Missing key should block deployment")
    verify.assert_not_awaited()


@pytest.mark.parametrize("name,bad", [
    ("ENVIRONMENT", "production"),
    ("AUTH_ENABLED", "true"),
    ("DEPLOYMENT_MODE", "multi_user"),
])
def test_development_preflight_rejects_wrong_container_mode(monkeypatch, name, bad):
    for setting, value in {
        "ENVIRONMENT": "development",
        "AUTH_ENABLED": "false",
        "DEPLOYMENT_MODE": "single_user",
    }.items():
        monkeypatch.setenv(setting, value)
    monkeypatch.setenv(name, bad)
    with patch.object(preflight, "test_llm_connection", new_callable=AsyncMock) as verify:
        with pytest.raises(preflight.PreflightConfigurationError, match=name):
            asyncio.run(preflight.verify_and_save(require_development_single_user=True))
    verify.assert_not_awaited()
