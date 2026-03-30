"""SORCC-PI Dashboard — FastAPI application wrapping Kismet REST API."""

from __future__ import annotations

import csv
import io
import json
import logging
import socket
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware

try:
    from sorcc.config_api import (
        read_config, write_config, restore_backup, restore_factory,
        has_backup, has_factory,
    )
    _HAS_CONFIG_API = True
except ImportError:
    _HAS_CONFIG_API = False

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="SORCC RF Survey Dashboard", version="2.0.0")

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
PROJECT_ROOT = BASE_DIR.parent.parent
PROFILES_PATH = PROJECT_ROOT / "profiles.json"

_CORS_ALLOWED_PATHS = {"/api/status"}

class _InstructorCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path in _CORS_ALLOWED_PATHS:
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        return response

app.add_middleware(_InstructorCORSMiddleware)

if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

KISMET_URL = "http://localhost:2501"
KISMET_USER = "kismet"
KISMET_PASS = "kismet"
_active_profile: str = "wifi-survey"


_kismet_session_cache: requests.Session | None = None
_kismet_session_time: float = 0

def kismet_session() -> requests.Session:
    global _kismet_session_cache, _kismet_session_time
    # Reuse cached session for up to 60 seconds
    if _kismet_session_cache and (time.time() - _kismet_session_time) < 60:
        return _kismet_session_cache
    s = requests.Session()
    s.auth = (KISMET_USER, KISMET_PASS)
    s.headers.update({"Accept": "application/json"})
    try:
        r = s.get(f"{KISMET_URL}/session/check_session", timeout=3)
        if r.status_code == 200 and "KISMET" in r.cookies:
            s.cookies.update(r.cookies)
    except (requests.ConnectionError, requests.Timeout):
        pass
    _kismet_session_cache = s
    _kismet_session_time = time.time()
    return s


# Response cache: returns stale data on Kismet timeout instead of 503
_response_cache: dict[str, tuple[float, Any]] = {}
_CACHE_TTL = 30  # seconds — serve cached data up to 30s old on error


def kismet_get(endpoint, params=None, timeout=8):
    cache_key = f"GET:{endpoint}:{params}"
    s = kismet_session()
    try:
        r = s.get(f"{KISMET_URL}{endpoint}", params=params, timeout=timeout)
        r.raise_for_status()
        result = r.json()
        _response_cache[cache_key] = (time.time(), result)
        return result
    except (requests.ConnectionError, requests.Timeout, Exception) as e:
        # Return cached data if available
        if cache_key in _response_cache:
            cached_time, cached_data = _response_cache[cache_key]
            if time.time() - cached_time < _CACHE_TTL:
                log.warning(f"Kismet GET {endpoint} failed, returning cached data ({time.time() - cached_time:.0f}s old)")
                return cached_data
        if isinstance(e, requests.ConnectionError):
            raise HTTPException(status_code=502, detail="Kismet not reachable on port 2501")
        elif isinstance(e, requests.Timeout):
            raise HTTPException(status_code=504, detail="Kismet request timed out")
        raise HTTPException(status_code=500, detail=str(e))


def kismet_post(endpoint, data=None, timeout=15):
    cache_key = f"POST:{endpoint}"
    s = kismet_session()
    try:
        # Use form-encoded data (Kismet expects json= as form field, not JSON body)
        r = s.post(f"{KISMET_URL}{endpoint}", data=data, timeout=timeout)
        r.raise_for_status()
        result = r.json()
        _response_cache[cache_key] = (time.time(), result)
        return result
    except (requests.ConnectionError, requests.Timeout, Exception) as e:
        if cache_key in _response_cache:
            cached_time, cached_data = _response_cache[cache_key]
            if time.time() - cached_time < _CACHE_TTL:
                log.warning(f"Kismet POST {endpoint} failed, returning cached data ({time.time() - cached_time:.0f}s old)")
                return cached_data
        if isinstance(e, requests.ConnectionError):
            raise HTTPException(status_code=502, detail="Kismet not reachable on port 2501")
        elif isinstance(e, requests.Timeout):
            raise HTTPException(status_code=504, detail="Kismet request timed out")
        raise HTTPException(status_code=500, detail=str(e))


# ── BT Manufacturer & Device Classification ─────────────────────────
# Compact OUI table: first 3 bytes of MAC → (manufacturer, category)
# Categories: phone, wearable, laptop, tablet, speaker, beacon, vehicle, iot, network, other
_OUI_TABLE: dict[str, tuple[str, str]] = {
    "00:17:C9": ("Apple", "phone"), "04:15:52": ("Apple", "phone"),
    "04:E5:36": ("Apple", "phone"), "08:66:98": ("Apple", "phone"),
    "0C:51:01": ("Apple", "phone"), "10:94:BB": ("Apple", "phone"),
    "14:7D:DA": ("Apple", "phone"), "18:3E:EF": ("Apple", "phone"),
    "1C:36:BB": ("Apple", "phone"), "20:78:F0": ("Apple", "phone"),
    "24:A2:E1": ("Apple", "phone"), "28:6A:BA": ("Apple", "phone"),
    "2C:BE:EB": ("Apple", "phone"), "3C:06:30": ("Apple", "phone"),
    "40:B3:95": ("Apple", "phone"), "44:2A:60": ("Apple", "phone"),
    "48:A9:1C": ("Apple", "phone"), "4C:57:CA": ("Apple", "phone"),
    "54:4E:90": ("Apple", "phone"), "58:B0:35": ("Apple", "phone"),
    "5C:97:F3": ("Apple", "phone"), "60:83:E7": ("Apple", "phone"),
    "64:B0:A6": ("Apple", "phone"), "68:DB:F5": ("Apple", "phone"),
    "6C:94:66": ("Apple", "phone"), "70:3E:AC": ("Apple", "phone"),
    "78:7E:61": ("Apple", "phone"), "7C:D1:C3": ("Apple", "phone"),
    "80:BE:05": ("Apple", "phone"), "84:FC:FE": ("Apple", "phone"),
    "88:66:A5": ("Apple", "phone"), "8C:85:90": ("Apple", "phone"),
    "90:8D:6C": ("Apple", "phone"), "94:E9:79": ("Apple", "phone"),
    "98:01:A7": ("Apple", "phone"), "9C:20:7B": ("Apple", "phone"),
    "A0:99:9B": ("Apple", "phone"), "A4:83:E7": ("Apple", "phone"),
    "A8:5C:2C": ("Apple", "phone"), "AC:BC:32": ("Apple", "phone"),
    "B0:19:C6": ("Apple", "phone"), "B8:53:AC": ("Apple", "phone"),
    "BC:52:B7": ("Apple", "phone"), "C0:A5:3E": ("Apple", "phone"),
    "C8:69:CD": ("Apple", "phone"), "CC:08:8D": ("Apple", "phone"),
    "D0:81:7A": ("Apple", "phone"), "D4:61:9D": ("Apple", "phone"),
    "D8:1C:79": ("Apple", "phone"), "DC:A4:CA": ("Apple", "phone"),
    "E0:5F:45": ("Apple", "phone"), "E4:C6:3D": ("Apple", "phone"),
    "F0:18:98": ("Apple", "phone"), "F4:5C:89": ("Apple", "phone"),
    "F8:4D:89": ("Apple", "phone"),
    # Samsung
    "00:07:AB": ("Samsung", "phone"), "00:12:FB": ("Samsung", "phone"),
    "00:1A:8A": ("Samsung", "phone"), "00:21:19": ("Samsung", "phone"),
    "00:26:37": ("Samsung", "phone"), "08:D4:6A": ("Samsung", "phone"),
    "10:D5:42": ("Samsung", "phone"), "14:49:E0": ("Samsung", "phone"),
    "18:3A:2D": ("Samsung", "phone"), "1C:AF:05": ("Samsung", "phone"),
    "24:18:1D": ("Samsung", "phone"), "28:CC:01": ("Samsung", "phone"),
    "30:07:4D": ("Samsung", "phone"), "34:23:BA": ("Samsung", "phone"),
    "38:01:95": ("Samsung", "phone"), "40:4E:36": ("Samsung", "phone"),
    "44:78:3E": ("Samsung", "phone"), "4C:3C:16": ("Samsung", "phone"),
    "50:01:BB": ("Samsung", "phone"), "54:40:AD": ("Samsung", "phone"),
    "58:C3:8B": ("Samsung", "phone"), "64:77:91": ("Samsung", "phone"),
    "6C:F3:73": ("Samsung", "phone"), "78:47:1D": ("Samsung", "phone"),
    "84:25:DB": ("Samsung", "phone"), "8C:F5:A3": ("Samsung", "phone"),
    "94:01:C2": ("Samsung", "phone"), "98:52:B1": ("Samsung", "phone"),
    "A0:82:1F": ("Samsung", "phone"), "A8:7C:01": ("Samsung", "phone"),
    "B4:79:C8": ("Samsung", "phone"), "BC:14:EF": ("Samsung", "phone"),
    "C4:50:06": ("Samsung", "phone"), "CC:07:AB": ("Samsung", "phone"),
    "D0:22:BE": ("Samsung", "phone"), "E4:7D:BD": ("Samsung", "phone"),
    "F0:25:B7": ("Samsung", "phone"), "FC:A1:83": ("Samsung", "phone"),
    # Google
    "08:9E:08": ("Google", "phone"), "30:FD:38": ("Google", "speaker"),
    "48:D6:D5": ("Google", "speaker"), "54:60:09": ("Google", "speaker"),
    "A4:77:33": ("Google", "phone"), "F4:F5:D8": ("Google", "speaker"),
    "F4:F5:E8": ("Google", "speaker"),
    # Wearables
    "B0:B2:8F": ("Fitbit", "wearable"), "C8:FF:77": ("Fitbit", "wearable"),
    "E6:D5:7A": ("Fitbit", "wearable"),
    "D4:22:CD": ("Garmin", "wearable"), "C8:3E:99": ("Garmin", "wearable"),
    "EC:85:2F": ("Garmin", "wearable"),
    # Amazon
    "10:2C:6B": ("Amazon", "speaker"), "34:D2:70": ("Amazon", "speaker"),
    "44:00:49": ("Amazon", "speaker"), "50:DC:E7": ("Amazon", "speaker"),
    "68:37:E9": ("Amazon", "speaker"), "74:C2:46": ("Amazon", "speaker"),
    "A0:02:DC": ("Amazon", "speaker"), "FC:65:DE": ("Amazon", "speaker"),
    # Microsoft
    "28:18:78": ("Microsoft", "laptop"), "7C:1E:52": ("Microsoft", "laptop"),
    "C8:3D:D4": ("Microsoft", "laptop"),
    # Intel (laptops/PCs)
    "00:1E:64": ("Intel", "laptop"), "3C:A9:F4": ("Intel", "laptop"),
    "60:57:18": ("Intel", "laptop"), "80:86:F2": ("Intel", "laptop"),
    "A4:C4:94": ("Intel", "laptop"), "DC:1B:A1": ("Intel", "laptop"),
    # Networking / Routers
    "00:1A:2B": ("Cisco", "network"), "00:50:56": ("VMware", "network"),
    "28:AF:42": ("ARRIS", "network"), "20:10:7A": ("ARRIS", "network"),
    "E8:65:D4": ("Netgear", "network"), "C4:04:15": ("Netgear", "network"),
    "10:0C:6B": ("Netgear", "network"), "A4:2B:B0": ("TP-Link", "network"),
    "50:C7:BF": ("TP-Link", "network"), "C0:25:E9": ("TP-Link", "network"),
    "B0:4E:26": ("TP-Link", "network"), "C8:A6:EF": ("ZTE", "phone"),
    "00:04:3E": ("Telit", "iot"),
    "B8:27:EB": ("Raspberry Pi", "iot"), "DC:A6:32": ("Raspberry Pi", "iot"),
    "D8:3A:DD": ("Raspberry Pi", "iot"), "2C:CF:67": ("Raspberry Pi", "iot"),
    # Vehicles / Automotive
    "04:52:C7": ("Tesla", "vehicle"), "4C:FC:AA": ("Tesla", "vehicle"),
    # Beacons / Trackers
    "E8:59:0C": ("Tile", "beacon"), "F0:13:C3": ("Chipolo", "beacon"),
    # Meta / Reality Labs
    "2C:26:17": ("Meta", "wearable"),
    # LG
    "00:1C:62": ("LG", "phone"), "10:68:3F": ("LG", "phone"),
    "30:76:6F": ("LG", "phone"), "64:89:9A": ("LG", "phone"),
    "88:C9:D0": ("LG", "phone"), "BC:F5:AC": ("LG", "phone"),
    # Xiaomi
    "04:CF:8C": ("Xiaomi", "phone"), "28:6C:07": ("Xiaomi", "phone"),
    "34:CE:00": ("Xiaomi", "phone"), "50:64:2B": ("Xiaomi", "iot"),
    "64:CC:2E": ("Xiaomi", "phone"), "78:11:DC": ("Xiaomi", "phone"),
    # Huawei / Honor
    "00:46:4B": ("Huawei", "phone"), "04:B0:E7": ("Huawei", "phone"),
    "20:A6:80": ("Huawei", "phone"), "48:DB:50": ("Huawei", "phone"),
    "70:8C:B6": ("Huawei", "phone"), "CC:A2:23": ("Huawei", "phone"),
    # Sony
    "00:1D:BA": ("Sony", "phone"), "04:5D:4B": ("Sony", "phone"),
    "AC:9B:0A": ("Sony", "phone"),
    # OnePlus
    "94:65:2D": ("OnePlus", "phone"), "C0:EE:FB": ("OnePlus", "phone"),
    # Motorola / Lenovo
    "00:04:0E": ("Motorola", "phone"), "9C:D3:5B": ("Motorola", "phone"),
    "C8:14:51": ("Motorola", "phone"),
    # Bose
    "04:52:C7": ("Bose", "speaker"), "28:11:A5": ("Bose", "speaker"),
    "4C:87:5D": ("Bose", "speaker"),
    # JBL / Harman
    "00:02:5B": ("JBL", "speaker"), "30:C0:1B": ("JBL", "speaker"),
}

_CATEGORY_ICONS = {
    "phone": "\U0001f4f1", "wearable": "\u231a", "laptop": "\U0001f4bb",
    "tablet": "\U0001f4f1", "speaker": "\U0001f50a", "beacon": "\U0001f4cd",
    "vehicle": "\U0001f697", "iot": "\U0001f4e1", "network": "\U0001f5a7",
    "other": "\U0001f4e1",
}


def _classify_device(mac: str, name: str, dev_type: str) -> dict[str, str]:
    """Identify manufacturer and category from MAC OUI or device name patterns."""
    oui = mac[:8].upper() if mac else ""
    result: dict[str, str] = {"manufacturer": "", "category": "other", "icon": _CATEGORY_ICONS["other"]}

    # OUI lookup
    if oui in _OUI_TABLE:
        mfr, cat = _OUI_TABLE[oui]
        result["manufacturer"] = mfr
        result["category"] = cat
        result["icon"] = _CATEGORY_ICONS.get(cat, _CATEGORY_ICONS["other"])
        return result

    # Name-based heuristics
    name_lower = (name or "").lower()
    for keyword, (mfr, cat) in [
        ("iphone", ("Apple", "phone")), ("ipad", ("Apple", "tablet")),
        ("macbook", ("Apple", "laptop")), ("apple watch", ("Apple", "wearable")),
        ("airpods", ("Apple", "wearable")), ("galaxy", ("Samsung", "phone")),
        ("pixel", ("Google", "phone")), ("fitbit", ("Fitbit", "wearable")),
        ("garmin", ("Garmin", "wearable")), ("tile", ("Tile", "beacon")),
        ("echo", ("Amazon", "speaker")), ("alexa", ("Amazon", "speaker")),
        ("surface", ("Microsoft", "laptop")), ("xbox", ("Microsoft", "other")),
        ("bose", ("Bose", "speaker")), ("jbl", ("JBL", "speaker")),
        ("tesla", ("Tesla", "vehicle")), ("meta quest", ("Meta", "wearable")),
    ]:
        if keyword in name_lower:
            result["manufacturer"] = mfr
            result["category"] = cat
            result["icon"] = _CATEGORY_ICONS.get(cat, _CATEGORY_ICONS["other"])
            return result

    # BLE random address detection (bit 1 of first byte = 1 means random)
    if mac and len(mac) >= 2:
        try:
            first_byte = int(mac[:2], 16)
            if first_byte & 0x02:
                result["manufacturer"] = "Random BLE"
                result["category"] = "phone"
                result["icon"] = _CATEGORY_ICONS["phone"]
        except ValueError:
            pass

    return result


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
            return cfg.get("general", {}).get("callsign", "SORCC-01")
        except Exception:
            pass
    return "SORCC-01"


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("base.html", {"request": request})

@app.get("/instructor", response_class=HTMLResponse)
async def instructor_page(request: Request):
    return templates.TemplateResponse("instructor.html", {"request": request})


@app.post("/api/lte/restart")
async def restart_lte():
    try:
        result = subprocess.run(
            ["mmcli", "-m", "0", "--reset"],
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
    """Check current wlan0 state: managed (connectivity) vs monitor (capture)."""
    result: dict[str, Any] = {"active": False, "mode": "unknown", "interface": "wlan0"}
    try:
        r = subprocess.run(["iw", "dev", "wlan0", "info"], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if "type" in line:
                mode = line.strip().split()[-1]
                result["mode"] = mode
                result["active"] = mode == "monitor"
                break
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
    """
    current = _wifi_capture_status()

    if current["active"]:
        # ── Disable capture: monitor → managed ──
        # 1. Remove wlan0 source from Kismet
        try:
            s = kismet_session()
            r = s.get(f"{KISMET_URL}/datasource/all_sources.json", timeout=5)
            if r.status_code == 200:
                for src in r.json() if isinstance(r.json(), list) else []:
                    iface = src.get("kismet.datasource.interface", "")
                    if "wlan0" in iface:
                        uuid = src.get("kismet.datasource.uuid")
                        if uuid:
                            s.post(f"{KISMET_URL}/datasource/by-uuid/{uuid}/close_source.cmd", timeout=5)
        except Exception as e:
            log.warning("Could not remove wlan0 from Kismet: %s", e)

        # 2. Restore managed mode
        try:
            subprocess.run(["ip", "link", "set", "wlan0", "down"], timeout=5, check=True)
            subprocess.run(["iw", "dev", "wlan0", "set", "type", "managed"], timeout=5, check=True)
            subprocess.run(["ip", "link", "set", "wlan0", "up"], timeout=5, check=True)
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"Failed to restore managed mode: {e}")

        # 3. Reconnect WiFi via NetworkManager
        try:
            subprocess.run(["nmcli", "device", "set", "wlan0", "managed", "yes"], timeout=5)
            # Find first WiFi connection profile and activate it
            r = subprocess.run(
                ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"],
                capture_output=True, text=True, timeout=5
            )
            for line in r.stdout.strip().splitlines():
                parts = line.split(":")
                if len(parts) >= 2 and parts[-1] == "802-11-wireless":
                    subprocess.run(["nmcli", "connection", "up", parts[0]], capture_output=True, timeout=10)
                    break
        except Exception as e:
            log.warning("WiFi reconnect failed (LTE still available): %s", e)

        return {"status": "ok", "active": False, "detail": "WiFi capture disabled — connectivity restored"}
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

        # 3. Add wlan0 as Kismet source
        source_added = False
        try:
            s = kismet_session()
            r = s.post(
                f"{KISMET_URL}/datasource/add_source.cmd",
                json={"definition": "wlan0:name=WiFi-Capture,hop=true"},
                timeout=10,
            )
            source_added = r.status_code == 200
        except Exception as e:
            log.warning("Could not add wlan0 to Kismet: %s", e)

        detail = "WiFi capture enabled — wlan0 in monitor mode"
        if not source_added:
            detail += " (warning: could not add to Kismet automatically)"
        return {"status": "ok", "active": True, "detail": detail}


@app.post("/api/wifi/apply")
async def apply_wifi():
    """Apply WiFi config to NetworkManager."""
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=500, detail="Config API not available")
    try:
        cfg = read_config()
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
        "wifi_capture": _wifi_capture_status()["active"],
    }
    try:
        r = requests.get(f"{KISMET_URL}/system/status.json", auth=(KISMET_USER, KISMET_PASS), timeout=2)
        if r.status_code == 200:
            status["kismet"] = True
            data = r.json()
            if isinstance(data, dict):
                status["device_count"] = data.get("kismet.system.devices.count", 0)
    except Exception:
        pass
    try:
        result = subprocess.run(["mmcli", "-L"], capture_output=True, text=True, timeout=5)
        status["modem"] = "/" in result.stdout
    except Exception:
        pass
    try:
        result = subprocess.run(["mmcli", "-m", "0", "--location-get"], capture_output=True, text=True, timeout=5)
        # Check for actual GPS fix — look for latitude coordinate or valid NMEA fix
        # $GPGGA with fix quality > 0, or explicit latitude value means we have a fix
        has_nmea = "nmea" in result.stdout.lower()
        has_fix = "latitude" in result.stdout.lower()
        # Check NMEA for valid fix: $GPGGA,time,lat,N,lon,W,1 (fix quality=1+)
        if has_nmea and not has_fix:
            for line in result.stdout.splitlines():
                if "$GPGGA" in line:
                    parts = line.split(",")
                    if len(parts) > 6 and parts[6] not in ("", "0"):
                        has_fix = True
                        break
        status["gps"] = has_fix
        status["gps_enabled"] = has_nmea  # GPS powered but may not have fix
    except Exception:
        pass
    try:
        result = subprocess.run(["bash", "-c", 'echo "get battery" | nc -q 1 127.0.0.1 8423'], capture_output=True, text=True, timeout=3)
        if result.stdout.strip():
            parts = result.stdout.strip().split(":")
            if len(parts) >= 2:
                status["battery"] = float(parts[1].strip())
    except Exception:
        pass
    try:
        result = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3)
        if result.returncode == 0 and result.stdout.strip():
            status["tailscale_ip"] = result.stdout.strip()
    except Exception:
        pass
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
        data = kismet_post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
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
        classification = _classify_device(mac, name, dev_type)

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
        data = kismet_post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
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
    try:
        data = kismet_post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
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
        classification = _classify_device(mac, name, best_device.get("kismet.device.base.type", ""))

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
        recent.append({
            "mac": mac,
            "seconds_ago": int(age),
            "manufacturer": _classify_device(mac, "", "")["manufacturer"],
            "category": _classify_device(mac, "", "")["category"],
        })
        if len(recent) >= 50:
            break
    return {
        "total_seen": len(_device_first_seen),
        "recent_5min": len([1 for _, t in _device_first_seen.items() if now - t < 300]),
        "recent_1min": len([1 for _, t in _device_first_seen.items() if now - t < 60]),
        "feed": recent[:20],
    }


@app.get("/api/wifi-capture/status")
async def wifi_capture_status():
    """Stub — WiFi capture requires an external monitor-mode adapter."""
    return {"capturing": False, "available": False, "reason": "No monitor-mode adapter detected"}


@app.get("/api/gps")
async def get_gps():
    gps: dict[str, Any] = {"lat": None, "lon": None, "alt": None, "source": None}
    try:
        result = subprocess.run(["mmcli", "-m", "0", "--location-get"], capture_output=True, text=True, timeout=5)
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
            data = kismet_get("/gps/location.json")
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
    capture_dirs = ["/opt/sorcc/output_data", "/root", "/tmp"]
    kismet_files: list[str] = []
    for d in capture_dirs:
        kismet_files.extend(glob_mod.glob(f"{d}/*.kismet"))
        kismet_files.extend(glob_mod.glob(f"{d}/Kismet-*.kismet"))
    if not kismet_files:
        kismet_files.extend(glob_mod.glob("/home/*/*.kismet"))
        kismet_files.extend(glob_mod.glob("/home/*/Kismet-*.kismet"))
    if not kismet_files:
        raise HTTPException(status_code=404, detail="No Kismet capture files found. Run Kismet first.")
    latest = max(kismet_files, key=lambda f: Path(f).stat().st_mtime)
    output_kml = "/tmp/sorcc-survey-export.kml"
    if subprocess.run(["which", "kismetdb_to_kml"], capture_output=True).returncode == 0:
        result = subprocess.run(["kismetdb_to_kml", "-v", "--in", latest, "--out", output_kml], capture_output=True, text=True, timeout=30)
        if result.returncode == 0 and Path(output_kml).exists():
            return FileResponse(output_kml, media_type="application/vnd.google-earth.kml+xml", filename="sorcc-survey.kml")
    try:
        devices = await get_devices()
        kml = ET.Element("kml", xmlns="http://www.opengis.net/kml/2.2")
        doc = ET.SubElement(kml, "Document")
        ET.SubElement(doc, "name").text = "SORCC RF Survey Export"
        for dev in devices:
            if dev.get("signal", -100) > -90:
                pm = ET.SubElement(doc, "Placemark")
                ET.SubElement(pm, "name").text = dev.get("name") or dev.get("mac", "Unknown")
                desc = f"Signal: {dev['signal']} dBm | MAC: {dev['mac']} | Type: {dev['type']}"
                if dev.get("ssid"): desc += f" | SSID: {dev['ssid']}"
                ET.SubElement(pm, "description").text = desc
        tree = ET.ElementTree(kml)
        tree.write(output_kml, xml_declaration=True, encoding="utf-8")
        return FileResponse(output_kml, media_type="application/vnd.google-earth.kml+xml", filename="sorcc-survey.kml")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"KML export failed: {e}")


@app.get("/api/export/csv")
async def export_csv():
    devices = await get_devices()
    buf = io.StringIO()
    fieldnames = ["mac", "name", "type", "phy", "signal", "max_signal", "channel", "packets", "ssid", "last_seen"]
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for dev in devices:
        writer.writerow({k: dev.get(k, "") for k in fieldnames})
    return Response(content=buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=sorcc-devices.csv"})


@app.get("/api/config/full")
async def config_read():
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        return read_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {e}")

@app.post("/api/config/full")
async def config_write(request: Request):
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        updates = await request.json()
        write_config(updates)
        return {"status": "ok"}
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

@app.get("/api/config/export")
async def config_export():
    if not _HAS_CONFIG_API:
        raise HTTPException(status_code=501, detail="Config API module not available")
    try:
        cfg = read_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {e}")
    content = json.dumps(cfg, indent=2)
    return Response(content=content, media_type="application/json", headers={"Content-Disposition": "attachment; filename=sorcc-config.json"})

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
        cfg = read_config()
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
        r = requests.get(f"{KISMET_URL}/session/check_session", auth=(KISMET_USER, KISMET_PASS), timeout=3)
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
    result = subprocess.run(["mmcli", "-m", "0", "--location-get"], capture_output=True, text=True, timeout=5)
    lat, lon = None, None
    for line in result.stdout.splitlines():
        line = line.strip().lower()
        if "latitude" in line:
            try: lat = float(line.split(":")[-1].strip())
            except ValueError: pass
        elif "longitude" in line:
            try: lon = float(line.split(":")[-1].strip())
            except ValueError: pass
    if lat and lon and lat != 0:
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
    checks = [
        _run_check("SDR (RTL2832U)", "hardware", _check_sdr),
        _run_check("Serial Devices", "hardware", _check_serial),
        _run_check("Bluetooth (hci0)", "hardware", _check_bluetooth),
        _run_check("PiSugar Battery", "hardware", _check_pisugar),
        _run_check("Kismet", "services", _check_service("kismet")),
        _run_check("sorcc-dashboard", "services", _check_service("sorcc-dashboard")),
        _run_check("sorcc-boot", "services", _check_service("sorcc-boot")),
        _run_check("avahi-daemon", "services", _check_service("avahi-daemon")),
        _run_check("LTE Modem", "network", _check_lte_modem),
        _run_check("Internet", "network", _check_internet),
        _run_check("Tailscale", "network", _check_tailscale),
        _run_check("WiFi (wlan0)", "network", _check_wifi),
        _run_check("WiFi Adapter Conflict", "network", _check_wifi_conflict),
        _run_check("GPS Fix", "network", _check_gps_fix),
        _run_check("Kismet Config", "config", _check_kismet_config),
        _run_check("Kismet Credentials", "config", _check_kismet_credentials),
        _run_check("Source Config", "config", _check_source_config),
        _run_check("Disk Space", "config", _check_disk_space),
        _run_check("Time Sync", "config", _check_time_sync),
    ]
    statuses = [c["status"] for c in checks]
    overall = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
    return {"status": overall, "checks": checks}


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

@app.post("/api/profiles/switch")
async def switch_profile(request: Request):
    global _active_profile
    body = await request.json()
    profile_id = body.get("id")
    if not profile_id:
        raise HTTPException(status_code=400, detail="Missing 'id' in request body")
    profiles = _load_profiles()
    target = next((p for p in profiles.get("profiles", []) if p.get("id") == profile_id), None)
    if not target:
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    sources = target.get("kismet_sources", {})
    errors: list[str] = []
    try:
        s = kismet_session()
        try:
            r = s.get(f"{KISMET_URL}/datasource/all_sources.json", timeout=5)
            if r.status_code == 200:
                sources = r.json()
                for src in sources if isinstance(sources, list) else []:
                    uuid = src.get("kismet.datasource.uuid")
                    if uuid:
                        try: s.post(f"{KISMET_URL}/datasource/by-uuid/{uuid}/close_source.cmd", timeout=5)
                        except Exception: pass
        except Exception as e:
            errors.append(f"Could not query sources: {e}")
        for source_type, source_def in sources.items():
            if source_def:
                try: s.post(f"{KISMET_URL}/datasource/add_source.cmd", json={"definition": source_def}, timeout=10)
                except Exception as e: errors.append(f"Failed to add {source_type} '{source_def}': {e}")
    except Exception as e:
        errors.append(f"Kismet reconfiguration failed: {e}")
    _active_profile = profile_id
    result: dict[str, Any] = {"status": "ok" if not errors else "partial", "active": _active_profile, "profile": target}
    if errors: result["errors"] = errors
    return result
