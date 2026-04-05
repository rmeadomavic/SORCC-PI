from __future__ import annotations

import configparser
import json
import logging
import secrets
import time
from pathlib import Path

from argus.web.event_logger import events

try:
    from argus.config_api import (
        read_config,
        write_config,
        restore_backup,
        restore_factory,
        has_backup,
        has_factory,
        set_config_path,
        get_config_path,
        REDACTED_VALUE,
        read_config_raw,
    )
    HAS_CONFIG_API = True
except ImportError:
    HAS_CONFIG_API = False

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
PROJECT_ROOT = BASE_DIR.parent.parent
PROFILES_PATH = PROJECT_ROOT / "profiles.json"

active_profile: str = "wifi-survey"

device_first_seen: dict[str, float] = {}
last_device_snapshot: dict[str, int] = {}

web_password: str | None = None
session_secret: bytes = secrets.token_bytes(32)
session_timeout_sec: int = 8 * 3600

auth_failures: dict[str, tuple[int, float]] = {}
AUTH_MAX_FAILURES = 10
AUTH_LOCKOUT_SEC = 300


def configure_web_password(password: str | None, timeout_min: int = 480) -> None:
    global web_password, session_timeout_sec
    web_password = password if password else None
    session_timeout_sec = timeout_min * 60
    if web_password:
        log.info("Web password auth enabled (session timeout: %d min).", timeout_min)
    else:
        log.info("Web password auth disabled (no password configured).")


def load_profiles() -> dict:
    try:
        return json.loads(PROFILES_PATH.read_text())
    except Exception as e:
        log.warning("Could not load profiles.json: %s", e)
        return {"default_profile": "wifi-survey", "profiles": []}


def get_callsign() -> str:
    if HAS_CONFIG_API:
        try:
            cfg = read_config()
            return cfg.get("general", {}).get("callsign", "ARGUS-01")
        except Exception:
            pass
    return "ARGUS-01"


def startup_load_web_password() -> None:
    if not HAS_CONFIG_API:
        return
    try:
        cfg = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
        cfg.read(get_config_path())
        password = cfg.get("dashboard", "password", fallback="").strip()
        timeout = cfg.getint("dashboard", "session_timeout_min", fallback=480)
        configure_web_password(password or None, timeout)
    except Exception as e:
        log.warning("Could not read dashboard password config: %s", e)


def startup_events() -> None:
    events.callsign = get_callsign()
    events.log("system_startup", version="2.0.0")
