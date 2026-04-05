import asyncio
import io
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from argus.web import server
from fastapi import HTTPException
from starlette.datastructures import UploadFile


def test_config_import_success(monkeypatch):
    captured_updates: dict = {}

    def fake_write_config(updates):
        captured_updates.update(updates)
        return {"restart_required": [], "skipped": []}

    monkeypatch.setattr(server, "_HAS_CONFIG_API", True)
    monkeypatch.setattr(server, "write_config", fake_write_config)
    monkeypatch.setattr(server, "get_config_path", lambda: "/tmp/argus.ini")
    monkeypatch.setattr(
        "argus.config_schema.validate",
        lambda _path: SimpleNamespace(errors=[], warnings=[]),
    )

    upload = UploadFile(
        filename="argus-config.json",
        file=io.BytesIO(b'{"general":{"callsign":"ARGUS-TEST"}}'),
    )
    response = asyncio.run(server.config_import(upload))

    assert response["status"] == "ok"
    assert captured_updates == {"general": {"callsign": "ARGUS-TEST"}}


def test_config_import_validation_failure_rolls_back(monkeypatch):
    captured_updates: dict = {}
    rollback_called = {"value": False}

    def fake_write_config(updates):
        captured_updates.update(updates)
        return {"restart_required": [], "skipped": []}

    def fake_restore_backup():
        rollback_called["value"] = True
        return True

    monkeypatch.setattr(server, "_HAS_CONFIG_API", True)
    monkeypatch.setattr(server, "write_config", fake_write_config)
    monkeypatch.setattr(server, "restore_backup", fake_restore_backup)
    monkeypatch.setattr(server, "get_config_path", lambda: "/tmp/argus.ini")
    monkeypatch.setattr(
        "argus.config_schema.validate",
        lambda _path: SimpleNamespace(errors=["bad field"], warnings=["warn"]),
    )

    upload = UploadFile(
        filename="argus-config.json",
        file=io.BytesIO(b'{"general":{"callsign":"ARGUS-TEST"}}'),
    )

    try:
        asyncio.run(server.config_import(upload))
        assert False, "Expected config_import to raise HTTPException for validation failure"
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail["message"] == "Config import failed schema validation."
        assert rollback_called["value"] is True
        assert captured_updates == {"general": {"callsign": "ARGUS-TEST"}}
