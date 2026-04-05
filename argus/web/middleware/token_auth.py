from __future__ import annotations

import configparser
from urllib.parse import urlparse

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

_AUTH_TOKEN: str | None = None
_AUTH_PROTECTED_PREFIXES = {"/api/profiles/switch", "/api/wifi-capture/toggle", "/api/config"}
_AUTH_OPEN_PREFIXES = {"/api/status", "/api/devices", "/api/activity", "/api/events", "/api/logs", "/api/gps", "/api/export", "/api/cot", "/api/waypoints", "/api/preflight", "/static", "/"}

try:
    cfg = configparser.ConfigParser()
    cfg.read("/opt/argus/config/argus.ini")
    _AUTH_TOKEN = cfg.get("dashboard", "api_token", fallback="").strip() or None
except Exception:
    pass


def has_token() -> bool:
    return bool(_AUTH_TOKEN)


class TokenAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not _AUTH_TOKEN:
            return await call_next(request)

        path = request.url.path
        for prefix in _AUTH_OPEN_PREFIXES:
            if path == prefix or path.startswith(prefix + "/") or (prefix == "/" and path == "/"):
                return await call_next(request)

        fetch_site = request.headers.get("sec-fetch-site", "")
        origin = request.headers.get("origin", "")

        def norm_port(scheme: str, port: int | None) -> int | None:
            if port is not None:
                return port
            if scheme == "http":
                return 80
            if scheme == "https":
                return 443
            return None

        same_origin = False
        if origin:
            try:
                parsed = urlparse(origin)
                if parsed.scheme in {"http", "https"} and parsed.hostname and parsed.path in {"", "/"}:
                    app_scheme = request.base_url.scheme.lower()
                    same_origin = (
                        parsed.scheme.lower() == app_scheme
                        and parsed.hostname == request.base_url.hostname
                        and norm_port(parsed.scheme.lower(), parsed.port) == norm_port(app_scheme, request.base_url.port)
                    )
            except ValueError:
                same_origin = False

        if fetch_site == "same-origin" and same_origin:
            return await call_next(request)

        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer ") and auth_header[7:].strip() == _AUTH_TOKEN:
            return await call_next(request)

        for prefix in _AUTH_PROTECTED_PREFIXES:
            if path.startswith(prefix):
                return JSONResponse(status_code=401, content={"detail": "Authorization required. Use: Authorization: Bearer <token>"})
        return await call_next(request)
