from fastapi import APIRouter

from argus.web.services.activity_service import get_status_data

router = APIRouter()


@router.get("/api/status")
async def get_status():
    return await get_status_data()


import asyncio
import subprocess
from typing import Any

from fastapi import HTTPException

from argus.web.services.modem_service import get_modem_index, restart_lte_modem
from argus.web.services.wifi_service import apply_wifi_from_config, wifi_capture_status, wifi_capture_toggle_sync


@router.post('/api/lte/restart')
async def restart_lte():
    return restart_lte_modem()


@router.get('/api/wifi-capture/status')
async def get_wifi_capture_status():
    return wifi_capture_status()


@router.post('/api/wifi-capture/toggle')
async def wifi_capture_toggle():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, wifi_capture_toggle_sync)


@router.post('/api/wifi/apply')
async def apply_wifi():
    return apply_wifi_from_config()


@router.get('/api/gps')
async def get_gps():
    gps: dict[str, Any] = {'lat': None, 'lon': None, 'alt': None, 'source': None}
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: subprocess.run(['mmcli', '-m', get_modem_index(), '--location-get'], capture_output=True, text=True, timeout=5))
        for line in result.stdout.splitlines():
            line = line.strip().lower()
            if 'latitude' in line:
                gps['lat'] = float(line.split(':')[-1].strip())
            elif 'longitude' in line:
                gps['lon'] = float(line.split(':')[-1].strip())
            elif 'altitude' in line:
                gps['alt'] = float(line.split(':')[-1].strip())
        if gps['lat'] is not None:
            gps['source'] = 'modem'
    except Exception:
        pass
    return gps
