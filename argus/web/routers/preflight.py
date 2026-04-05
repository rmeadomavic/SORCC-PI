import asyncio

from fastapi import APIRouter

from argus.web.services import preflight_service as p

router = APIRouter()


@router.get('/api/preflight')
async def preflight():
    checks = await asyncio.gather(
        p.run_check_async("SDR (RTL2832U)", "hardware", p.check_sdr),
        p.run_check_async("Serial Devices", "hardware", p.check_serial),
        p.run_check_async("Kismet", "services", p.check_service("kismet")),
        p.run_check_async("Time Sync", "config", p.check_time_sync),
    )
    statuses = [c["status"] for c in checks]
    overall = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
    return {"status": overall, "checks": list(checks)}
