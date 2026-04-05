from __future__ import annotations

import asyncio
import json
import socket
import time
from typing import Any

import requests

from argus.web import app_state
from argus.web import kismet as ks
from argus.web.oui import classify_device
from argus.web.services.modem_service import get_modem_index
from argus.web.services.wifi_service import wifi_capture_status


def get_devices_data() -> list[dict[str, Any]]:
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
    except Exception:
        return []

    now = time.time()
    devices = []
    for d in data if isinstance(data, list) else []:
        mac = d.get("kismet.device.base.macaddr", "")
        name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
        dev_type = d.get("kismet.device.base.type", "")
        packets = d.get("kismet.device.base.packets.total", 0)
        classification = classify_device(mac, name, dev_type)
        if mac and mac not in app_state.device_first_seen:
            app_state.device_first_seen[mac] = now
        prev_packets = app_state.last_device_snapshot.get(mac, 0)
        packet_delta = max(0, packets - prev_packets)
        app_state.last_device_snapshot[mac] = packets
        activity = 3 if packet_delta > 20 else 2 if packet_delta > 5 else 1 if packet_delta > 0 else 0
        ssid = d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "")
        devices.append({
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
            "first_seen": d.get("kismet.device.base.first_time", 0),
            "last_seen": d.get("kismet.device.base.last_time", 0),
            "manufacturer": classification["manufacturer"],
            "category": classification["category"],
            "icon": classification["icon"],
            "activity": activity,
            "packet_delta": packet_delta,
            "is_new": (now - app_state.device_first_seen.get(mac, now)) < 60,
        })
    devices.sort(key=lambda x: (x["activity"], x["packets"]), reverse=True)
    return devices


async def get_status_data() -> dict[str, Any]:
    status: dict[str, Any] = {
        "kismet": False, "modem": False, "gps": False, "battery": None,
        "tailscale_ip": None, "hostname": None, "uptime": None,
        "device_count": 0, "active_profile": app_state.active_profile,
        "callsign": app_state.get_callsign(), "wifi_capture": False, "wifi_external": False,
    }
    wcap = wifi_capture_status()
    status["wifi_capture"] = wcap.get("active", False)
    status["wifi_external"] = wcap.get("external_ready", False)

    async def _run(cmd: list[str], timeout: float = 5) -> tuple[str, int]:
        try:
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return stdout.decode(), proc.returncode or 0
        except Exception:
            return "", 1

    async def _check_kismet():
        try:
            loop = asyncio.get_running_loop()
            r = await loop.run_in_executor(None, lambda: requests.get(f"{ks.KISMET_URL}/system/status.json", auth=(ks.KISMET_USER, ks.KISMET_PASS), timeout=2))
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
        out, _ = await _run(["mmcli", "-m", get_modem_index(), "--location-get"])
        status["gps"] = "latitude" in out.lower()

    await asyncio.gather(_check_kismet(), _check_modem(), _check_gps(), return_exceptions=True)
    try:
        status["hostname"] = socket.gethostname()
    except Exception:
        pass
    return status
