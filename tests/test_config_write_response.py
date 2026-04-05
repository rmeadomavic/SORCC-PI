import asyncio
from types import SimpleNamespace

from argus.web import app_state
from argus.web.routers import config


class _DummyRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


def test_config_write_includes_restart_required(monkeypatch):
    updates = {"general": {"hostname": "argus-node"}}
    monkeypatch.setattr(app_state, "HAS_CONFIG_API", True)
    monkeypatch.setattr(app_state, "write_config", lambda _u: {"restart_required": ["wifi.country_code"], "skipped": []})
    monkeypatch.setattr("argus.config_schema.validate", lambda _p: SimpleNamespace(errors=[], warnings=[]))

    result = asyncio.run(config.config_write(_DummyRequest(updates)))
    assert result["status"] == "ok"
    assert result["restart_required"] == ["wifi.country_code"]


def test_config_write_defaults_restart_required_empty(monkeypatch):
    updates = {"general": {"hostname": "argus-node"}}
    monkeypatch.setattr(app_state, "HAS_CONFIG_API", True)
    monkeypatch.setattr(app_state, "write_config", lambda _u: {"skipped": ["foo.bar (unknown field)"]})
    monkeypatch.setattr("argus.config_schema.validate", lambda _p: SimpleNamespace(errors=[], warnings=[]))

    result = asyncio.run(config.config_write(_DummyRequest(updates)))
    assert result["status"] == "ok"
    assert result["restart_required"] == []
