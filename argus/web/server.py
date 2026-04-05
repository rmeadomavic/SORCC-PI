"""Argus Dashboard — FastAPI application wrapping Kismet REST API."""

from __future__ import annotations

import asyncio
import configparser
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import secrets
import socket
import subprocess
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware

from argus.web import kismet as ks
from argus.web.oui import classify_device
from argus.web.event_logger import events

try:
    from argus.config_api import (
        read_config, write_config, restore_backup, restore_factory,
        has_backup, has_factory, set_config_path, get_config_path,
        REDACTED_VALUE, read_config_raw,
    )
    _HAS_CONFIG_API = True
except ImportError:
    _HAS_CONFIG_API = False

from argus.web.logging_config import setup_logging, ring_handler
setup_logging()
log = logging.getLogger(__name__)

_cached_modem_index: str | None = None
_cached_modem_index_time: float = 0


def _get_modem_index() -> str:
    """Dynamically detect the first ModemManager modem index.

    Modem indices can change across reboots or USB re-enumeration,
    so we parse ``mmcli -L`` rather than hardcoding ``-m 0``.
    Result is cached for 60 seconds to avoid repeated subprocess calls.
    """
    global _cached_modem_index, _cached_modem_index_time
    if _cached_modem_index is not None and (time.time() - _cached_modem_index_time) < 60:
        return _cached_modem_index
    try:
        result = subprocess.run(["mmcli", "-L"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.splitlines():
            if "/Modem/" in line:
                _cached_modem_index = line.strip().split("/Modem/")[1].split()[0]
                _cached_modem_index_time = time.time()
                return _cached_modem_index
    except Exception:
        pass
    return "0"


app = FastAPI(title="Argus RF Survey Dashboard", version="2.0.0")

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
PROJECT_ROOT = BASE_DIR.parent.parent
PROFILES_PATH = PROJECT_ROOT / "profiles.json"

# ---------------------------------------------------------------------------
# Web password auth — matches Hydra's pattern
# ---------------------------------------------------------------------------

_web_password: str | None = None
_session_secret: bytes = secrets.token_bytes(32)  # rotates each boot
_session_timeout_sec: int = 8 * 3600  # 8 hours default

# Rate limiting for login attempts  {ip: (fail_count, last_fail_time)}
_auth_failures: dict[str, tuple[int, float]] = {}
_AUTH_MAX_FAILURES = 10
_AUTH_LOCKOUT_SEC = 300  # 5 minutes


def configure_web_password(password: str | None, timeout_min: int = 480) -> None:
    """Set the dashboard password and session timeout. Called at startup."""
    global _web_password, _session_timeout_sec
    _web_password = password if password else None
    _session_timeout_sec = timeout_min * 60
    if _web_password:
        log.info("Web password auth enabled (session timeout: %d min).", timeout_min)
    else:
        log.info("Web password auth disabled (no password configured).")


def _make_session_cookie() -> str:
    """Create a signed session cookie: nonce:expires:signature."""
    nonce = secrets.token_hex(16)
    expires = int(time.time()) + _session_timeout_sec
    payload = f"{nonce}:{expires}"
    sig = hmac.new(_session_secret, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def _validate_session_cookie(cookie: str) -> bool:
    """Verify HMAC signature and expiry of a session cookie."""
    parts = cookie.split(":")
    if len(parts) != 3:
        return False
    payload = f"{parts[0]}:{parts[1]}"
    expected_sig = hmac.new(_session_secret, payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(parts[2], expected_sig):
        return False
    try:
        return int(parts[1]) > time.time()
    except ValueError:
        return False


def _check_rate_limit(client_ip: str) -> bool:
    """Return True if the client is rate-limited (too many failures)."""
    if client_ip not in _auth_failures:
        return False
    count, last_time = _auth_failures[client_ip]
    if time.time() - last_time > _AUTH_LOCKOUT_SEC:
        del _auth_failures[client_ip]
        return False
    return count >= _AUTH_MAX_FAILURES


def _record_auth_failure(client_ip: str) -> None:
    """Record a failed login attempt for rate limiting."""
    now = time.time()
    if client_ip in _auth_failures:
        count, _ = _auth_failures[client_ip]
        _auth_failures[client_ip] = (count + 1, now)
    else:
        _auth_failures[client_ip] = (1, now)


# Paths that skip password auth entirely
_AUTH_EXEMPT_PATHS = {"/login", "/api/login", "/api/logout", "/api/status"}
_AUTH_EXEMPT_PREFIXES = ("/static/",)


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

_CORS_ALLOWED_PATHS = {"/api/status"}


class _InstructorCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path in _CORS_ALLOWED_PATHS:
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        return response


class _AuthMiddleware(BaseHTTPMiddleware):
    """Redirect unauthenticated requests to /login when a password is set."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Always allow exempt paths
        if path in _AUTH_EXEMPT_PATHS or any(path.startswith(p) for p in _AUTH_EXEMPT_PREFIXES):
            return await call_next(request)

        # If no password configured, allow everything
        if _web_password is None:
            return await call_next(request)

        # Check session cookie
        cookie = request.cookies.get("argus_session", "")
        if cookie and _validate_session_cookie(cookie):
            return await call_next(request)

        # Not authenticated — return 401 for API, redirect for pages
        if path.startswith("/api/"):
            return JSONResponse(
                status_code=401,
                content={"detail": "Login required"},
                headers={"X-Login-Required": "true"},
            )
        return RedirectResponse(url="/login", status_code=302)


app.add_middleware(_AuthMiddleware)
app.add_middleware(_InstructorCORSMiddleware)

# ── Token Auth (optional) — same-origin bypass for dashboard, token for external scripts ──
_AUTH_TOKEN: str | None = None
_AUTH_PROTECTED_PREFIXES = {"/api/profiles/switch", "/api/wifi-capture/toggle", "/api/config"}
_AUTH_OPEN_PREFIXES = {"/api/status", "/api/devices", "/api/activity", "/api/events", "/api/logs", "/api/gps", "/api/export", "/api/cot", "/api/waypoints", "/api/preflight", "/static", "/"}

try:
    import configparser as _cp
    _cfg = _cp.ConfigParser()
    _cfg.read("/opt/argus/config/argus.ini")
    _AUTH_TOKEN = _cfg.get("dashboard", "api_token", fallback="").strip() or None
except Exception:
    pass


class _TokenAuthMiddleware(BaseHTTPMiddleware):
    """Bearer token auth with same-origin bypass.

    Dashboard (same-origin) works without token. External scripts need
    Authorization: Bearer <token> for control endpoints. Read-only
    endpoints are always open.
    """
    async def dispatch(self, request: Request, call_next):
        if not _AUTH_TOKEN:
            return await call_next(request)

        path = request.url.path

        # Open endpoints — no auth required
        for prefix in _AUTH_OPEN_PREFIXES:
            if path == prefix or path.startswith(prefix + "/") or (prefix == "/" and path == "/"):
                return await call_next(request)

        # Same-origin bypass — browser requests from the dashboard itself
        fetch_site = request.headers.get("sec-fetch-site", "")
        origin = request.headers.get("origin", "")

        def _normalized_port(scheme: str, port: int | None) -> int | None:
            if port is not None:
                return port
            if scheme == "http":
                return 80
            if scheme == "https":
                return 443
            return None

        origin_is_app_origin = False
        if origin:
            try:
                parsed_origin = urlparse(origin)
                parsed_scheme = (parsed_origin.scheme or "").lower()
                parsed_host = parsed_origin.hostname

                # Defensive checks: malformed/non-origin style values are untrusted
                if (
                    parsed_scheme in {"http", "https"}
                    and parsed_host
                    and not parsed_origin.username
                    and not parsed_origin.password
                    and parsed_origin.path in {"", "/"}
                    and not parsed_origin.params
                    and not parsed_origin.query
                    and not parsed_origin.fragment
                ):
                    app_scheme = request.base_url.scheme.lower()
                    app_host = request.base_url.hostname
                    origin_port = _normalized_port(parsed_scheme, parsed_origin.port)
                    app_port = _normalized_port(app_scheme, request.base_url.port)
                    origin_is_app_origin = (
                        parsed_scheme == app_scheme
                        and parsed_host == app_host
                        and origin_port == app_port
                    )
            except ValueError:
                origin_is_app_origin = False

        if fetch_site == "same-origin" and origin_is_app_origin:
            return await call_next(request)

        # Check bearer token for external requests to protected endpoints
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer ") and auth_header[7:].strip() == _AUTH_TOKEN:
            return await call_next(request)

        # Protected endpoint, no valid auth
        for prefix in _AUTH_PROTECTED_PREFIXES:
            if path.startswith(prefix):
                return JSONResponse(status_code=401, content={"detail": "Authorization required. Use: Authorization: Bearer <token>"})

        # Everything else — pass through (GET endpoints not in protected list)
        return await call_next(request)


if _AUTH_TOKEN:
    app.add_middleware(_TokenAuthMiddleware)
    log.info("Token auth enabled for control endpoints")


class _RequestLogMiddleware(BaseHTTPMiddleware):
    """Log every API request with method, path, status, and duration. Catch unhandled exceptions."""
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/static"):
            return await call_next(request)
        t0 = time.time()
        try:
            response = await call_next(request)
            dt = (time.time() - t0) * 1000
            lvl = logging.WARNING if response.status_code >= 400 else logging.INFO
            log.log(lvl, f"{request.method} {request.url.path} → {response.status_code} ({dt:.0f}ms)")
            return response
        except Exception as exc:
            dt = (time.time() - t0) * 1000
            log.error(f"{request.method} {request.url.path} → 500 ({dt:.0f}ms) {type(exc).__name__}: {exc}")
            return JSONResponse(status_code=500, content={"detail": "Internal server error"})

app.add_middleware(_RequestLogMiddleware)

@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """Catch-all: return JSON instead of HTML error pages."""
    log.error(f"Unhandled {type(exc).__name__} on {request.url.path}: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

_active_profile: str = "wifi-survey"


@app.on_event("startup")
async def _startup_load_web_password():
    """Read web password from config on startup."""
    if not _HAS_CONFIG_API:
        return
    try:
        cfg = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
        cfg.read(get_config_path())
        password = cfg.get("dashboard", "password", fallback="").strip()
        timeout = cfg.getint("dashboard", "session_timeout_min", fallback=480)
        configure_web_password(password or None, timeout)
    except Exception as e:
        log.warning("Could not read dashboard password config: %s", e)

# classify_device imported from argus.web.oui

# Track first-seen times and packet history for activity metrics
_device_first_seen: dict[str, float] = {}
_device_packet_history: dict[str, list[int]] = {}
_last_device_snapshot: dict[str, int] = {}


def _load_profiles() -> dict:
    try:
        return json.loads(PROFILES_PATH.read_text())
    except Exception as e:
        log.warning("Could not load profiles.json: %s", e)
        return {"default_profile": "wifi-survey", "profiles": []}

def _get_callsign() -> str:
    if _HAS_CONFIG_API:
        try:
            cfg = read_config()
            return cfg.get("general", {}).get("callsign", "ARGUS-01")
        except Exception:
            pass
    return "ARGUS-01"


@app.on_event("startup")
async def _startup():
    log.info("Argus Dashboard v2.0.0 starting")
    # Initialize event logger with configured callsign
    events.callsign = _get_callsign()
    events.log("system_startup", version="2.0.0")
    online, count = ks.check_online()
    if online:
        log.info(f"Kismet online — {count} devices tracked")
        events.log("kismet_connected", device_count=count)
    else:
        log.warning("Kismet not reachable at startup")
        events.log("kismet_offline")
    log.info("Dashboard ready on http://0.0.0.0:8080")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("base.html", {"request": request})

@app.get("/instructor", response_class=HTMLResponse)
async def instructor_page(request: Request):
    return templates.TemplateResponse("instructor.html", {"request": request})


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    # If no password set, just redirect to dashboard
    if _web_password is None:
        return RedirectResponse(url="/", status_code=302)
    # If already authenticated, go to dashboard
    cookie = request.cookies.get("argus_session", "")
    if cookie and _validate_session_cookie(cookie):
        return RedirectResponse(url="/", status_code=302)
    return templates.TemplateResponse("login.html", {
        "request": request,
        "error": request.query_params.get("error", ""),
    })


@app.post("/api/login")
async def api_login(request: Request):
    if _web_password is None:
        return {"status": "ok", "detail": "No password required"}

    client_ip = request.client.host if request.client else "unknown"

    # Rate limiting
    if _check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Too many attempts, try again later")

    try:
        body = await request.json()
        password = body.get("password", "")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    if not password:
        raise HTTPException(status_code=401, detail="Password required")

    if hmac.compare_digest(password, _web_password):
        cookie_value = _make_session_cookie()
        response = JSONResponse(content={"status": "ok"})
        response.set_cookie(
            key="argus_session",
            value=cookie_value,
            httponly=True,
            samesite="lax",
            path="/",
            max_age=_session_timeout_sec,
        )
        # Clear failure count on success
        _auth_failures.pop(client_ip, None)
        return response

    _record_auth_failure(client_ip)
    raise HTTPException(status_code=401, detail="Wrong password")


@app.post("/api/logout")
async def api_logout(request: Request):
    response = JSONResponse(content={"status": "ok"})
    response.delete_cookie(key="argus_session", path="/")
    return response


@app.post("/api/lte/restart")
async def restart_lte():
    try:
        result = subprocess.run(
            ["mmcli", "-m", _get_modem_index(), "--reset"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return {"status": "ok", "detail": "LTE modem resetting"}
        return {"status": "error", "detail": result.stderr.strip() or "Reset command failed"}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="mmcli not found")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Modem reset timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _wifi_capture_status() -> dict[str, Any]:
    """Check WiFi adapter state including external USB adapter detection."""
    result: dict[str, Any] = {
        "active": False, "mode": "unknown", "interface": "wlan0",
        "adapters": [],  # all detected WiFi interfaces with details
        "external_ready": False,  # external adapter plugged in and available
    }
    try:
        # Parse all WiFi interfaces from iw dev
        r = subprocess.run(["iw", "dev"], capture_output=True, text=True, timeout=5)
        current_phy = None
        current_iface: dict[str, str] = {}
        for line in r.stdout.splitlines():
            stripped = line.strip()
            if stripped.startswith("phy#"):
                if current_iface.get("interface"):
                    result["adapters"].append(current_iface)
                current_phy = stripped
                current_iface = {"phy": current_phy}
            elif "Interface" in stripped:
                current_iface["interface"] = stripped.split()[-1]
            elif stripped.startswith("type"):
                current_iface["mode"] = stripped.split()[-1]
            elif stripped.startswith("addr"):
                current_iface["mac"] = stripped.split()[-1]
            elif stripped.startswith("ssid"):
                current_iface["ssid"] = stripped.split(None, 1)[-1]
            elif stripped.startswith("channel"):
                current_iface["channel"] = stripped
        if current_iface.get("interface"):
            result["adapters"].append(current_iface)

        # Identify each adapter's driver (onboard vs external USB)
        for adapter in result["adapters"]:
            iface = adapter.get("interface", "")
            try:
                driver_path = f"/sys/class/net/{iface}/device/driver"
                link = subprocess.run(["readlink", "-f", driver_path], capture_output=True, text=True, timeout=2)
                driver_name = link.stdout.strip().split("/")[-1] if link.returncode == 0 else ""
                adapter["driver"] = driver_name
                adapter["is_onboard"] = driver_name in ("brcmfmac", "brcmsmac")
                # Check if this adapter supports monitor mode
                phy = adapter.get("phy", "").replace("phy#", "phy")
                if phy:
                    phy_info = subprocess.run(["iw", phy, "info"], capture_output=True, text=True, timeout=3)
                    adapter["monitor_capable"] = "* monitor" in phy_info.stdout
                else:
                    adapter["monitor_capable"] = False
            except Exception:
                adapter["driver"] = "unknown"
                adapter["is_onboard"] = False
                adapter["monitor_capable"] = False

        # Set primary interface status
        primary = next((a for a in result["adapters"] if a.get("interface") == "wlan0"), None)
        if primary:
            result["mode"] = primary.get("mode", "unknown")
            result["active"] = primary.get("mode") == "monitor"

        # Check for external (non-onboard) adapters
        externals = [a for a in result["adapters"] if not a.get("is_onboard")]
        if externals:
            result["external_ready"] = True
            result["external_interface"] = externals[0].get("interface", "")
            result["external_driver"] = externals[0].get("driver", "")
            result["note"] = f"External adapter detected: {externals[0].get('interface')} ({externals[0].get('driver')})"
        elif len(result["adapters"]) <= 1:
            result["note"] = "No external WiFi adapter — plug in an Alpha/Panda USB adapter for capture"
    except Exception:
        pass
    return result


@app.get("/api/wifi-capture/status")
async def wifi_capture_status():
    return _wifi_capture_status()


@app.post("/api/wifi-capture/toggle")
async def wifi_capture_toggle():
    """Toggle wlan0 between managed (WiFi connectivity) and monitor (Kismet capture).

    When enabling capture: disconnect WiFi, set monitor mode, add wlan0 to Kismet.
    When disabling capture: remove wlan0 from Kismet, restore managed mode, reconnect WiFi.
    LTE + Tailscale remain available throughout.

    Runs in a thread pool to avoid blocking the event loop during sleeps/subprocesses.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _wifi_capture_toggle_sync)


def _wifi_capture_toggle_sync():
    """Synchronous WiFi capture toggle — called via run_in_executor."""
    current = _wifi_capture_status()

    if current["active"]:
        # ── Disable capture: monitor → managed ──
        # 1. Remove wlan0 source from Kismet
        try:
            s = ks.session()
            r = s.get(f"{ks.KISMET_URL}/datasource/all_sources.json", timeout=5)
            if r.status_code == 200:
                all_sources = r.json()
                for src in all_sources if isinstance(all_sources, list) else []:
                    iface = src.get("kismet.datasource.interface", "")
                    if "wlan0" in iface:
                        uuid = src.get("kismet.datasource.uuid")
                        if uuid:
                            s.post(f"{ks.KISMET_URL}/datasource/by-uuid/{uuid}/close_source.cmd", timeout=5)
        except Exception as e:
            log.warning("Could not remove wlan0 from Kismet: %s", e)

        # 2. Restore managed mode — brcmfmac needs full driver reload after monitor mode
        try:
            subprocess.run(["ip", "link", "set", "wlan0", "down"], timeout=5)
            subprocess.run(["modprobe", "-r", "brcmfmac"], timeout=10)
            time.sleep(2)
            subprocess.run(["modprobe", "brcmfmac"], timeout=10)
            # Wait for wlan0 to reappear after driver reload
            for _ in range(10):
                r = subprocess.run(["ip", "link", "show", "wlan0"], capture_output=True, timeout=5)
                if r.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("wlan0 did not reappear after driver reload")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to restore managed mode: {e}")

        # 3. Reconnect WiFi via NetworkManager — wait for NM to detect the interface, then connect
        try:
            subprocess.run(["nmcli", "device", "set", "wlan0", "managed", "yes"], timeout=5)
            time.sleep(3)  # Let NM scan for networks
            subprocess.run(["nmcli", "device", "wifi", "rescan"], capture_output=True, timeout=5)
            time.sleep(4)  # Wait for scan results
            # Find first WiFi connection profile and activate it
            r = subprocess.run(
                ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"],
                capture_output=True, text=True, timeout=5
            )
            for line in r.stdout.strip().splitlines():
                parts = line.split(":")
                if len(parts) >= 2 and parts[-1] == "802-11-wireless":
                    subprocess.run(["nmcli", "connection", "up", parts[0]], capture_output=True, timeout=15)
                    break
        except Exception as e:
            log.warning("WiFi reconnect failed (LTE still available): %s", e)

        # 4. Restart Kismet to restore clean source state (BT adapter)
        try:
            subprocess.run(["systemctl", "restart", "kismet"], timeout=30)
            log.info("Kismet restarted after WiFi capture disable")
        except Exception as e:
            log.warning("Kismet restart failed after WiFi disable: %s", e)

        events.log("wifi_capture_disabled")
        return {"status": "ok", "active": False, "detail": "WiFi capture disabled — connectivity restored, Kismet restarting"}
    else:
        # ── Enable capture: managed → monitor ──
        # 1. Disconnect WiFi
        try:
            subprocess.run(["nmcli", "device", "disconnect", "wlan0"], capture_output=True, timeout=5)
        except Exception:
            pass

        # 2. Set monitor mode
        try:
            subprocess.run(["ip", "link", "set", "wlan0", "down"], timeout=5, check=True)
            subprocess.run(["iw", "dev", "wlan0", "set", "type", "monitor"], timeout=5, check=True)
            subprocess.run(["ip", "link", "set", "wlan0", "up"], timeout=5, check=True)
        except subprocess.CalledProcessError as e:
            # Try to restore managed on failure
            subprocess.run(["iw", "dev", "wlan0", "set", "type", "managed"], capture_output=True, timeout=5)
            subprocess.run(["ip", "link", "set", "wlan0", "up"], capture_output=True, timeout=5)
            raise HTTPException(status_code=500, detail=f"Failed to set monitor mode: {e}")

        # 3. Restart Kismet so it picks up wlan0 in monitor mode as a source
        #    Hot-adding sources is unreliable with brcmfmac — clean restart is safer
        source_added = False
        try:
            subprocess.run(["systemctl", "restart", "kismet"], timeout=30)
            time.sleep(3)
            # Verify wlan0 source appeared
            try:
                s = ks.session()
                r = s.get(f"{ks.KISMET_URL}/datasource/all_sources.json", timeout=5)
                if r.status_code == 200:
                    verify_sources = r.json()
                    for src in verify_sources if isinstance(verify_sources, list) else []:
                        if "wlan0" in src.get("kismet.datasource.interface", ""):
                            source_added = True
                            break
            except Exception:
                pass
            if not source_added:
                # Fallback: try hot-add
                s = ks.session()
                r = s.post(
                    f"{ks.KISMET_URL}/datasource/add_source.cmd",
                    json={"definition": "wlan0:name=WiFi-Capture,hop=true"},
                    timeout=10,
                )
                source_added = r.status_code == 200
        except Exception as e:
            log.warning("Could not add wlan0 to Kismet: %s", e)

        detail = "WiFi capture enabled — wlan0 in monitor mode"
        events.log("wifi_capture_enabled", source_added=source_added)
        if not source_added:
            detail += " (warning: could not add to Kismet automatically)"
        return {"status": "ok", "active": True, "detail": detail}


@app.post("/api/wifi/apply")
async def apply_wifi():
    """Apply WiFi config to NetworkManager."""
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=500, detail="Config API not available")
    try:
        # Command execution paths must read raw config values; API helpers may redact
        # secrets (e.g., wifi.password) for responses and would break nmcli calls.
        cfg = read_config_raw()
        ssid = cfg.get("wifi", {}).get("ssid", "").strip()
        password = cfg.get("wifi", {}).get("password", "").strip()
        country = cfg.get("wifi", {}).get("country_code", "US").strip()
        if not ssid:
            return {"status": "ok", "detail": "No SSID configured — WiFi auto-connect disabled"}

        # Set regulatory domain
        subprocess.run(["iw", "reg", "set", country], capture_output=True, timeout=5)

        # Check if connection already exists
        check = subprocess.run(
            ["nmcli", "-t", "-f", "NAME", "connection", "show"],
            capture_output=True, text=True, timeout=5
        )
        conn_exists = ssid in check.stdout.splitlines()

        if conn_exists:
            # Update existing connection
            result = subprocess.run(
                ["nmcli", "connection", "modify", ssid,
                 "wifi-sec.psk", password,
                 "connection.autoconnect", "yes",
                 "connection.autoconnect-priority", "100"],
                capture_output=True, text=True, timeout=10
            )
        else:
            # Create new connection
            result = subprocess.run(
                ["nmcli", "connection", "add",
                 "type", "wifi",
                 "con-name", ssid,
                 "ssid", ssid,
                 "wifi-sec.key-mgmt", "wpa-psk",
                 "wifi-sec.psk", password,
                 "connection.autoconnect", "yes",
                 "connection.autoconnect-priority", "100"],
                capture_output=True, text=True, timeout=10
            )

        if result.returncode == 0:
            action = "updated" if conn_exists else "created"
            return {"status": "ok", "detail": f"WiFi connection '{ssid}' {action}"}
        return {"status": "error", "detail": result.stderr.strip() or "nmcli command failed"}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="nmcli not found — NetworkManager not installed")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="WiFi configuration timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/status")
async def get_status():
    status: dict[str, Any] = {
        "kismet": False, "modem": False, "gps": False, "battery": None,
        "tailscale_ip": None, "hostname": None, "uptime": None,
        "device_count": 0, "active_profile": _active_profile,
        "callsign": _get_callsign(),
        "wifi_capture": False,
        "wifi_external": False,
    }
    _wcap = _wifi_capture_status()
    status["wifi_capture"] = _wcap.get("active", False)
    status["wifi_external"] = _wcap.get("external_ready", False)

    async def _run(cmd: list[str], timeout: float = 5) -> tuple[str, int]:
        """Run subprocess without blocking the event loop."""
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return stdout.decode(), proc.returncode or 0
        except (asyncio.TimeoutError, FileNotFoundError, OSError):
            return "", 1

    async def _check_kismet():
        try:
            loop = asyncio.get_running_loop()
            r = await loop.run_in_executor(None, lambda: requests.get(
                f"{ks.KISMET_URL}/system/status.json",
                auth=(ks.KISMET_USER, ks.KISMET_PASS), timeout=2))
            if r.status_code == 200:
                status["kismet"] = True
                data = r.json()
                if isinstance(data, dict):
                    status["device_count"] = data.get("kismet.system.devices.count", 0)
        except Exception:
            pass

    async def _check_modem():
        out, _ = await _run(["mmcli", "-L"])
        status["modem"] = "/" in out

    async def _check_gps():
        modem_idx = _get_modem_index()
        out, _ = await _run(["mmcli", "-m", modem_idx, "--location-get"])
        has_nmea = "nmea" in out.lower()
        has_fix = "latitude" in out.lower()
        if has_nmea and not has_fix:
            for line in out.splitlines():
                if "$GPGGA" in line:
                    parts = line.split(",")
                    if len(parts) > 6 and parts[6] not in ("", "0"):
                        has_fix = True
                        break
        status["gps"] = has_fix
        status["gps_enabled"] = has_nmea

    async def _check_battery():
        # PiSugar battery check via its local TCP interface — fast TCP probe first
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", 8423), timeout=0.1)
            writer.write(b"get battery\n")
            await writer.drain()
            out = await asyncio.wait_for(reader.read(256), timeout=0.15)
            text = out.decode().strip()
            if text:
                parts = text.split(":")
                if len(parts) >= 2:
                    status["battery"] = float(parts[1].strip())
        except (asyncio.TimeoutError, ConnectionRefusedError, OSError, ValueError):
            pass
        finally:
            if writer:
                writer.close()

    async def _check_tailscale():
        out, rc = await _run(["tailscale", "ip", "-4"], timeout=3)
        if rc == 0 and out.strip():
            status["tailscale_ip"] = out.strip()

    # Run all checks in parallel
    t0 = time.time()
    results = await asyncio.gather(
        _check_kismet(), _check_modem(), _check_gps(),
        _check_battery(), _check_tailscale(),
        return_exceptions=True,
    )
    log.debug("Status checks took %.0fms", (time.time() - t0) * 1000)

    try:
        status["hostname"] = socket.gethostname()
        with open("/proc/uptime") as f:
            uptime_sec = float(f.read().split()[0])
            hours = int(uptime_sec // 3600)
            minutes = int((uptime_sec % 3600) // 60)
            status["uptime"] = f"{hours}h {minutes}m"
    except Exception:
        pass
    return status


@app.get("/api/devices")
async def get_devices():
    try:
        data = ks.post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr", "kismet.device.base.name", "kismet.device.base.commonname",
            "kismet.device.base.type", "kismet.device.base.phyname",
            "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.signal/kismet.common.signal.max_signal",
            "kismet.device.base.channel", "kismet.device.base.frequency",
            "kismet.device.base.first_time", "kismet.device.base.last_time",
            "kismet.device.base.packets.total",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except HTTPException:
        return []
    now = time.time()
    devices = []
    for d in data if isinstance(data, list) else []:
        mac = d.get("kismet.device.base.macaddr", "")
        name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
        dev_type = d.get("kismet.device.base.type", "")
        packets = d.get("kismet.device.base.packets.total", 0)
        first_time = d.get("kismet.device.base.first_time", 0)
        last_time = d.get("kismet.device.base.last_time", 0)

        # Manufacturer & category classification
        classification = classify_device(mac, name, dev_type)

        # Track first-seen for "new device" detection
        if mac and mac not in _device_first_seen:
            _device_first_seen[mac] = now

        # Calculate packet rate (packets per interval)
        prev_packets = _last_device_snapshot.get(mac, 0)
        packet_delta = max(0, packets - prev_packets)
        _last_device_snapshot[mac] = packets

        # Activity level: 0-3 based on packet rate
        if packet_delta > 20:
            activity = 3  # high
        elif packet_delta > 5:
            activity = 2  # medium
        elif packet_delta > 0:
            activity = 1  # low
        else:
            activity = 0  # idle

        ssid = d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "")
        device = {
            "mac": mac,
            "name": name or ssid or "",
            "type": dev_type,
            "phy": d.get("kismet.device.base.phyname", ""),
            "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0),
            "max_signal": d.get("kismet.device.base.signal/kismet.common.signal.max_signal", 0),
            "channel": d.get("kismet.device.base.channel", ""),
            "frequency": d.get("kismet.device.base.frequency", 0),
            "packets": packets,
            "ssid": ssid,
            "first_seen": first_time,
            "last_seen": last_time,
            "manufacturer": classification["manufacturer"],
            "category": classification["category"],
            "icon": classification["icon"],
            "activity": activity,
            "packet_delta": packet_delta,
            "is_new": (now - _device_first_seen.get(mac, now)) < 60,
        }
        devices.append(device)
    # Sort by activity first (most active on top), then by packets
    devices.sort(key=lambda x: (x["activity"], x["packets"]), reverse=True)
    return devices


@app.get("/api/devices/located")
async def get_located_devices():
    """Return devices that have GPS coordinates for map plotting."""
    try:
        data = ks.post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr", "kismet.device.base.name", "kismet.device.base.commonname",
            "kismet.device.base.type", "kismet.device.base.phyname",
            "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.channel",
            "kismet.device.base.packets.total",
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except HTTPException:
        return []
    located: list[dict[str, Any]] = []
    for d in data if isinstance(data, list) else []:
        geopoint = d.get("kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint")
        if not geopoint or not isinstance(geopoint, list) or len(geopoint) < 2:
            continue
        lon, lat = geopoint[0], geopoint[1]
        if lat == 0 and lon == 0:
            continue
        name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
        ssid = d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "")
        located.append({
            "mac": d.get("kismet.device.base.macaddr", ""),
            "name": name or ssid or d.get("kismet.device.base.macaddr", "Unknown"),
            "phy": d.get("kismet.device.base.phyname", ""),
            "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0),
            "channel": d.get("kismet.device.base.channel", ""),
            "packets": d.get("kismet.device.base.packets.total", 0),
            "lat": lat,
            "lon": lon,
        })
    return located


@app.get("/api/target/{query}")
async def get_target_rssi(query: str):
    """Hunt a device by SSID name or MAC address. Supports both WiFi and BT."""
    # Detect if query looks like a MAC address
    is_mac_query = len(query.replace(":", "").replace("-", "")) == 12 and all(c in "0123456789abcdefABCDEF" for c in query.replace(":", "").replace("-", ""))
    result: dict[str, Any] = {
        "query": query, "mode": "mac" if is_mac_query else "ssid",
        "found": False, "signal": -100, "max_signal": -100,
        "mac": "", "channel": "", "gps": None, "timestamp": time.time(),
        "packets": 0, "packet_delta": 0, "activity": 0,
        "manufacturer": "", "category": "",
    }
    log.info(f"Hunt: query='{query}' is_mac={is_mac_query}")
    events.log("hunt_query", query=query, mode="mac" if is_mac_query else "ssid")
    try:
        data = ks.post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr", "kismet.device.base.name", "kismet.device.base.commonname",
            "kismet.device.base.type",
            "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.signal/kismet.common.signal.max_signal",
            "kismet.device.base.channel", "kismet.device.base.packets.total",
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except HTTPException:
        return result

    best_signal = -100
    best_device = None
    best_packets = 0

    for d in data if isinstance(data, list) else []:
        mac = d.get("kismet.device.base.macaddr", "")
        matched = False
        if is_mac_query:
            # MAC-based hunt (BT or WiFi)
            if query.lower().replace("-", ":") == mac.lower():
                matched = True
        else:
            # SSID-based hunt (WiFi)
            device_ssid = d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "")
            name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
            if (device_ssid and query.lower() in device_ssid.lower()) or (name and query.lower() in name.lower()):
                matched = True

        if matched:
            # Kismet flattens nested paths: "a/b" returns as "b"
            sig = d.get("kismet.common.signal.last_signal", d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0))
            packets = d.get("kismet.device.base.packets.total", 0)
            log.debug(f"Hunt match: mac={mac} sig={sig} pkts={packets}")
            # For MAC hunt (usually BT), always take the match — use packets as tiebreaker
            if is_mac_query:
                best_device = d
                best_signal = sig
                best_packets = packets
                break  # Exact MAC match, no need to keep searching
            # For SSID hunt, rank by signal (WiFi) or packets (BT/no signal)
            elif sig != 0 and sig > best_signal:
                best_signal = sig
                best_device = d
                best_packets = packets
            elif (sig == 0 or sig == -100) and packets > best_packets:
                best_packets = packets
                best_device = d

    if best_device:
        mac = best_device.get("kismet.device.base.macaddr", "")
        packets = best_device.get("kismet.device.base.packets.total", 0)
        sig = best_device.get("kismet.common.signal.last_signal", best_device.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0))
        name = best_device.get("kismet.device.base.commonname") or best_device.get("kismet.device.base.name", "")
        classification = classify_device(mac, name, best_device.get("kismet.device.base.type", ""))

        # Packet delta for BT proximity
        prev = _last_device_snapshot.get(f"hunt_{mac}", 0)
        delta = max(0, packets - prev)
        _last_device_snapshot[f"hunt_{mac}"] = packets

        result["found"] = True
        result["signal"] = sig if sig != 0 else -100
        result["max_signal"] = best_device.get("kismet.common.signal.max_signal", best_device.get("kismet.device.base.signal/kismet.common.signal.max_signal", sig))
        result["mac"] = mac
        result["name"] = name
        result["channel"] = best_device.get("kismet.device.base.channel", "")
        result["packets"] = packets
        result["packet_delta"] = delta
        result["activity"] = 3 if delta > 20 else 2 if delta > 5 else 1 if delta > 0 else 0
        result["manufacturer"] = classification["manufacturer"]
        result["category"] = classification["category"]
        geopoint = best_device.get("kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint")
        if geopoint and isinstance(geopoint, list) and len(geopoint) >= 2:
            result["gps"] = {"lat": geopoint[1], "lon": geopoint[0]}
    return result


@app.get("/api/activity")
async def get_activity():
    """Return recently discovered devices and activity metrics."""
    now = time.time()
    recent = []
    for mac, first in sorted(_device_first_seen.items(), key=lambda x: x[1], reverse=True):
        age = now - first
        if age > 300:  # Only last 5 minutes
            break
        cls = classify_device(mac, "", "")
        recent.append({
            "mac": mac,
            "seconds_ago": int(age),
            "manufacturer": cls["manufacturer"],
            "category": cls["category"],
        })
        if len(recent) >= 50:
            break
    return {
        "total_seen": len(_device_first_seen),
        "recent_5min": len([1 for _, t in _device_first_seen.items() if now - t < 300]),
        "recent_1min": len([1 for _, t in _device_first_seen.items() if now - t < 60]),
        "feed": recent[:20],
    }


@app.get("/api/events")
async def event_stream():
    """Server-Sent Events stream for real-time dashboard updates.

    Pushes device count changes, new discoveries, and status every 2s.
    Clients connect with EventSource and get instant updates vs polling.
    """

    async def generate():
        last_count = 0
        while True:
            try:
                # Check device count
                online, count = ks.check_online()
                if count != last_count:
                    yield f"event: device_count\ndata: {json.dumps({'count': count, 'delta': count - last_count})}\n\n"
                    last_count = count

                # Check for new devices in last 10 seconds
                now = time.time()
                new_macs = [mac for mac, t in _device_first_seen.items() if now - t < 10]
                if new_macs:
                    new_devices = []
                    for mac in new_macs[:5]:
                        cls = classify_device(mac, "", "")
                        new_devices.append({"mac": mac, "manufacturer": cls["manufacturer"], "category": cls["category"]})
                    yield f"event: new_devices\ndata: {json.dumps(new_devices)}\n\n"

                # Heartbeat
                yield f"event: heartbeat\ndata: {json.dumps({'ts': now, 'online': online})}\n\n"

            except Exception:
                yield f"event: error\ndata: {json.dumps({'msg': 'stream error'})}\n\n"

            await asyncio.sleep(2)

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/logs")
async def get_logs(n: int = 100, level: str | None = None):
    """Return recent log entries from the in-memory ring buffer."""
    entries = ring_handler.get_recent(n=min(n, 500), level=level)
    return {"count": len(entries), "entries": entries}


@app.get("/api/events/history")
async def get_events_history(n: int = 50):
    """Return recent operator events from today's event log (after-action review)."""
    return {"events": events.get_recent(n=min(n, 200))}


@app.get("/api/gps")
async def get_gps():
    gps: dict[str, Any] = {"lat": None, "lon": None, "alt": None, "source": None}
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: subprocess.run(
            ["mmcli", "-m", _get_modem_index(), "--location-get"], capture_output=True, text=True, timeout=5))
        for line in result.stdout.splitlines():
            line = line.strip()
            if "latitude" in line.lower():
                try: gps["lat"] = float(line.split(":")[-1].strip())
                except ValueError: pass
            elif "longitude" in line.lower():
                try: gps["lon"] = float(line.split(":")[-1].strip())
                except ValueError: pass
            elif "altitude" in line.lower():
                try: gps["alt"] = float(line.split(":")[-1].strip())
                except ValueError: pass
        if gps["lat"] is not None:
            gps["source"] = "modem"
    except Exception:
        pass
    if gps["lat"] is None:
        try:
            data = ks.get("/gps/location.json")
            if data and isinstance(data, dict):
                loc = data.get("kismet.common.location.last", {})
                gps["lat"] = loc.get("kismet.common.location.lat")
                gps["lon"] = loc.get("kismet.common.location.lon")
                gps["alt"] = loc.get("kismet.common.location.alt")
                gps["source"] = "kismet"
        except Exception:
            pass
    return gps


@app.get("/api/export/kml")
async def export_kml():
    import glob as glob_mod
    output_kml = "/tmp/argus-survey-export.kml"

    # Try kismetdb_to_kml first (best quality — uses full capture data)
    capture_dirs = ["/opt/argus/output_data", "/root", "/tmp"]
    kismet_files: list[str] = []
    for d in capture_dirs:
        kismet_files.extend(glob_mod.glob(f"{d}/*.kismet"))
        kismet_files.extend(glob_mod.glob(f"{d}/Kismet-*.kismet"))
    if not kismet_files:
        kismet_files.extend(glob_mod.glob("/home/*/*.kismet"))
        kismet_files.extend(glob_mod.glob("/home/*/Kismet-*.kismet"))
    if kismet_files:
        latest = max(kismet_files, key=lambda f: Path(f).stat().st_mtime)
        if subprocess.run(["which", "kismetdb_to_kml"], capture_output=True).returncode == 0:
            result = subprocess.run(["kismetdb_to_kml", "-v", "--in", latest, "--out", output_kml], capture_output=True, text=True, timeout=30)
            if result.returncode == 0 and Path(output_kml).exists():
                events.log("export_generated", format="kml", source="kismetdb")
                return FileResponse(output_kml, media_type="application/vnd.google-earth.kml+xml", filename="argus-survey.kml")

    # Fallback: generate KML from GPS-located devices via Kismet API
    located = _fetch_located_devices_for_cot()
    if not located:
        raise HTTPException(status_code=404, detail="No GPS-located devices found. Get a GPS fix outdoors first.")
    kml = ET.Element("kml", xmlns="http://www.opengis.net/kml/2.2")
    doc = ET.SubElement(kml, "Document")
    ET.SubElement(doc, "name").text = "Argus RF Survey Export"
    for device, classification in located:
        pm = ET.SubElement(doc, "Placemark")
        ET.SubElement(pm, "name").text = device.get("name") or device.get("mac", "Unknown")
        sig = device.get("signal", 0)
        pkts = device.get("packets", 0)
        sig_text = f"{sig} dBm" if sig != 0 else f"{pkts} pkts"
        desc = f"{classification.get('manufacturer', 'Unknown')} | {sig_text} | {device['phy']} | {device['mac']}"
        ET.SubElement(pm, "description").text = desc
        point = ET.SubElement(pm, "Point")
        ET.SubElement(point, "coordinates").text = f"{device['lon']},{device['lat']},0"
    tree = ET.ElementTree(kml)
    tree.write(output_kml, xml_declaration=True, encoding="utf-8")
    events.log("export_generated", format="kml", source="api", device_count=len(located))
    return FileResponse(output_kml, media_type="application/vnd.google-earth.kml+xml", filename="argus-survey.kml")


@app.get("/api/export/csv")
async def export_csv():
    devices = await get_devices()
    buf = io.StringIO()
    fieldnames = ["mac", "name", "type", "phy", "signal", "max_signal", "channel", "packets", "ssid", "last_seen"]
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for dev in devices:
        writer.writerow({k: dev.get(k, "") for k in fieldnames})
    return Response(content=buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=argus-devices.csv"})


# ── CoT XML Export (ATAK Integration) ────────────────────────────────

def _cot_type_for_device(category: str, phy: str) -> str:
    """Map device category + PHY to MIL-STD-2525 CoT type code for ATAK.

    Type format: a-{affiliation}-G-{battle dimension}-{function}
    Affiliation: u=unknown, f=friendly, n=neutral, h=hostile
    Using 'u' (unknown) for all detected devices — operators reclassify in ATAK.
    """
    # PHY-specific overrides
    phy_lower = (phy or "").lower()
    if "802.11" in phy_lower:
        # WiFi devices get electronic warfare / signals intelligence codes
        return {
            "network": "a-u-G-I-E",       # unknown ground infrastructure electronic
            "phone":   "a-u-G-U-C-I",     # unknown ground unit civilian individual
            "laptop":  "a-u-G-U-C-I",     # unknown ground unit civilian individual
            "other":   "a-u-G-E-S",       # unknown ground electronic sensor
        }.get(category, "a-u-G-E-S")
    if "bluetooth" in phy_lower:
        return {
            "phone":    "a-u-G-U-C-I",    # unknown ground unit civilian individual
            "wearable": "a-u-G-U-C-I",    # unknown ground unit civilian individual
            "laptop":   "a-u-G-U-C-I",    # unknown ground unit civilian individual
            "speaker":  "a-u-G-I",        # unknown ground infrastructure
            "vehicle":  "a-u-G-E-V",      # unknown ground electronic vehicle
            "network":  "a-u-G-I-E",      # unknown ground infrastructure electronic
            "iot":      "a-u-G-I-E",      # unknown ground infrastructure electronic
            "tv":       "a-u-G-I",        # unknown ground infrastructure
        }.get(category, "a-u-G-E")
    if "rtl433" in phy_lower:
        return "a-u-G-E-S"                # unknown ground electronic sensor
    if "adsb" in phy_lower:
        return "a-u-A"                     # unknown air

    # Fallback by category only
    return {
        "phone":   "a-u-G-U-C-I",
        "vehicle": "a-u-G-E-V",
        "network": "a-u-G-I-E",
        "iot":     "a-u-G-I-E",
    }.get(category, "a-u-G")


def _build_cot_event(device: dict, classification: dict) -> ET.Element:
    """Build a single CoT <event> XML element for an ATAK-compatible device."""
    mac = device.get("mac", "000000000000")
    short_mac = mac.replace(":", "")[-6:].upper()
    now = datetime.now(timezone.utc)
    stale = now + timedelta(minutes=5)
    iso_now = now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    iso_stale = stale.strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    cot_type = _cot_type_for_device(classification.get("category", "other"), device.get("phy", ""))

    event = ET.Element("event", {
        "version": "2.0",
        "uid": f"ARGUS-{mac}",
        "type": cot_type,
        "time": iso_now,
        "start": iso_now,
        "stale": iso_stale,
        "how": "m-g",
    })

    ET.SubElement(event, "point", {
        "lat": str(device.get("lat", 0)),
        "lon": str(device.get("lon", 0)),
        "hae": "0",
        "ce": "50",
        "le": "50",
    })

    detail = ET.SubElement(event, "detail")

    # Build a meaningful callsign: manufacturer + short MAC
    mfr = classification.get("manufacturer", "")
    callsign_parts = []
    if mfr and mfr != "Random BLE" and mfr != "Unknown":
        callsign_parts.append(mfr[:12])
    callsign_parts.append(short_mac)
    ET.SubElement(detail, "contact", callsign="-".join(callsign_parts))

    # Remarks with full device context
    phy_label = device.get("phy", "Unknown")
    category = classification.get("category", "other")
    packets = device.get("packets", 0)
    signal = device.get("signal", 0)
    sig_text = f"{signal} dBm" if signal != 0 else f"{packets} pkts"
    remarks = ET.SubElement(detail, "remarks")
    remarks.text = f"[{phy_label}] {mfr or 'Unknown'} ({category}) | {sig_text} | {packets} pkts"

    # Color-code by PHY type in ATAK
    phy_lower = (device.get("phy", "")).lower()
    if "802.11" in phy_lower:
        group_color, group_role = "Green", "HQ"
    elif "bluetooth" in phy_lower:
        group_color, group_role = "Cyan", "Team Member"
    elif "rtl433" in phy_lower:
        group_color, group_role = "Yellow", "Team Member"
    else:
        group_color, group_role = "White", "Team Member"
    ET.SubElement(detail, "__group", name=group_color, role=group_role)

    return event


def _fetch_located_devices_for_cot() -> list[tuple[dict, dict]]:
    """Fetch all located devices from Kismet and return (device, classification) tuples."""
    try:
        data = ks.post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr", "kismet.device.base.name", "kismet.device.base.commonname",
            "kismet.device.base.type", "kismet.device.base.phyname",
            "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.channel",
            "kismet.device.base.packets.total",
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except HTTPException:
        return []

    results: list[tuple[dict, dict]] = []
    for d in data if isinstance(data, list) else []:
        geopoint = d.get("kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint")
        if not geopoint or not isinstance(geopoint, list) or len(geopoint) < 2:
            continue
        lon, lat = geopoint[0], geopoint[1]
        if lat == 0 and lon == 0:
            continue
        mac = d.get("kismet.device.base.macaddr", "")
        name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
        dev_type = d.get("kismet.device.base.type", "")
        classification = classify_device(mac, name, dev_type)
        device = {
            "mac": mac,
            "name": name or d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "") or mac,
            "phy": d.get("kismet.device.base.phyname", ""),
            "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0),
            "channel": d.get("kismet.device.base.channel", ""),
            "packets": d.get("kismet.device.base.packets.total", 0),
            "lat": lat,
            "lon": lon,
        }
        results.append((device, classification))
    return results


@app.get("/api/cot")
async def export_cot_all():
    """Export CoT XML for all located devices (ATAK integration)."""
    located = _fetch_located_devices_for_cot()
    if not located:
        raise HTTPException(status_code=404, detail="No devices with GPS coordinates found")

    cot_events = ET.Element("events")
    for device, classification in located:
        cot_events.append(_build_cot_event(device, classification))

    xml_bytes = ET.tostring(cot_events, encoding="unicode", xml_declaration=False)
    xml_out = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_bytes
    return Response(content=xml_out, media_type="application/xml")


@app.get("/api/cot/self")
async def export_cot_self():
    """Export CoT XML for the Pi's own position (sensor platform SA).

    Standard ATAK practice: the sensor platform broadcasts its own position
    so operators can see where the SIGINT payload is on the map.
    """
    gps = await get_gps()
    if not gps.get("lat") or not gps.get("lon"):
        raise HTTPException(status_code=404, detail="No GPS fix — take Pi outdoors for satellite lock")

    callsign = _get_callsign()
    now = datetime.now(timezone.utc)
    stale = now + timedelta(minutes=2)
    iso_now = now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    iso_stale = stale.strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    event = ET.Element("event", {
        "version": "2.0",
        "uid": f"ARGUS-PLATFORM-{callsign}",
        "type": "a-f-G-E-S",  # friendly ground electronic sensor
        "time": iso_now,
        "start": iso_now,
        "stale": iso_stale,
        "how": "m-g",
    })
    ET.SubElement(event, "point", {
        "lat": str(gps["lat"]),
        "lon": str(gps["lon"]),
        "hae": str(gps.get("alt") or 0),
        "ce": "10",
        "le": "10",
    })
    detail = ET.SubElement(event, "detail")
    ET.SubElement(detail, "contact", callsign=callsign)
    remarks = ET.SubElement(detail, "remarks")
    remarks.text = f"Argus RF Sensor Platform | Source: {gps.get('source', 'unknown')}"
    ET.SubElement(detail, "__group", name="Blue", role="Team Lead")

    xml_bytes = ET.tostring(event, encoding="unicode", xml_declaration=False)
    xml_out = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_bytes
    return Response(content=xml_out, media_type="application/xml")


@app.get("/api/cot/{mac}")
async def export_cot_device(mac: str):
    """Export CoT XML for a specific device by MAC address (ATAK integration)."""
    mac_normalized = mac.strip().upper()
    located = _fetch_located_devices_for_cot()

    for device, classification in located:
        if device["mac"].upper() == mac_normalized:
            event = _build_cot_event(device, classification)
            xml_bytes = ET.tostring(event, encoding="unicode", xml_declaration=False)
            xml_out = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_bytes
            return Response(content=xml_out, media_type="application/xml")

    raise HTTPException(status_code=404, detail=f"Device {mac} not found or has no GPS coordinates")


@app.get("/api/waypoints")
async def export_waypoints():
    """Export GPS-located devices as QGC WPL 110 waypoint file (Mission Planner compatible).

    Each located device becomes a waypoint. Useful for autonomous hunt missions:
    fly to each device's last-known position for signal convergence.
    """
    located = _fetch_located_devices_for_cot()
    if not located:
        raise HTTPException(status_code=404, detail="No devices with GPS coordinates found")

    # Sort by signal strength (strongest first) for prioritized investigation
    located.sort(key=lambda x: x[0].get("signal", -999), reverse=True)

    lines = ["QGC WPL 110"]
    # Line 0: home position (first waypoint or 0,0)
    home_lat = located[0][0].get("lat", 0)
    home_lon = located[0][0].get("lon", 0)
    # seq  current  frame  cmd  p1  p2  p3  p4  lat  lon  alt  autocontinue
    lines.append(f"0\t1\t0\t16\t0\t0\t0\t0\t{home_lat:.8f}\t{home_lon:.8f}\t50.0\t1")

    for i, (device, classification) in enumerate(located, start=1):
        lat = device.get("lat", 0)
        lon = device.get("lon", 0)
        alt = 50.0  # Default loiter altitude in meters
        # MAV_CMD_NAV_WAYPOINT (16), loiter 5s at each target
        lines.append(f"{i}\t0\t3\t16\t5.0\t0\t0\t0\t{lat:.8f}\t{lon:.8f}\t{alt:.1f}\t1")

    content = "\n".join(lines) + "\n"
    return Response(
        content=content,
        media_type="text/plain",
        headers={"Content-Disposition": "attachment; filename=argus-hunt-waypoints.waypoints"},
    )


@app.get("/api/config/full")
async def config_read():
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        return read_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {e}")


@app.get("/api/config/schema")
async def config_schema():
    """Expose config schema metadata for UI mapping validation."""
    from argus.config_schema import SCHEMA

    sections: dict[str, dict[str, dict[str, Any]]] = {}
    for section, fields in SCHEMA.items():
        sections[section] = {}
        for key, spec in fields.items():
            sections[section][key] = {
                "type": spec.type.value,
                "required": spec.required,
            }
    return {"sections": sections}


@app.post("/api/config/full")
async def config_write(request: Request):
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        updates = await request.json()
        write_result = write_config(updates)
        events.log("config_updated", sections=list(updates.keys()) if isinstance(updates, dict) else [])

        # Reload web password if it was changed
        dash = updates.get("dashboard", {})
        if isinstance(dash, dict) and "password" in dash:
            pw = dash["password"]
            if pw and pw != REDACTED_VALUE:
                configure_web_password(pw, _session_timeout_sec // 60)

        # Validate after write and return any issues
        from argus.config_schema import validate
        vr = validate("/opt/argus/config/argus.ini")
        result: dict[str, Any] = {"status": "ok", "skipped": write_result.get("skipped", [])}
        if vr.errors:
            result["validation_errors"] = vr.errors
            result["status"] = "warn"
        if vr.warnings:
            result["validation_warnings"] = vr.warnings
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {e}")

@app.post("/api/config/restore-backup")
async def config_restore_backup():
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    if not has_backup():
        raise HTTPException(status_code=404, detail="No backup file found")
    restore_backup()
    return {"status": "ok", "detail": "Restored from backup"}

@app.post("/api/config/factory-reset")
async def config_factory_reset():
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    if not has_factory():
        raise HTTPException(status_code=404, detail="No factory defaults file found")
    restore_factory()
    return {"status": "ok", "detail": "Restored factory defaults"}

@app.get("/api/config/validate")
async def config_validate():
    """Validate the current config and return plain-English errors/warnings."""
    from argus.config_schema import validate
    vr = validate("/opt/argus/config/argus.ini")
    return {"ok": vr.ok, "errors": vr.errors, "warnings": vr.warnings}


@app.get("/api/config/export")
async def config_export():
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        cfg = read_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {e}")
    content = json.dumps(cfg, indent=2)
    return Response(content=content, media_type="application/json", headers={"Content-Disposition": "attachment; filename=argus-config.json"})

@app.post("/api/config/import")
async def config_import(file: UploadFile = File(...)):
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        raw = await file.read()
        updates = json.loads(raw)
        write_config(updates)
        return {"status": "ok", "detail": "Config imported successfully"}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")


def _run_check(name, category, fn):
    try:
        status, detail = fn()
        return {"name": name, "category": category, "status": status, "detail": detail}
    except Exception as e:
        return {"name": name, "category": category, "status": "fail", "detail": str(e)}


async def _run_check_async(name, category, fn):
    """Run a blocking preflight check in an executor to avoid blocking the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_check, name, category, fn)

def _check_sdr():
    result = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=5)
    if "RTL2832" in result.stdout or "Realtek" in result.stdout or "Nooelec" in result.stdout:
        return "pass", "RTL-SDR device detected"
    return "warn", "No RTL-SDR device found"

def _check_serial():
    found = [p for p in ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2"] if Path(p).exists()]
    if found: return "pass", f"Serial devices: {', '.join(found)}"
    return "warn", "No serial devices found"

def _check_bluetooth():
    result = subprocess.run(["hciconfig"], capture_output=True, text=True, timeout=5)
    if "hci0" in result.stdout:
        if "UP RUNNING" in result.stdout: return "pass", "hci0 is UP and RUNNING"
        return "warn", "hci0 found but not running"
    return "fail", "No Bluetooth adapter found"

def _check_pisugar():
    result = subprocess.run(["bash", "-c", 'echo "get battery" | nc -q 1 127.0.0.1 8423'], capture_output=True, text=True, timeout=3)
    if result.returncode == 0 and "battery" in result.stdout.lower():
        return "pass", result.stdout.strip()
    return "warn", "PiSugar not responding"

def _check_service(name):
    def _inner():
        result = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True, timeout=5)
        state = result.stdout.strip()
        if state == "active": return "pass", f"{name} is active"
        return "fail", f"{name} is {state or 'unknown'}"
    return _inner

def _check_lte_modem():
    result = subprocess.run(["mmcli", "-L"], capture_output=True, text=True, timeout=5)
    if "/" in result.stdout: return "pass", "LTE modem detected"
    return "fail", "No LTE modem detected"

def _check_internet():
    result = subprocess.run(["ping", "-c", "1", "-W", "3", "8.8.8.8"], capture_output=True, text=True, timeout=5)
    if result.returncode == 0: return "pass", "Internet reachable"
    return "fail", "Cannot reach 8.8.8.8"

def _check_tailscale():
    result = subprocess.run(["tailscale", "status"], capture_output=True, text=True, timeout=5)
    if result.returncode == 0 and result.stdout.strip(): return "pass", "Tailscale connected"
    return "warn", "Tailscale not connected"

def _check_wifi():
    iface = "wlan0"
    if _HAS_CONFIG_API:
        try:
            cfg = read_config()
            iface = cfg.get("kismet", {}).get("source_wifi", "") or "wlan0"
            # Strip any Kismet source options (e.g. "wlan0:hop=true" -> "wlan0")
            iface = iface.split(":")[0]
        except Exception:
            pass
    result = subprocess.run(["ip", "link", "show", iface], capture_output=True, text=True, timeout=5)
    if result.returncode == 0: return "pass", f"{iface} interface present"
    return "warn", f"{iface} not found"

def _check_wifi_conflict():
    if not _HAS_CONFIG_API:
        return "skip", "Config API not available"
    try:
        cfg = read_config_raw()
        monitor_iface = cfg.get("kismet", {}).get("source_wifi", "").split(":")[0].strip()
        connect_ssid = cfg.get("wifi", {}).get("ssid", "").strip()
        if not monitor_iface or not connect_ssid:
            return "pass", "No conflict (one or both WiFi uses unconfigured)"
        # Check if the monitor interface is the same one NetworkManager would use for auto-connect
        result = subprocess.run(
            ["nmcli", "-t", "-f", "DEVICE", "connection", "show", "--active"],
            capture_output=True, text=True, timeout=5
        )
        active_devices = result.stdout.strip().splitlines()
        if monitor_iface in active_devices:
            return "warn", f"{monitor_iface} is used for both Kismet monitor and WiFi — use a second adapter"
        return "pass", f"Monitor ({monitor_iface}) and WiFi auto-connect on separate adapters"
    except Exception as e:
        return "warn", f"Could not check adapter conflict: {e}"

def _check_kismet_config():
    for p in [Path("/etc/kismet/kismet_site.conf"), Path("/usr/local/etc/kismet/kismet_site.conf")]:
        if p.exists(): return "pass", f"Found at {p}"
    return "warn", "No kismet_site.conf found"

def _check_kismet_credentials():
    try:
        r = requests.get(f"{ks.KISMET_URL}/session/check_session", auth=(ks.KISMET_USER, ks.KISMET_PASS), timeout=3)
        if r.status_code == 200: return "pass", "Credentials valid"
        return "warn", f"HTTP {r.status_code}"
    except requests.ConnectionError:
        return "fail", "Cannot connect to Kismet"

def _check_source_config():
    profiles = _load_profiles()
    active = next((p for p in profiles.get("profiles", []) if p.get("id") == _active_profile), None)
    if not active: return "warn", f"Profile '{_active_profile}' not found"
    sources = active.get("kismet_sources", {})
    configured = [k for k, v in sources.items() if v]
    if configured: return "pass", f"Active sources: {', '.join(configured)}"
    return "fail", "No sources configured"

def _check_gps_fix():
    result = subprocess.run(["mmcli", "-m", _get_modem_index(), "--location-get"], capture_output=True, text=True, timeout=5)
    lat, lon = None, None
    for line in result.stdout.splitlines():
        line = line.strip().lower()
        if "latitude" in line:
            try: lat = float(line.split(":")[-1].strip())
            except ValueError: pass
        elif "longitude" in line:
            try: lon = float(line.split(":")[-1].strip())
            except ValueError: pass
    if lat is not None and lon is not None:
        return "pass", f"Fix: {lat:.5f}, {lon:.5f}"
    return "warn", "No GPS fix yet"

def _check_disk_space():
    result = subprocess.run(["df", "-h", "/"], capture_output=True, text=True, timeout=5)
    lines = result.stdout.strip().split("\n")
    if len(lines) >= 2:
        parts = lines[1].split()
        if len(parts) >= 5:
            use_pct = int(parts[4].replace("%", ""))
            avail = parts[3]
            if use_pct > 90: return "fail", f"{avail} free ({use_pct}% used)"
            if use_pct > 75: return "warn", f"{avail} free ({use_pct}% used)"
            return "pass", f"{avail} free ({use_pct}% used)"
    return "warn", "Could not determine disk usage"

def _check_time_sync():
    result = subprocess.run(["timedatectl", "show", "--property=NTPSynchronized"], capture_output=True, text=True, timeout=5)
    if "yes" in result.stdout.lower(): return "pass", "NTP synchronized"
    # Check if time is at least reasonable (after 2025)
    if time.time() > 1735689600: return "warn", "NTP not synced but clock looks reasonable"
    return "fail", "Clock may be wrong — NTP not synchronized"


@app.get("/api/preflight")
async def preflight():
    checks = await asyncio.gather(
        _run_check_async("SDR (RTL2832U)", "hardware", _check_sdr),
        _run_check_async("Serial Devices", "hardware", _check_serial),
        _run_check_async("Bluetooth (hci0)", "hardware", _check_bluetooth),
        _run_check_async("PiSugar Battery", "hardware", _check_pisugar),
        _run_check_async("Kismet", "services", _check_service("kismet")),
        _run_check_async("argus-dashboard", "services", _check_service("argus-dashboard")),
        _run_check_async("argus-boot", "services", _check_service("argus-boot")),
        _run_check_async("avahi-daemon", "services", _check_service("avahi-daemon")),
        _run_check_async("LTE Modem", "network", _check_lte_modem),
        _run_check_async("Internet", "network", _check_internet),
        _run_check_async("Tailscale", "network", _check_tailscale),
        _run_check_async("WiFi (wlan0)", "network", _check_wifi),
        _run_check_async("WiFi Adapter Conflict", "network", _check_wifi_conflict),
        _run_check_async("GPS Fix", "network", _check_gps_fix),
        _run_check_async("Kismet Config", "config", _check_kismet_config),
        _run_check_async("Kismet Credentials", "config", _check_kismet_credentials),
        _run_check_async("Source Config", "config", _check_source_config),
        _run_check_async("Disk Space", "config", _check_disk_space),
        _run_check_async("Time Sync", "config", _check_time_sync),
    )
    statuses = [c["status"] for c in checks]
    overall = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
    return {"status": overall, "checks": list(checks)}


@app.get("/api/profiles")
async def list_profiles():
    return _load_profiles().get("profiles", [])

@app.get("/api/profiles/active")
async def get_active_profile():
    profiles = _load_profiles()
    for p in profiles.get("profiles", []):
        if p.get("id") == _active_profile:
            return {"active": _active_profile, "profile": p}
    return {"active": _active_profile, "profile": None}

def _iface_has_active_connection(iface: str) -> bool:
    """Check if a network interface has an active NetworkManager connection."""
    try:
        r = subprocess.run(
            ["nmcli", "-t", "-f", "DEVICE,STATE", "device", "status"],
            capture_output=True, text=True, timeout=5,
        )
        for line in r.stdout.strip().splitlines():
            parts = line.split(":", 1)
            if len(parts) == 2 and parts[0] == iface and parts[1] == "connected":
                return True
    except Exception:
        pass
    return False


@app.post("/api/profiles/switch")
async def switch_profile(request: Request):
    global _active_profile
    body = await request.json()
    profile_id = body.get("id")
    force = body.get("force", False)
    if not profile_id:
        raise HTTPException(status_code=400, detail="Missing 'id' in request body")
    profiles = _load_profiles()
    target = next((p for p in profiles.get("profiles", []) if p.get("id") == profile_id), None)
    if not target:
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    sources = target.get("kismet_sources", {})
    errors: list[str] = []
    warnings: list[str] = []

    # Guard: prevent Kismet from stealing wlan0 if it's the active connectivity interface
    wifi_source = sources.get("wifi", "")
    if wifi_source and not force:
        # Extract interface name from source definition (e.g. "wlan0" or "wlan0:name=foo")
        iface = wifi_source.split(":")[0]
        if _iface_has_active_connection(iface):
            return JSONResponse(
                status_code=409,
                content={
                    "status": "blocked",
                    "detail": (
                        f"'{iface}' is your active network connection. "
                        f"Switching to '{target['name']}' will put it into monitor mode "
                        f"and kill WiFi connectivity. Use a second USB WiFi adapter for "
                        f"monitoring, or pass {{\"force\": true}} to override."
                    ),
                    "active": _active_profile,
                },
            )

    try:
        s = ks.session()
        try:
            r = s.get(f"{ks.KISMET_URL}/datasource/all_sources.json", timeout=5)
            if r.status_code == 200:
                current_sources = r.json()
                for src in current_sources if isinstance(current_sources, list) else []:
                    uuid = src.get("kismet.datasource.uuid")
                    if uuid:
                        try: s.post(f"{ks.KISMET_URL}/datasource/by-uuid/{uuid}/close_source.cmd", timeout=5)
                        except Exception: pass
        except Exception as e:
            errors.append(f"Could not query sources: {e}")
        for source_type, source_def in sources.items():
            if source_def:
                try: s.post(f"{ks.KISMET_URL}/datasource/add_source.cmd", json={"definition": source_def}, timeout=10)
                except Exception as e: errors.append(f"Failed to add {source_type} '{source_def}': {e}")
    except Exception as e:
        errors.append(f"Kismet reconfiguration failed: {e}")
    _active_profile = profile_id
    events.log("mode_switched", profile=_active_profile, errors=errors or None)
    result: dict[str, Any] = {"status": "ok" if not errors else "partial", "active": _active_profile, "profile": target}
    if errors: result["errors"] = errors
    if warnings: result["warnings"] = warnings
    return result
