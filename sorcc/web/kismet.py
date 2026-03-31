"""SORCC-PI — Kismet REST API client with session caching and response caching."""

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

# Session cache — reuse HTTP session for 60 seconds
_session_cache: requests.Session | None = None
_session_time: float = 0

# Response cache — returns stale data on Kismet timeout instead of 503
_response_cache: dict[str, tuple[float, Any]] = {}
_CACHE_TTL = 30  # seconds


def session() -> requests.Session:
    """Get or create a cached Kismet HTTP session with auth cookies."""
    global _session_cache, _session_time
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
    """GET from Kismet with caching fallback on errors."""
    cache_key = f"GET:{endpoint}:{params}"
    s = session()
    try:
        r = s.get(f"{KISMET_URL}{endpoint}", params=params, timeout=timeout)
        r.raise_for_status()
        result = r.json()
        _response_cache[cache_key] = (time.time(), result)
        return result
    except (requests.ConnectionError, requests.Timeout, Exception) as e:
        if cache_key in _response_cache:
            cached_time, cached_data = _response_cache[cache_key]
            if time.time() - cached_time < _CACHE_TTL:
                log.warning("Kismet GET %s failed, serving %ds-old cache", endpoint, int(time.time() - cached_time))
                return cached_data
        if isinstance(e, requests.ConnectionError):
            raise HTTPException(status_code=502, detail="Kismet not reachable")
        if isinstance(e, requests.Timeout):
            raise HTTPException(status_code=504, detail="Kismet request timed out")
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
    except (requests.ConnectionError, requests.Timeout, Exception) as e:
        if cache_key in _response_cache:
            cached_time, cached_data = _response_cache[cache_key]
            if time.time() - cached_time < _CACHE_TTL:
                log.warning("Kismet POST %s failed, serving %ds-old cache", endpoint, int(time.time() - cached_time))
                return cached_data
        if isinstance(e, requests.ConnectionError):
            raise HTTPException(status_code=502, detail="Kismet not reachable")
        if isinstance(e, requests.Timeout):
            raise HTTPException(status_code=504, detail="Kismet request timed out")
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
