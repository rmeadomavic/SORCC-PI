"""Argus Dashboard — FastAPI app composition."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from argus.web import app_state
from argus.web.logging_config import setup_logging
from argus.web.middleware import AuthMiddleware, InstructorCORSMiddleware, RequestLogMiddleware, TokenAuthMiddleware, has_token
from argus.web.routers import auth, config, devices, exports, preflight, profiles, status

setup_logging()
log = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(title="Argus RF Survey Dashboard", version="2.0.0")

    app.add_middleware(AuthMiddleware)
    app.add_middleware(InstructorCORSMiddleware)
    if has_token():
        app.add_middleware(TokenAuthMiddleware)
        log.info("Token auth enabled for control endpoints")
    app.add_middleware(RequestLogMiddleware)

    if app_state.STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(app_state.STATIC_DIR)), name="static")

    templates = Jinja2Templates(directory=str(app_state.TEMPLATE_DIR))
    auth.bind_templates(templates)

    app.include_router(auth.router)
    app.include_router(status.router)
    app.include_router(devices.router)
    app.include_router(config.router)
    app.include_router(exports.router)
    app.include_router(preflight.router)
    app.include_router(profiles.router)

    @app.on_event("startup")
    async def _startup_load_web_password():
        app_state.startup_load_web_password()

    @app.on_event("startup")
    async def _startup():
        app_state.startup_events()
        log.info("Argus Dashboard v2.0.0 starting")

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Request, exc: Exception):
        log.error("Unhandled %s on %s: %s", type(exc).__name__, request.url.path, exc)
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})

    return app


app = create_app()

# Backwards-compatible imports for existing tests and callers.
HAS_CONFIG_API = app_state.HAS_CONFIG_API
configure_web_password = app_state.configure_web_password
REDACTED_VALUE = getattr(app_state, "REDACTED_VALUE", "***REDACTED***")
write_config = getattr(app_state, "write_config", None)
restore_backup = getattr(app_state, "restore_backup", None)
get_config_path = getattr(app_state, "get_config_path", None)

config_write = config.config_write
config_import = config.config_import
get_devices = devices.get_devices
get_status = status.get_status
