"""Spectrum sweep router — RF power spectrum endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request

from argus.web.services import spectrum_service

router = APIRouter()


@router.get("/api/spectrum/status")
async def spectrum_status():
    return spectrum_service.get_status()


@router.get("/api/spectrum/data")
async def spectrum_data(count: int = 60):
    return spectrum_service.get_sweep_data(max(1, min(count, 120)))


@router.post("/api/spectrum/start")
async def spectrum_start(request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    return await spectrum_service.start_sweep(
        freq_start=int(body.get("freq_start", 902_000_000)),
        freq_end=int(body.get("freq_end", 928_000_000)),
        bins=int(body.get("bins", 256)),
        gain=int(body.get("gain", 400)),
        threshold=float(body.get("threshold", -40.0)),
    )


@router.post("/api/spectrum/stop")
async def spectrum_stop():
    return await spectrum_service.stop_sweep()
