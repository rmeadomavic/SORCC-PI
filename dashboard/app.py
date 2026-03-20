"""SORCC RF Survey Dashboard — FastAPI application wrapping Kismet REST API."""

import json
import logging
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="SORCC RF Survey Dashboard")

BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# Kismet connection settings
KISMET_URL = "http://localhost:2501"
KISMET_USER = "kismet"
KISMET_PASS = "kismet"


def kismet_session():
    """Create a requests session with Kismet auth."""
    s = requests.Session()
    s.auth = (KISMET_USER, KISMET_PASS)
    s.headers.update({"Accept": "application/json"})
    # Try cookie-based auth for Kismet 2025+
    try:
        r = s.get(f"{KISMET_URL}/session/check_session", timeout=3)
        if r.status_code == 200 and "KISMET" in r.cookies:
            s.cookies.update(r.cookies)
    except requests.ConnectionError:
        pass
    return s


def kismet_get(endpoint, params=None, timeout=5):
    """Make a GET request to Kismet REST API."""
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
    """Make a POST request to Kismet REST API (used for filtered queries)."""
    s = kismet_session()
    try:
        r = s.post(
            f"{KISMET_URL}{endpoint}",
            json=data,
            timeout=timeout,
        )
        r.raise_for_status()
        return r.json()
    except requests.ConnectionError:
        raise HTTPException(status_code=502, detail="Kismet not reachable on port 2501")
    except requests.Timeout:
        raise HTTPException(status_code=504, detail="Kismet request timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Pages ────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the SORCC dashboard SPA."""
    return templates.TemplateResponse("index.html", {"request": request})


# ── API Endpoints ────────────────────────────────────────────

@app.get("/api/status")
async def get_status():
    """System health: Kismet, modem, GPS, battery, Tailscale."""
    status = {
        "kismet": False,
        "modem": False,
        "gps": False,
        "battery": None,
        "tailscale_ip": None,
        "hostname": None,
        "uptime": None,
    }

    # Kismet
    try:
        r = requests.get(f"{KISMET_URL}/system/status.json",
                         auth=(KISMET_USER, KISMET_PASS), timeout=2)
        if r.status_code == 200:
            status["kismet"] = True
    except Exception:
        pass

    # Modem
    try:
        result = subprocess.run(
            ["mmcli", "-L"], capture_output=True, text=True, timeout=5
        )
        status["modem"] = "/" in result.stdout
    except Exception:
        pass

    # GPS
    try:
        result = subprocess.run(
            ["mmcli", "-m", "0", "--location-get"],
            capture_output=True, text=True, timeout=5
        )
        status["gps"] = "latitude" in result.stdout.lower() or "nmea" in result.stdout.lower()
    except Exception:
        pass

    # Battery (PiSugar)
    try:
        result = subprocess.run(
            ["bash", "-c", 'echo "get battery" | nc -q 1 127.0.0.1 8423'],
            capture_output=True, text=True, timeout=3
        )
        if result.stdout.strip():
            # PiSugar returns something like "battery: 78.5"
            parts = result.stdout.strip().split(":")
            if len(parts) >= 2:
                status["battery"] = float(parts[1].strip())
    except Exception:
        pass

    # Tailscale
    try:
        result = subprocess.run(
            ["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3
        )
        if result.returncode == 0 and result.stdout.strip():
            status["tailscale_ip"] = result.stdout.strip()
    except Exception:
        pass

    # Hostname & uptime
    try:
        import socket
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
    """Get all WiFi and Bluetooth devices seen by Kismet."""
    try:
        data = kismet_post(
            "/devices/views/all/devices.json",
            data={"json": json.dumps({"fields": [
                "kismet.device.base.macaddr",
                "kismet.device.base.name",
                "kismet.device.base.commonname",
                "kismet.device.base.type",
                "kismet.device.base.phyname",
                "kismet.device.base.signal/kismet.common.signal.last_signal",
                "kismet.device.base.signal/kismet.common.signal.max_signal",
                "kismet.device.base.channel",
                "kismet.device.base.frequency",
                "kismet.device.base.first_time",
                "kismet.device.base.last_time",
                "kismet.device.base.packets.total",
                "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
            ]})},
        )
    except HTTPException:
        return []

    devices = []
    for d in data if isinstance(data, list) else []:
        device = {
            "mac": d.get("kismet.device.base.macaddr", ""),
            "name": (d.get("kismet.device.base.commonname")
                     or d.get("kismet.device.base.name", "")),
            "type": d.get("kismet.device.base.type", ""),
            "phy": d.get("kismet.device.base.phyname", ""),
            "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0),
            "max_signal": d.get("kismet.device.base.signal/kismet.common.signal.max_signal", 0),
            "channel": d.get("kismet.device.base.channel", ""),
            "packets": d.get("kismet.device.base.packets.total", 0),
            "ssid": d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", ""),
            "last_seen": d.get("kismet.device.base.last_time", 0),
        }
        # Use SSID as name if name is empty
        if not device["name"] and device["ssid"]:
            device["name"] = device["ssid"]
        devices.append(device)

    # Sort by signal strength (strongest first)
    devices.sort(key=lambda x: x["signal"], reverse=True)
    return devices


@app.get("/api/target/{ssid}")
async def get_target_rssi(ssid: str):
    """Get live RSSI for a specific target SSID — used in Hunt Mode.

    Returns the strongest signal seen for any AP broadcasting the target SSID,
    along with GPS position if available.
    """
    result = {
        "ssid": ssid,
        "found": False,
        "signal": -100,
        "max_signal": -100,
        "mac": "",
        "channel": "",
        "gps": None,
        "timestamp": time.time(),
    }

    # Query Kismet for devices matching this SSID
    try:
        data = kismet_post(
            "/devices/views/all/devices.json",
            data={"json": json.dumps({"fields": [
                "kismet.device.base.macaddr",
                "kismet.device.base.signal/kismet.common.signal.last_signal",
                "kismet.device.base.signal/kismet.common.signal.max_signal",
                "kismet.device.base.channel",
                "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
                "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
            ]})},
        )
    except HTTPException:
        return result

    # Find the strongest signal for our target SSID
    best_signal = -100
    best_device = None

    for d in data if isinstance(data, list) else []:
        device_ssid = d.get(
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", ""
        )
        if device_ssid and ssid.lower() in device_ssid.lower():
            sig = d.get("kismet.device.base.signal/kismet.common.signal.last_signal", -100)
            if sig > best_signal:
                best_signal = sig
                best_device = d

    if best_device:
        result["found"] = True
        result["signal"] = best_signal
        result["max_signal"] = best_device.get(
            "kismet.device.base.signal/kismet.common.signal.max_signal", best_signal
        )
        result["mac"] = best_device.get("kismet.device.base.macaddr", "")
        result["channel"] = best_device.get("kismet.device.base.channel", "")

        # GPS from Kismet device location
        geopoint = best_device.get(
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint"
        )
        if geopoint and isinstance(geopoint, list) and len(geopoint) >= 2:
            result["gps"] = {"lat": geopoint[1], "lon": geopoint[0]}

    return result


@app.get("/api/gps")
async def get_gps():
    """Get current GPS position from modem."""
    gps = {"lat": None, "lon": None, "alt": None, "source": None}

    # Try ModemManager GPS
    try:
        result = subprocess.run(
            ["mmcli", "-m", "0", "--location-get"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if "latitude" in line.lower():
                val = line.split(":")[-1].strip()
                try:
                    gps["lat"] = float(val)
                except ValueError:
                    pass
            elif "longitude" in line.lower():
                val = line.split(":")[-1].strip()
                try:
                    gps["lon"] = float(val)
                except ValueError:
                    pass
            elif "altitude" in line.lower():
                val = line.split(":")[-1].strip()
                try:
                    gps["alt"] = float(val)
                except ValueError:
                    pass
        if gps["lat"] is not None:
            gps["source"] = "modem"
    except Exception:
        pass

    # Fallback: try Kismet GPS
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
    """Generate KML from the most recent Kismet capture database."""
    import glob as glob_mod

    # Find the most recent .kismet database file
    capture_dirs = ["/opt/sorcc/output_data", "/root", "/tmp"]
    kismet_files = []
    for d in capture_dirs:
        kismet_files.extend(glob_mod.glob(f"{d}/*.kismet"))
        kismet_files.extend(glob_mod.glob(f"{d}/Kismet-*.kismet"))

    if not kismet_files:
        # Also check home directories
        kismet_files.extend(glob_mod.glob("/home/*/*.kismet"))
        kismet_files.extend(glob_mod.glob("/home/*/Kismet-*.kismet"))

    if not kismet_files:
        raise HTTPException(
            status_code=404,
            detail="No Kismet capture files (.kismet) found. Run Kismet first to collect data."
        )

    # Use the most recently modified file
    latest = max(kismet_files, key=lambda f: Path(f).stat().st_mtime)
    output_kml = "/tmp/sorcc-survey-export.kml"

    # Use kismetdb_to_kml if available
    if subprocess.run(["which", "kismetdb_to_kml"], capture_output=True).returncode == 0:
        result = subprocess.run(
            ["kismetdb_to_kml", "-v", "--in", latest, "--out", output_kml],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and Path(output_kml).exists():
            return FileResponse(
                output_kml,
                media_type="application/vnd.google-earth.kml+xml",
                filename="sorcc-survey.kml",
            )

    # Fallback: generate a basic KML from Kismet device data
    try:
        devices = await get_devices()
        gps = await get_gps()

        kml = ET.Element("kml", xmlns="http://www.opengis.net/kml/2.2")
        doc = ET.SubElement(kml, "Document")
        ET.SubElement(doc, "name").text = "SORCC RF Survey Export"

        for dev in devices:
            if dev.get("signal", -100) > -90:  # Only include reasonably strong signals
                pm = ET.SubElement(doc, "Placemark")
                ET.SubElement(pm, "name").text = dev.get("name") or dev.get("mac", "Unknown")
                desc = f"Signal: {dev['signal']} dBm | MAC: {dev['mac']} | Type: {dev['type']}"
                if dev.get("ssid"):
                    desc += f" | SSID: {dev['ssid']}"
                ET.SubElement(pm, "description").text = desc

        tree = ET.ElementTree(kml)
        tree.write(output_kml, xml_declaration=True, encoding="utf-8")
        return FileResponse(
            output_kml,
            media_type="application/vnd.google-earth.kml+xml",
            filename="sorcc-survey.kml",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"KML export failed: {e}")
