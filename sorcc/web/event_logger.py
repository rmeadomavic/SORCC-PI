"""SORCC-PI — Structured event logger for operator actions and system state changes.

Writes JSONL files with timestamps, event types, and optional payloads.
Each line is a self-contained JSON record. Files are named by date and callsign.
Designed for after-action review by S2 analysts.

Usage:
    from sorcc.web.event_logger import events
    events.log("hunt_started", target="AA:BB:CC:DD:EE:FF", mode="mac")
    events.log("mode_switched", profile="bt-survey")
    events.log("wifi_capture_enabled")
    events.log("export_generated", format="kml", device_count=42)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# Default log directory — matches boot service mkdir
DEFAULT_LOG_DIR = "/opt/sorcc/logs"


class EventLogger:
    """Append-only JSONL event logger with SHA-256 hash chain."""

    def __init__(self, log_dir: str = DEFAULT_LOG_DIR, callsign: str = "SORCC-01"):
        self.log_dir = Path(log_dir)
        self.callsign = callsign
        self._prev_hash = "genesis"
        self._lock = threading.Lock()
        self._file_path: Path | None = None
        self._current_date: str = ""
        self._ensure_dir()

    def _ensure_dir(self):
        try:
            self.log_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            log.warning("Cannot create event log directory %s: %s", self.log_dir, e)

    def _rotate_file(self):
        """Open or rotate log file based on current date."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._current_date:
            self._current_date = today
            self._file_path = self.log_dir / f"events-{self.callsign}-{today}.jsonl"
            self._prev_hash = "genesis"
            # Resume hash chain if file already has entries
            if self._file_path.exists():
                try:
                    with open(self._file_path) as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                record = json.loads(line)
                                self._prev_hash = record.get("chain_hash", self._prev_hash)
                except Exception:
                    pass

    def log(self, event_type: str, **kwargs: Any):
        """Log a structured event with hash chain integrity.

        Args:
            event_type: Event name (e.g., "hunt_started", "mode_switched")
            **kwargs: Arbitrary key-value payload for the event
        """
        self._rotate_file()
        if not self._file_path:
            return

        now = datetime.now(timezone.utc)
        record: dict[str, Any] = {
            "ts": now.isoformat(),
            "epoch": time.time(),
            "callsign": self.callsign,
            "event": event_type,
        }
        record.update(kwargs)

        # SHA-256 hash chain — lock protects _prev_hash across concurrent requests
        with self._lock:
            record_json = json.dumps(record, sort_keys=True)
            chain_hash = hashlib.sha256((record_json + self._prev_hash).encode()).hexdigest()[:16]
            record["chain_hash"] = chain_hash

            try:
                with open(self._file_path, "a") as f:
                    f.write(json.dumps(record) + "\n")
                self._prev_hash = chain_hash  # only advance after successful write
            except OSError as e:
                log.warning("Failed to write event: %s", e)

    def get_recent(self, n: int = 50) -> list[dict]:
        """Read the last N events from today's log file."""
        self._rotate_file()
        if not self._file_path or not self._file_path.exists():
            return []
        try:
            with open(self._file_path) as f:
                lines = f.readlines()
            events = []
            for line in lines[-n:]:
                line = line.strip()
                if line:
                    events.append(json.loads(line))
            return events
        except Exception:
            return []


def verify_chain(filepath: str) -> tuple[bool, int, str]:
    """Verify the SHA-256 hash chain of an event log file.

    Returns:
        (valid, verified_count, error_message)
    """
    prev_hash = "genesis"
    count = 0
    try:
        with open(filepath) as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                stored_hash = record.pop("chain_hash", None)
                if stored_hash is None:
                    return False, count, f"Line {line_num}: missing chain_hash"
                record_json = json.dumps(record, sort_keys=True)
                expected = hashlib.sha256((record_json + prev_hash).encode()).hexdigest()[:16]
                if stored_hash != expected:
                    return False, count, f"Line {line_num}: hash mismatch (tampering or corruption)"
                prev_hash = stored_hash
                count += 1
    except json.JSONDecodeError as e:
        # Tolerate truncated final record (power loss)
        if count > 0:
            return True, count, f"Truncated at line {count + 1} (power loss tolerated)"
        return False, 0, f"Invalid JSON: {e}"
    except FileNotFoundError:
        return False, 0, "File not found"

    return True, count, "Chain verified"


# Singleton instance — initialized by server.py with actual callsign
events = EventLogger()
