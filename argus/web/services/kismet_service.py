from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from argus.web import kismet as ks
from argus.web.oui import classify_device


def fetch_located_devices_for_cot() -> list[tuple[dict, dict]]:
    try:
        data = ks.post("/devices/views/all/devices.json", data={"json": json.dumps({"fields": [
            "kismet.device.base.macaddr", "kismet.device.base.name", "kismet.device.base.commonname",
            "kismet.device.base.type", "kismet.device.base.phyname",
            "kismet.device.base.signal/kismet.common.signal.last_signal",
            "kismet.device.base.channel", "kismet.device.base.packets.total",
            "kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint",
            "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ]})})
    except HTTPException:
        return []

    results = []
    for d in data if isinstance(data, list) else []:
        geopoint = d.get("kismet.device.base.location/kismet.common.location.last/kismet.common.location.geopoint")
        if not geopoint or not isinstance(geopoint, list) or len(geopoint) < 2:
            continue
        lon, lat = geopoint[0], geopoint[1]
        if lat == 0 and lon == 0:
            continue
        mac = d.get("kismet.device.base.macaddr", "")
        name = d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name", "")
        cls = classify_device(mac, name, d.get("kismet.device.base.type", ""))
        results.append(({
            "mac": mac, "name": name or mac, "phy": d.get("kismet.device.base.phyname", ""),
            "signal": d.get("kismet.device.base.signal/kismet.common.signal.last_signal", 0),
            "channel": d.get("kismet.device.base.channel", ""), "packets": d.get("kismet.device.base.packets.total", 0),
            "lat": lat, "lon": lon,
        }, cls))
    return results


def cot_type_for_device(category: str, phy: str) -> str:
    if "802.11" in (phy or "").lower():
        return "a-u-G-I-E"
    return {"phone": "a-u-G-U-C-I", "vehicle": "a-u-G-E-V", "network": "a-u-G-I-E"}.get(category, "a-u-G")


def build_cot_event(device: dict, classification: dict) -> ET.Element:
    mac = device.get("mac", "000000000000")
    now = datetime.now(timezone.utc)
    stale = now + timedelta(minutes=5)
    iso_now = now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    iso_stale = stale.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    event = ET.Element("event", {
        "version": "2.0", "uid": f"ARGUS-{mac}", "type": cot_type_for_device(classification.get("category", "other"), device.get("phy", "")),
        "time": iso_now, "start": iso_now, "stale": iso_stale, "how": "m-g",
    })
    ET.SubElement(event, "point", {"lat": str(device.get("lat", 0)), "lon": str(device.get("lon", 0)), "hae": "0", "ce": "50", "le": "50"})
    detail = ET.SubElement(event, "detail")
    ET.SubElement(detail, "contact", callsign=f"ARGUS-{mac.replace(':', '')[-6:].upper()}")
    return event
