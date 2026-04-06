"""Spectrum sweep service — manages rtl_power_fftw subprocess."""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from collections import deque

log = logging.getLogger(__name__)

_process: asyncio.subprocess.Process | None = None
_reader_task: asyncio.Task | None = None
_sweeps: deque = deque(maxlen=120)
_config: dict = {}
_status: str = "stopped"
_error_msg: str | None = None
_alerts: deque = deque(maxlen=50)
_start_time: float = 0.0


def _check_sdr_conflict() -> str | None:
    from argus.web import app_state
    profiles = app_state.load_profiles()
    for p in profiles.get("profiles", []):
        if p.get("id") == app_state.active_profile:
            sources = p.get("kismet_sources", {})
            if sources.get("rtl433") or sources.get("adsb"):
                return (
                    f"SDR in use by Kismet ({app_state.active_profile} profile "
                    f"uses rtl433/adsb). Switch to a BT-only or WiFi-only profile first."
                )
    return None


async def _read_stdout(proc: asyncio.subprocess.Process) -> None:
    """Read rtl_power_fftw stdout, accumulating bins across frequency hops.

    The RTL-SDR can only sample ~2 MHz at a time, so a 26 MHz sweep
    (902-928 MHz) produces ~14 separate blocks separated by blank lines.
    We accumulate bins across all hops and emit one complete sweep when
    the frequency wraps back to the start of the band.
    """
    global _status, _error_msg
    accumulated: list[list[float]] = []
    hop_bins: list[list[float]] = []
    last_first_freq: float = 0.0

    try:
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").strip()

            if not line:
                # End of one hop block — append to accumulated
                if hop_bins:
                    accumulated.extend(hop_bins)
                    hop_bins = []
                continue

            if line.startswith("#"):
                continue

            parts = line.split()
            if len(parts) >= 2:
                try:
                    freq = float(parts[0])
                    power = float(parts[1])
                except ValueError:
                    continue

                # Detect start of a new full sweep: frequency wrapped back
                if hop_bins == [] and accumulated and freq <= accumulated[0][0] + 1e5:
                    # Emit the accumulated full-band sweep
                    sweep = {"ts": time.time(), "bins": accumulated}
                    _sweeps.append(sweep)
                    _check_alerts(sweep)
                    accumulated = []

                hop_bins.append([freq, power])
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log.error("Spectrum reader error: %s", e)
        _error_msg = str(e)
        _status = "error"


async def _monitor_stderr(proc: asyncio.subprocess.Process) -> None:
    global _status, _error_msg
    try:
        stderr = await proc.stderr.read()
        if stderr:
            msg = stderr.decode("utf-8", errors="replace").strip()
            # Filter out non-error info lines rtl_power_fftw dumps to stderr
            for line in msg.splitlines():
                if "error" in line.lower() or "failed" in line.lower() or "usb_claim" in line.lower():
                    _error_msg = line
                    _status = "error"
                    log.error("Spectrum sweep error: %s", line)
                    return
    except Exception:
        pass


def _check_alerts(sweep: dict) -> None:
    threshold = _config.get("threshold", -40.0)
    for freq, power in sweep["bins"]:
        if power > threshold:
            _alerts.append({
                "ts": sweep["ts"],
                "freq": freq,
                "power": power,
                "message": f"Energy at {freq / 1e6:.2f} MHz: {power:.1f} dBm",
            })
            break


async def start_sweep(
    freq_start: int = 902_000_000,
    freq_end: int = 928_000_000,
    bins: int = 256,
    gain: int = 400,
    threshold: float = -40.0,
) -> dict:
    global _process, _reader_task, _status, _error_msg, _start_time, _config

    if _status == "running" and _process and _process.returncode is None:
        return {"status": "running", "error": "Already running"}

    binary = shutil.which("rtl_power_fftw")
    if not binary:
        return {"status": "error", "error": "rtl_power_fftw not found. Build from https://github.com/AD-Vega/rtl-power-fftw"}

    # Kill any lingering rtl_power_fftw from a previous run
    try:
        proc_check = await asyncio.create_subprocess_exec(
            "pkill", "-f", "rtl_power_fftw",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc_check.wait()
        await asyncio.sleep(1)
    except Exception:
        pass

    _config = {
        "freq_start": freq_start,
        "freq_end": freq_end,
        "bins": bins,
        "gain": gain,
        "threshold": threshold,
    }
    _sweeps.clear()
    _alerts.clear()
    _error_msg = None

    freq_arg = f"{freq_start}:{freq_end}"
    cmd = [binary, "-f", freq_arg, "-b", str(bins), "-g", str(gain), "-c", "-n", "1"]

    try:
        _process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _reader_task = asyncio.create_task(_read_stdout(_process))
        asyncio.create_task(_monitor_stderr(_process))
        _status = "running"
        _start_time = time.time()
        log.info("Spectrum sweep started: %s", " ".join(cmd))
        return {"status": "running", "config": _config}
    except Exception as e:
        _status = "error"
        _error_msg = str(e)
        log.error("Failed to start spectrum sweep: %s", e)
        return {"status": "error", "error": str(e)}


async def stop_sweep() -> dict:
    global _process, _reader_task, _status

    if _reader_task:
        _reader_task.cancel()
        _reader_task = None

    if _process and _process.returncode is None:
        _process.terminate()
        try:
            await asyncio.wait_for(_process.wait(), timeout=3)
        except asyncio.TimeoutError:
            _process.kill()
        log.info("Spectrum sweep stopped")

    _process = None
    _status = "stopped"
    return {"status": "stopped"}


def get_sweep_data(count: int = 60) -> dict:
    sweeps = list(_sweeps)[-count:] if _sweeps else []
    return {
        "status": _status,
        "config": _config,
        "sweeps": sweeps,
        "alerts": list(_alerts)[-20:],
        "error": _error_msg,
    }


def get_status() -> dict:
    return {
        "status": _status,
        "config": _config,
        "sweep_count": len(_sweeps),
        "uptime_sec": round(time.time() - _start_time, 1) if _status == "running" else 0,
        "alert_count": len(_alerts),
        "error": _error_msg,
    }
