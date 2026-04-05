from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from argus.web import app_state
from argus.web.event_logger import events

router = APIRouter()


@router.get("/api/config/full")
async def config_read():
    if not app_state.HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    return app_state.read_config()


@router.get("/api/config/schema")
async def config_schema():
    from argus.config_schema import SCHEMA
    sections: dict[str, dict[str, dict[str, Any]]] = {}
    for section, fields in SCHEMA.items():
        sections[section] = {k: {"type": spec.type.value, "required": spec.required} for k, spec in fields.items()}
    return {"sections": sections}


@router.post("/api/config/full")
async def config_write(request: Request):
    if not app_state.HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    updates = await request.json()
    write_result = app_state.write_config(updates)
    events.log("config_updated", sections=list(updates.keys()) if isinstance(updates, dict) else [])
    dash = updates.get("dashboard", {}) if isinstance(updates, dict) else {}
    if isinstance(dash, dict) and "password" in dash:
        pw = dash["password"]
        if pw and pw != app_state.REDACTED_VALUE:
            app_state.configure_web_password(pw, app_state.session_timeout_sec // 60)
    from argus.config_schema import validate
    vr = validate(str(app_state.get_config_path()))
    result: dict[str, Any] = {"status": "ok", "restart_required": write_result.get("restart_required", []), "skipped": write_result.get("skipped", [])}
    if vr.errors:
        result["validation_errors"] = vr.errors
        result["status"] = "warn"
    if vr.warnings:
        result["validation_warnings"] = vr.warnings
    return result


@router.post("/api/config/import")
async def config_import(file: UploadFile = File(...)):
    if not app_state.HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    raw = await file.read()
    try:
        updates = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON in uploaded config file at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(updates, dict):
        raise HTTPException(status_code=422, detail="Invalid config payload: top-level JSON value must be an object keyed by section name.")
    write_result = app_state.write_config(updates)
    from argus.config_schema import validate
    vr = validate(str(app_state.get_config_path()))
    if vr.errors:
        rollback_ok = app_state.restore_backup()
        if not rollback_ok:
            raise HTTPException(status_code=500, detail="Config import failed schema validation and rollback failed: no backup file available to restore previous config.")
        raise HTTPException(status_code=422, detail={"message": "Config import failed schema validation.", "errors": vr.errors, "warnings": vr.warnings, "skipped": write_result.get("skipped", [])})
    result: dict[str, Any] = {"status": "ok", "detail": "Config imported successfully", "skipped": write_result.get("skipped", [])}
    if vr.warnings:
        result["validation_warnings"] = vr.warnings
    return result


@router.get("/api/config/export")
async def config_export():
    cfg = app_state.read_config()
    return Response(content=json.dumps(cfg, indent=2), media_type="application/json", headers={"Content-Disposition": "attachment; filename=argus-config.json"})


@router.post('/api/config/restore-backup')
async def config_restore_backup():
    if not app_state.has_backup():
        raise HTTPException(status_code=404, detail='No backup file found')
    app_state.restore_backup()
    return {'status': 'ok', 'detail': 'Restored from backup'}


@router.post('/api/config/factory-reset')
async def config_factory_reset():
    if not app_state.has_factory():
        raise HTTPException(status_code=404, detail='No factory defaults file found')
    app_state.restore_factory()
    return {'status': 'ok', 'detail': 'Restored factory defaults'}


@router.get('/api/config/validate')
async def config_validate():
    from argus.config_schema import validate
    vr = validate(str(app_state.get_config_path()))
    return {'ok': vr.ok, 'errors': vr.errors, 'warnings': vr.warnings}
