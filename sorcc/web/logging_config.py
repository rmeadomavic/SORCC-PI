"""SORCC-PI — Structured logging with rotation and in-memory ring buffer."""

from __future__ import annotations

import collections
import json
import logging
import logging.handlers
import time
from pathlib import Path


LOG_DIR = Path("/opt/sorcc/logs")
LOG_FILE = LOG_DIR / "dashboard.log"
MAX_BYTES = 5 * 1024 * 1024  # 5MB per file
BACKUP_COUNT = 3              # Keep 3 rotated files (15MB total max)
RING_SIZE = 500               # In-memory ring buffer for /api/logs


class _RingHandler(logging.Handler):
    """Keeps the last N log records in memory for the /api/logs endpoint."""

    def __init__(self, maxlen: int = RING_SIZE):
        super().__init__()
        self.records: collections.deque[dict] = collections.deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append({
            "ts": record.created,
            "level": record.levelname,
            "logger": record.name,
            "msg": self.format(record),
            "module": record.module,
            "func": record.funcName,
            "line": record.lineno,
        })

    def get_recent(self, n: int = 100, level: str | None = None) -> list[dict]:
        entries = list(self.records)
        if level:
            level_upper = level.upper()
            entries = [e for e in entries if e["level"] == level_upper]
        return entries[-n:]


# Singleton ring handler — importable by /api/logs endpoint
ring_handler = _RingHandler(RING_SIZE)


class _JSONFormatter(logging.Formatter):
    """Compact JSON log lines for file output."""

    def format(self, record: logging.LogRecord) -> str:
        data = {
            "t": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(record.created)),
            "l": record.levelname[0],  # I/W/E/D
            "n": record.name,
            "m": record.getMessage(),
        }
        if record.exc_info and record.exc_info[0]:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, separators=(",", ":"))


class _ConsoleFormatter(logging.Formatter):
    """Clean console format for journalctl readability."""

    def format(self, record: logging.LogRecord) -> str:
        return f"[{record.levelname}] {record.name}: {record.getMessage()}"


def setup_logging(level: int = logging.INFO) -> None:
    """Configure root logger with file rotation, console, and ring buffer."""
    root = logging.getLogger()
    root.setLevel(level)

    # Clear any existing handlers (prevents double-logging on reload)
    root.handlers.clear()

    # Console handler (for journalctl / systemd)
    console = logging.StreamHandler()
    console.setFormatter(_ConsoleFormatter())
    console.setLevel(level)
    root.addHandler(console)

    # Rotating file handler
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            str(LOG_FILE), maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT,
        )
        file_handler.setFormatter(_JSONFormatter())
        file_handler.setLevel(level)
        root.addHandler(file_handler)
    except OSError:
        logging.warning(f"Cannot write to {LOG_DIR}, file logging disabled")

    # Ring buffer handler (for /api/logs)
    ring_handler.setFormatter(_ConsoleFormatter())
    ring_handler.setLevel(level)
    root.addHandler(ring_handler)

    # Quiet down noisy libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
