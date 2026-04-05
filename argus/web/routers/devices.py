import json
import time
from typing import Any

from fastapi import APIRouter

from argus.web import app_state
from argus.web import kismet as ks
from argus.web.oui import classify_device
from argus.web.services.activity_service import get_devices_data

router = APIRouter()


@router.get("/api/devices")
async def get_devices():
    return get_devices_data()


@router.get("/api/devices/located")
async def get_located_devices():
    try:
        data = ks.post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr", "kismet.device.base.name", "kismet.device.base.commonname",
            "kismet.device.base.phyname", "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.channel", "kismet.device.base.packets.total",
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except Exception:
        return []
    located: list[dict[str, Any]] = []
    for d in data if isinstance(data, list) else []:
        gp = d.get("kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint")
        if not gp or not isinstance(gp, list) or len(gp) < 2:
            continue
        lon, lat = gp[0], gp[1]
        if lat == 0 and lon == 0:
            continue
        name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
        ssid = d.get("dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "")
        located.append({"mac": d.get("kismet.device.base.macaddr", ""), "name": name or ssid or "Unknown", "phy": d.get("kismet.device.base.phyname", ""), "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0), "channel": d.get("kismet.device.base.channel", ""), "packets": d.get("kismet.device.base.packets.total", 0), "lat": lat, "lon": lon})
    return located


@router.get("/api/activity")
async def get_activity():
    now = time.time()
    recent = []
    for mac, first in sorted(app_state.device_first_seen.items(), key=lambda x: x[1], reverse=True):
        age = now - first
        if age > 300:
            break
        cls = classify_device(mac, "", "")
        recent.append({"mac": mac, "seconds_ago": int(age), "manufacturer": cls["manufacturer"], "category": cls["category"]})
        if len(recent) >= 50:
            break
    return {
        "total_seen": len(app_state.device_first_seen),
        "recent_5min": len([1 for _, t in app_state.device_first_seen.items() if now - t < 300]),
        "recent_1min": len([1 for _, t in app_state.device_first_seen.items() if now - t < 60]),
        "feed": recent[:20],
    }


@router.get('/api/target/{query}')
async def get_target_rssi(query: str):
    is_mac_query = len(query.replace(':', '').replace('-', '')) == 12
    result: dict[str, Any] = {
        'query': query, 'mode': 'mac' if is_mac_query else 'ssid', 'found': False,
        'signal': -100, 'max_signal': -100, 'mac': '', 'channel': '', 'gps': None,
        'timestamp': time.time(), 'packets': 0, 'packet_delta': 0, 'activity': 0,
        'manufacturer': '', 'category': '',
    }
    for d in get_devices_data():
        mac = d.get('mac', '')
        name = d.get('name', '')
        matched = mac.lower() == query.lower().replace('-', ':') if is_mac_query else (query.lower() in name.lower() or query.lower() in d.get('ssid', '').lower())
        if matched:
            result.update({
                'found': True, 'signal': d.get('signal', -100), 'max_signal': d.get('max_signal', -100),
                'mac': mac, 'name': name, 'channel': d.get('channel', ''), 'packets': d.get('packets', 0),
                'manufacturer': d.get('manufacturer', ''), 'category': d.get('category', ''),
            })
            break
    return result
