from __future__ import annotations

import subprocess
import time
from typing import Any

from fastapi import HTTPException

from argus.web import kismet as ks
from argus.web.event_logger import events
from argus.web.app_state import HAS_CONFIG_API, read_config_raw


def wifi_capture_status() -> dict[str, Any]:
    result: dict[str, Any] = {"active": False, "mode": "unknown", "interface": "wlan0", "adapters": [], "external_ready": False}
    try:
        r = subprocess.run(["iw", "dev"], capture_output=True, text=True, timeout=5)
        current_iface: dict[str, str] = {}
        for line in r.stdout.splitlines():
            stripped = line.strip()
            if stripped.startswith("phy#"):
                if current_iface.get("interface"):
                    result["adapters"].append(current_iface)
                current_iface = {"phy": stripped}
            elif "Interface" in stripped:
                current_iface["interface"] = stripped.split()[-1]
            elif stripped.startswith("type"):
                current_iface["mode"] = stripped.split()[-1]
        if current_iface.get("interface"):
            result["adapters"].append(current_iface)

        for adapter in result["adapters"]:
            iface = adapter.get("interface", "")
            try:
                link = subprocess.run(["readlink", "-f", f"/sys/class/net/{iface}/device/driver"], capture_output=True, text=True, timeout=2)
                driver = link.stdout.strip().split("/")[-1] if link.returncode == 0 else ""
                adapter["driver"] = driver
                adapter["is_onboard"] = driver in ("brcmfmac", "brcmsmac")
            except Exception:
                adapter["driver"] = "unknown"
                adapter["is_onboard"] = False

        primary = next((a for a in result["adapters"] if a.get("interface") == "wlan0"), None)
        if primary:
            result["mode"] = primary.get("mode", "unknown")
            result["active"] = primary.get("mode") == "monitor"

        externals = [a for a in result["adapters"] if not a.get("is_onboard")]
        if externals:
            result["external_ready"] = True
    except Exception:
        pass
    return result


def wifi_capture_toggle_sync() -> dict[str, Any]:
    current = wifi_capture_status()
    if current["active"]:
        try:
            subprocess.run(["ip", "link", "set", "wlan0", "down"], timeout=5)
            subprocess.run(["modprobe", "-r", "brcmfmac"], timeout=10)
            time.sleep(2)
            subprocess.run(["modprobe", "brcmfmac"], timeout=10)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to restore managed mode: {e}")
        events.log("wifi_capture_disabled")
        return {"status": "ok", "active": False, "detail": "WiFi capture disabled — connectivity restored, Kismet restarting"}

    try:
        subprocess.run(["ip", "link", "set", "wlan0", "down"], timeout=5, check=True)
        subprocess.run(["iw", "dev", "wlan0", "set", "type", "monitor"], timeout=5, check=True)
        subprocess.run(["ip", "link", "set", "wlan0", "up"], timeout=5, check=True)
        subprocess.run(["systemctl", "restart", "kismet"], timeout=30)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Failed to set monitor mode: {e}")

    events.log("wifi_capture_enabled", source_added=True)
    return {"status": "ok", "active": True, "detail": "WiFi capture enabled — wlan0 in monitor mode"}


def apply_wifi_from_config() -> dict[str, Any]:
    if not HAS_CONFIG_API:
        raise HTTPException(status_code=500, detail="Config API not available")
    cfg = read_config_raw()
    ssid = cfg.get("wifi", {}).get("ssid", "").strip()
    password = cfg.get("wifi", {}).get("password", "").strip()
    if not ssid:
        return {"status": "ok", "detail": "No SSID configured — WiFi auto-connect disabled"}
    check = subprocess.run(["nmcli", "-t", "-f", "NAME", "connection", "show"], capture_output=True, text=True, timeout=5)
    conn_exists = ssid in check.stdout.splitlines()
    cmd = ["nmcli", "connection", "modify" if conn_exists else "add"]
    if conn_exists:
        cmd += [ssid, "wifi-sec.psk", password, "connection.autoconnect", "yes"]
    else:
        cmd += ["type", "wifi", "con-name", ssid, "ssid", ssid, "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        return {"status": "ok", "detail": f"WiFi connection '{ssid}' {'updated' if conn_exists else 'created'}"}
    return {"status": "error", "detail": result.stderr.strip() or "nmcli command failed"}
