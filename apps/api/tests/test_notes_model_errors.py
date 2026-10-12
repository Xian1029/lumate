from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import httpx

from libs.exceptions import LLMInsufficientBalanceError
from services.llm.providers.openai_client import OpenAIClient
from services.parser import notes


@pytest.mark.asyncio
async def test_manual_note_generation_does_not_hide_balance_failure(monkeypatch):
    client = SimpleNamespace(chat=AsyncMock(side_effect=RuntimeError('402 Insufficient Balance')))
    monkeypatch.setattr(notes, 'get_llm_client', lambda: client)
    with pytest.raises(LLMInsufficientBalanceError):
        await notes.restructure_notes('Synthetic lesson content.', 'Test', allow_fallback=False)
    # The automatic offline path is still explicitly available to callers.
    fallback = await notes.restructure_notes('Synthetic lesson content.', 'Test')
    assert '核心内容' in fallback


@pytest.mark.asyncio
async def test_manual_note_generation_requires_nonempty_ai_content(monkeypatch):
    client = SimpleNamespace(chat=AsyncMock(return_value=('', {})))
    monkeypatch.setattr(notes, 'get_llm_client', lambda: client)
    with pytest.raises(RuntimeError, match='空内容'):
        await notes.restructure_notes('Synthetic lesson content.', 'Test', allow_fallback=False)


@pytest.mark.asyncio
async def test_balance_probe_reports_unavailable_then_recovers_after_topup(monkeypatch):
    from services.llm.providers import openai_client as module
    available = False
    factory = httpx.AsyncClient

    def handler(request):
        assert request.url.path.endswith('/user/balance')
        return httpx.Response(200, json={'is_available': available}, request=request)

    def mock_http(**kwargs):
        return factory(transport=httpx.MockTransport(handler), timeout=kwargs.get('timeout'))

    client = OpenAIClient('synthetic-test-key', 'deepseek-chat', 'https://api.deepseek.com/v1', name='deepseek')
    monkeypatch.setattr(module.httpx, 'AsyncClient', mock_http)
    assert not await client.ping()
    assert 'Insufficient Balance' in client._last_error
    available = True
    assert await client.ping()
    assert client._last_error is None and client.is_healthy
    await client.client.close()


@pytest.mark.asyncio
async def test_open_circuit_skips_repeated_local_backend_probes(monkeypatch):
    from services.llm.providers import openai_client as module

    client = OpenAIClient('synthetic-test-key', 'llama3.2:3b', 'http://localhost:11434/v1', name='ollama')
    client.mark_unhealthy('unreachable')
    client.mark_unhealthy('unreachable')
    client.mark_unhealthy('unreachable')

    called = False

    def should_not_probe(**kwargs):
        nonlocal called
        called = True
        raise AssertionError('an open circuit must not make another network request')

    monkeypatch.setattr(module.httpx, 'AsyncClient', should_not_probe)
    assert not await client.ping()
    assert called is False
    assert client._consecutive_failures == 3
    await client.client.close()


@pytest.mark.asyncio
async def test_readiness_returns_actionable_balance_error(monkeypatch):
    from services.llm import readiness
    monkeypatch.setattr(readiness, 'get_llm_runtime_status', AsyncMock(return_value={
        'status':'degraded','primary_name':'deepseek',
        'provider_details':{'deepseek':{'error':'Insufficient Balance (402)'}},
    }))
    with pytest.raises(LLMInsufficientBalanceError) as failure:
        await readiness.ensure_llm_ready('Notes')
    assert failure.value.status == 402
    assert failure.value.code == 'llm_insufficient_balance'


@pytest.mark.asyncio
async def test_first_health_probe_preserves_balance_error(monkeypatch):
    from services.llm.router import ProviderRegistry
    from services.llm import readiness
    registry = ProviderRegistry()
    client = SimpleNamespace(ping=AsyncMock(return_value=False), _last_error='Insufficient Balance (402)')
    registry.register('deepseek', client, primary=True)
    monkeypatch.setattr(readiness, 'get_registry', lambda: registry)
    with pytest.raises(LLMInsufficientBalanceError):
        await readiness.ensure_llm_ready('Notes')
    assert registry.provider_health_cached['deepseek']['error'] == 'Insufficient Balance (402)'
