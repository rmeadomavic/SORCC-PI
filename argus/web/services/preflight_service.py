from __future__ import annotations

import asyncio
import subprocess
import time
from pathlib import Path


def _run_check(name, category, fn):
    try:
        status, detail = fn()
        return {"name": name, "category": category, "status": status, "detail": detail}
    except Exception as e:
        return {"name": name, "category": category, "status": "fail", "detail": str(e)}


async def run_check_async(name, category, fn):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_check, name, category, fn)


def check_sdr():
    result = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=5)
    if "RTL2832" in result.stdout or "Realtek" in result.stdout:
        return "pass", "RTL-SDR device detected"
    return "warn", "No RTL-SDR device found"


def check_serial():
    found = [p for p in ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2"] if Path(p).exists()]
    if found:
        return "pass", f"Serial devices: {', '.join(found)}"
    return "warn", "No serial devices found"


def check_service(name):
    def _inner():
        result = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True, timeout=5)
        state = result.stdout.strip()
        if state == "active":
            return "pass", f"{name} is active"
        return "fail", f"{name} is {state or 'unknown'}"
    return _inner


def check_time_sync():
    result = subprocess.run(["timedatectl", "show", "--property=NTPSynchronized"], capture_output=True, text=True, timeout=5)
    if "yes" in result.stdout.lower():
        return "pass", "NTP synchronized"
    if time.time() > 1735689600:
        return "warn", "NTP not synced but clock looks reasonable"
    return "fail", "Clock may be wrong — NTP not synchronized"
