import asyncio
import importlib
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

from argus.web import server


def _write_config(path: Path, *, api_token: str = "", tls_enabled: str = "false") -> None:
    path.write_text(
        "\n".join(
            [
                "[dashboard]",
                f"api_token = {api_token}",
                f"tls_enabled = {tls_enabled}",
            ]
        ),
        encoding="utf-8",
    )


def test_token_auth_uses_argus_config_path_env(monkeypatch, tmp_path):
    cfg_path = tmp_path / "argus.ini"
    _write_config(cfg_path, api_token="env-token-123")

    monkeypatch.setenv("ARGUS_CONFIG_PATH", str(cfg_path))
    reloaded = importlib.reload(server)

    assert reloaded.get_config_path() == cfg_path
    assert reloaded._AUTH_TOKEN == "env-token-123"


def test_config_validation_uses_single_config_path(monkeypatch, tmp_path):
    cfg_path = tmp_path / "argus.ini"
    _write_config(cfg_path)
    captured_paths: list[str] = []

    class _DummyRequest:
        async def json(self):
            return {"general": {"hostname": "argus-node"}}

    def _fake_validate(path):
        captured_paths.append(path)
        return SimpleNamespace(ok=True, errors=[], warnings=[])

    monkeypatch.setattr(server, "_HAS_CONFIG_API", True)
    monkeypatch.setattr(server, "get_config_path", lambda: cfg_path)
    monkeypatch.setattr(server, "write_config", lambda _updates: {"restart_required": [], "skipped": []})
    monkeypatch.setattr(server.events, "log", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "configure_web_password", lambda *args, **kwargs: None)
    monkeypatch.setattr("argus.config_schema.validate", _fake_validate)

    asyncio.run(server.config_write(_DummyRequest()))
    asyncio.run(server.config_validate())

    assert captured_paths == [str(cfg_path), str(cfg_path)]


def test_main_tls_honors_argus_config_path_env(monkeypatch, tmp_path):
    cfg_path = tmp_path / "argus.ini"
    _write_config(cfg_path, tls_enabled="true")
    uvicorn_calls: list[tuple[str, dict]] = []

    def _fake_run(app, **kwargs):
        uvicorn_calls.append((app, kwargs))

    monkeypatch.setenv("ARGUS_CONFIG_PATH", str(cfg_path))
    monkeypatch.delenv("ARGUS_TLS", raising=False)
    monkeypatch.setenv("ARGUS_PORT", "9443")
    monkeypatch.setattr("uvicorn.run", _fake_run)

    fake_tls_module = SimpleNamespace(
        ensure_tls_cert=lambda: ("/tmp/test.crt", "/tmp/test.key")
    )
    monkeypatch.setitem(sys.modules, "argus.tls", fake_tls_module)

    runpy.run_module("argus.__main__", run_name="__main__")

    assert len(uvicorn_calls) == 1
    app, kwargs = uvicorn_calls[0]
    assert app == "argus.web.server:app"
    assert kwargs["ssl_certfile"] == "/tmp/test.crt"
    assert kwargs["ssl_keyfile"] == "/tmp/test.key"
    assert kwargs["port"] == 9443
