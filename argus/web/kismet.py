"""Argus — Kismet REST API client with session caching and response caching."""

from __future__ import annotations

import logging
import time
from typing import Any

import requests
from fastapi import HTTPException

log = logging.getLogger(__name__)

KISMET_URL = "http://localhost:2501"
KISMET_USER = "kismet"
KISMET_PASS = "kismet"
_SETTINGS_TTL = 5  # seconds
_settings_time: float = 0
_session_config_key: tuple[str, str, str] | None = None

# Session cache — reuse HTTP session for 60 seconds
_session_cache: requests.Session | None = None
_session_time: float = 0

# Response cache — returns stale data on Kismet timeout instead of 503
_response_cache: dict[str, tuple[float, Any]] = {}
_CACHE_TTL = 30  # seconds


def refresh_settings() -> None:
    """Refresh Kismet connection details from config file if available."""
    global KISMET_URL, KISMET_USER, KISMET_PASS, _settings_time
    now = time.time()
    if (now - _settings_time) < _SETTINGS_TTL:
        return

    try:
        from argus.config_api import read_config_raw

        cfg = read_config_raw()
        kismet_cfg = cfg.get("kismet", {})

        user = kismet_cfg.get("user", "").strip() or "kismet"
        password = kismet_cfg.get("pass", "").strip() or "kismet"
        port_raw = kismet_cfg.get("port", "2501").strip()

        try:
            port = int(port_raw)
        except (TypeError, ValueError):
            port = 2501
            log.warning("Invalid kismet.port '%s' in config, defaulting to 2501", port_raw)

        if port < 1 or port > 65535:
            log.warning("Out-of-range kismet.port %s in config, defaulting to 2501", port)
            port = 2501

        KISMET_USER = user
        KISMET_PASS = password
        KISMET_URL = f"http://localhost:{port}"
    except Exception as e:
        log.debug("Could not refresh Kismet settings from config: %s", e)
    finally:
        _settings_time = now


def session() -> requests.Session:
    """Get or create a cached Kismet HTTP session with auth cookies."""
    global _session_cache, _session_time, _session_config_key
    refresh_settings()
    config_key = (KISMET_URL, KISMET_USER, KISMET_PASS)
    if _session_config_key != config_key:
        _session_cache = None
        _session_config_key = config_key
    if _session_cache and (time.time() - _session_time) < 60:
        return _session_cache
    s = requests.Session()
    s.auth = (KISMET_USER, KISMET_PASS)
    s.headers.update({"Accept": "application/json"})
    try:
        r = s.get(f"{KISMET_URL}/session/check_session", timeout=3)
        if r.status_code == 200 and "KISMET" in r.cookies:
            s.cookies.update(r.cookies)
    except (requests.ConnectionError, requests.Timeout):
        pass
    _session_cache = s
    _session_time = time.time()
    return s


def get(endpoint: str, params: dict | None = None, timeout: int = 8) -> Any:
    """GET from Kismet with caching fallback on connection/timeout errors only."""
    cache_key = f"GET:{endpoint}:{params}"
    s = session()
    try:
        r = s.get(f"{KISMET_URL}{endpoint}", params=params, timeout=timeout)
        r.raise_for_status()
        result = r.json()
        _response_cache[cache_key] = (time.time(), result)
        return result
    except (requests.ConnectionError, requests.Timeout) as e:
        # Network-level failures — serve stale cache if available
        if cache_key in _response_cache:
            cached_time, cached_data = _response_cache[cache_key]
            if time.time() - cached_time < _CACHE_TTL:
                log.warning("Kismet GET %s failed, serving %ds-old cache", endpoint, int(time.time() - cached_time))
                return cached_data
        if isinstance(e, requests.ConnectionError):
            raise HTTPException(status_code=502, detail="Kismet not reachable")
        raise HTTPException(status_code=504, detail="Kismet request timed out")
    except requests.HTTPError as e:
        # HTTP-level errors (401, 403, 500) — do NOT serve stale cache
        raise HTTPException(status_code=e.response.status_code if e.response else 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def post(endpoint: str, data: dict | None = None, timeout: int = 15) -> Any:
    """POST to Kismet (form-encoded) with caching fallback on errors."""
    cache_key = f"POST:{endpoint}"
    s = session()
    try:
        r = s.post(f"{KISMET_URL}{endpoint}", data=data, timeout=timeout)
        r.raise_for_status()
        result = r.json()
        _response_cache[cache_key] = (time.time(), result)
        return result
    except (requests.ConnectionError, requests.Timeout) as e:
        if cache_key in _response_cache:
            cached_time, cached_data = _response_cache[cache_key]
            if time.time() - cached_time < _CACHE_TTL:
                log.warning("Kismet POST %s failed, serving %ds-old cache", endpoint, int(time.time() - cached_time))
                return cached_data
        if isinstance(e, requests.ConnectionError):
            raise HTTPException(status_code=502, detail="Kismet not reachable")
        raise HTTPException(status_code=504, detail="Kismet request timed out")
    except requests.HTTPError as e:
        raise HTTPException(status_code=e.response.status_code if e.response else 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def check_online() -> tuple[bool, int]:
    """Check if Kismet is reachable. Returns (online, device_count)."""
    try:
        r = requests.get(
            f"{KISMET_URL}/system/status.json",
            auth=(KISMET_USER, KISMET_PASS), timeout=3,
        )
        if r.status_code == 200:
            data = r.json()
            return True, data.get("kismet.system.devices.count", 0)
    except Exception:
        pass
    return False, 0
