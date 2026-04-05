from __future__ import annotations

import subprocess
import time

from fastapi import HTTPException

_cached_modem_index: str | None = None
_cached_modem_index_time: float = 0


def get_modem_index() -> str:
    global _cached_modem_index, _cached_modem_index_time
    if _cached_modem_index and (time.time() - _cached_modem_index_time) < 60:
        return _cached_modem_index
    try:
        result = subprocess.run(["mmcli", "-L"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.splitlines():
            if "/Modem/" in line:
                _cached_modem_index = line.strip().split("/Modem/")[1].split()[0]
                _cached_modem_index_time = time.time()
                return _cached_modem_index
    except Exception:
        pass
    return "0"


def restart_lte_modem() -> dict:
    try:
        result = subprocess.run(["mmcli", "-m", get_modem_index(), "--reset"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return {"status": "ok", "detail": "LTE modem resetting"}
        return {"status": "error", "detail": result.stderr.strip() or "Reset command failed"}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="mmcli not found")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Modem reset timed out")
