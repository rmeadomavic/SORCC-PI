from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from argus.web import app_state

_AUTH_EXEMPT_PATHS = {"/login", "/api/login", "/api/logout", "/api/status"}
_AUTH_EXEMPT_PREFIXES = ("/static/",)


def make_session_cookie() -> str:
    nonce = secrets.token_hex(16)
    expires = int(time.time()) + app_state.session_timeout_sec
    payload = f"{nonce}:{expires}"
    sig = hmac.new(app_state.session_secret, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def validate_session_cookie(cookie: str) -> bool:
    parts = cookie.split(":")
    if len(parts) != 3:
        return False
    payload = f"{parts[0]}:{parts[1]}"
    expected = hmac.new(app_state.session_secret, payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(parts[2], expected):
        return False
    try:
        return int(parts[1]) > time.time()
    except ValueError:
        return False


def check_rate_limit(client_ip: str) -> bool:
    if client_ip not in app_state.auth_failures:
        return False
    count, last_time = app_state.auth_failures[client_ip]
    if time.time() - last_time > app_state.AUTH_LOCKOUT_SEC:
        del app_state.auth_failures[client_ip]
        return False
    return count >= app_state.AUTH_MAX_FAILURES


def record_auth_failure(client_ip: str) -> None:
    now = time.time()
    if client_ip in app_state.auth_failures:
        count, _ = app_state.auth_failures[client_ip]
        app_state.auth_failures[client_ip] = (count + 1, now)
    else:
        app_state.auth_failures[client_ip] = (1, now)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in _AUTH_EXEMPT_PATHS or any(path.startswith(p) for p in _AUTH_EXEMPT_PREFIXES):
            return await call_next(request)
        if app_state.web_password is None:
            return await call_next(request)

        cookie = request.cookies.get("argus_session", "")
        if cookie and validate_session_cookie(cookie):
            return await call_next(request)

        if path.startswith("/api/"):
            return JSONResponse(status_code=401, content={"detail": "Login required"}, headers={"X-Login-Required": "true"})
        return RedirectResponse(url="/login", status_code=302)
