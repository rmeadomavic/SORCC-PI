from __future__ import annotations

import csv
import io
import xml.etree.ElementTree as ET

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from argus.web.services.activity_service import get_devices_data
from argus.web.services.kismet_service import build_cot_event, fetch_located_devices_for_cot

router = APIRouter()


@router.get('/api/export/csv')
async def export_csv():
    devices = get_devices_data()
    buf = io.StringIO()
    fieldnames = ["mac", "name", "type", "phy", "signal", "max_signal", "channel", "packets", "ssid", "last_seen"]
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for dev in devices:
        writer.writerow({k: dev.get(k, "") for k in fieldnames})
    return Response(content=buf.getvalue(), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename=argus-devices.csv'})


@router.get('/api/cot')
async def export_cot_all():
    located = fetch_located_devices_for_cot()
    if not located:
        raise HTTPException(status_code=404, detail='No devices with GPS coordinates found')
    cot_events = ET.Element('events')
    for device, cls in located:
        cot_events.append(build_cot_event(device, cls))
    xml_out = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(cot_events, encoding='unicode', xml_declaration=False)
    return Response(content=xml_out, media_type='application/xml')


@router.get('/api/cot/{mac}')
async def export_cot_device(mac: str):
    mac_norm = mac.strip().upper()
    for device, cls in fetch_located_devices_for_cot():
        if device['mac'].upper() == mac_norm:
            xml_out = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(build_cot_event(device, cls), encoding='unicode', xml_declaration=False)
            return Response(content=xml_out, media_type='application/xml')
    raise HTTPException(status_code=404, detail=f'Device {mac} not found or has no GPS coordinates')


@router.get('/api/waypoints')
async def export_waypoints():
    located = fetch_located_devices_for_cot()
    if not located:
        raise HTTPException(status_code=404, detail='No devices with GPS coordinates found')
    located.sort(key=lambda x: x[0].get('signal', -999), reverse=True)
    lines = ['QGC WPL 110']
    home_lat = located[0][0].get('lat', 0)
    home_lon = located[0][0].get('lon', 0)
    lines.append(f'0\t1\t0\t16\t0\t0\t0\t0\t{home_lat:.8f}\t{home_lon:.8f}\t50.0\t1')
    for i, (device, _) in enumerate(located, start=1):
        lines.append(f"{i}\t0\t3\t16\t5.0\t0\t0\t0\t{device.get('lat',0):.8f}\t{device.get('lon',0):.8f}\t50.0\t1")
    return Response(content='\n'.join(lines) + '\n', media_type='text/plain', headers={'Content-Disposition': 'attachment; filename=argus-hunt-waypoints.waypoints'})
