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
        has_backup, has_factory, set_config_path,
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


def kismet_session() -> requests.Session:
    s = requests.Session()
    s.auth = (KISMET_USER, KISMET_PASS)
    s.headers.update({"Accept": "application/json"})
    try:
        r = s.get(f"{KISMET_URL}/session/check_session", timeout=3)
        if r.status_code == 200 and "KISMET" in r.cookies:
            s.cookies.update(r.cookies)
    except requests.ConnectionError:
        pass
    return s


def kismet_get(endpoint, params=None, timeout=5):
    s = kismet_session()
    try:
        r = s.get(f"{KISMET_URL}{endpoint}", params=params, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except requests.ConnectionError:
        raise HTTPException(status_code=502, detail="Kismet not reachable on port 2501")
    except requests.Timeout:
        raise HTTPException(status_code=504, detail="Kismet request timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def kismet_post(endpoint, data=None, timeout=5):
    s = kismet_session()
    try:
        r = s.post(f"{KISMET_URL}{endpoint}", json=data, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except requests.ConnectionError:
        raise HTTPException(status_code=502, detail="Kismet not reachable on port 2501")
    except requests.Timeout:
        raise HTTPException(status_code=504, detail="Kismet request timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _load_profiles() -> dict:
    try:
        return json.loads(PROFILES_PATH.read_text())
    except Exception as e:
        log.warning("Could not load profiles.json: %s", e)
        return {"default_profile": "wifi-survey", "profiles": []}

def _get_device_count() -> int:
    try:
        data = kismet_get("/system/status.json")
        if isinstance(data, dict):
            return data.get("kismet.system.devices.count", 0)
    except Exception:
        pass
    return 0

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


@app.get("/api/status")
async def get_status():
    status: dict[str, Any] = {
        "kismet": False, "modem": False, "gps": False, "battery": None,
        "tailscale_ip": None, "hostname": None, "uptime": None,
        "device_count": 0, "active_profile": _active_profile,
        "callsign": _get_callsign(),
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
        status["gps"] = "latitude" in result.stdout.lower() or "nmea" in result.stdout.lower()
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
    devices = []
    for d in data if isinstance(data, list) else []:
        device = {
            "mac": d.get("kismet.device.base.macaddr", ""),
            "name": d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", ""),
            "type": d.get("kismet.device.base.type", ""),
            "phy": d.get("kismet.device.base.phyname", ""),
            "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0),
            "max_signal": d.get("kismet.device.base.signal/kismet.common.signal.max_signal", 0),
            "channel": d.get("kismet.device.base.channel", ""),
            "packets": d.get("kismet.device.base.packets.total", 0),
            "ssid": d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", ""),
            "last_seen": d.get("kismet.device.base.last_time", 0),
        }
        if not device["name"] and device["ssid"]:
            device["name"] = device["ssid"]
        devices.append(device)
    devices.sort(key=lambda x: x["signal"], reverse=True)
    return devices


@app.get("/api/target/{ssid}")
async def get_target_rssi(ssid: str):
    result: dict[str, Any] = {"ssid": ssid, "found": False, "signal": -100, "max_signal": -100, "mac": "", "channel": "", "gps": None, "timestamp": time.time()}
    try:
        data = kismet_post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr",
            "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.signal/kismet.common.signal.max_signal",
            "kismet.device.base.channel",
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except HTTPException:
        return result
    best_signal = -100
    best_device = None
    for d in data if isinstance(data, list) else []:
        device_ssid = d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "")
        if device_ssid and ssid.lower() in device_ssid.lower():
            sig = d.get("kismet.device.base.signal/kismet.common.signal.last_signal", -100)
            if sig > best_signal:
                best_signal = sig
                best_device = d
    if best_device:
        result["found"] = True
        result["signal"] = best_signal
        result["max_signal"] = best_device.get("kismet.device.base.signal/kismet.common.signal.max_signal", best_signal)
        result["mac"] = best_device.get("kismet.device.base.macaddr", "")
        result["channel"] = best_device.get("kismet.device.base.channel", "")
        geopoint = best_device.get("kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint")
        if geopoint and isinstance(geopoint, list) and len(geopoint) >= 2:
            result["gps"] = {"lat": geopoint[1], "lon": geopoint[0]}
    return result


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
    cfg = read_config()
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
    result = subprocess.run(["ip", "link", "show", "wlan0"], capture_output=True, text=True, timeout=5)
    if result.returncode == 0: return "pass", "wlan0 interface present"
    return "warn", "wlan0 not found"

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
        _run_check("Kismet Config", "config", _check_kismet_config),
        _run_check("Kismet Credentials", "config", _check_kismet_credentials),
        _run_check("Source Config", "config", _check_source_config),
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
                for src in r.json() if isinstance(r.json(), list) else []:
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
