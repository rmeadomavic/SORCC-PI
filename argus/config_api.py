"""Config file read/write with file locking for Argus.

Provides safe concurrent access to argus.ini via fcntl file locking,
automatic backups, and factory-reset support.
"""

from __future__ import annotations

import configparser
import fcntl
import logging
import os
import shutil
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_CONFIG_PATH = Path("/opt/argus/config/argus.ini")

_config_path: Path | None = None

# Fields that must be redacted in GET responses
REDACTED_FIELDS: dict[str, set[str]] = {
    "kismet": {"pass"},
    "wifi": {"password"},
    "dashboard": {"password"},
}

REDACTED_VALUE = "***"

# Fields that require a service restart to take effect
RESTART_REQUIRED_FIELDS: dict[str, set[str]] = {
    "dashboard": {"host", "port"},
    "kismet": {"port"},
    "general": {"hostname"},
}


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def set_config_path(path: Path | str) -> None:
    """Set the argus.ini path (called at startup)."""
    global _config_path
    _config_path = Path(path)


def get_config_path() -> Path:
    """Return the current argus.ini path."""
    if _config_path is not None:
        return _config_path
    return DEFAULT_CONFIG_PATH


def _backup_path() -> Path:
    return Path(str(get_config_path()) + ".bak")


def _factory_path() -> Path:
    return Path(str(get_config_path()) + ".factory")


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def read_config() -> dict[str, dict[str, str]]:
    """Read argus.ini and return as nested dict. Redacts sensitive fields."""
    result = read_config_raw()

    # Redact sensitive fields
    for section in REDACTED_FIELDS:
        if section not in result:
            continue
        for fld in REDACTED_FIELDS[section]:
            if fld in result[section] and result[section][fld]:
                result[section][fld] = REDACTED_VALUE

    return result


def read_config_raw() -> dict[str, dict[str, str]]:
    """Read argus.ini and return as nested dict without redaction.

    Internal-only helper for server-side operational logic that needs
    actual secret values.
    """
    path = get_config_path()
    config = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
    config.read(path)

    result: dict[str, dict[str, str]] = {}
    for section in config.sections():
        result[section] = dict(config[section])

    return result


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def write_config(updates: dict[str, dict[str, str]]) -> dict[str, Any]:
    """Merge updates into argus.ini with atomic write and file locking.

    Returns a dict with 'restart_required' and 'skipped' lists.
    """
    path = get_config_path()
    restart_needed: list[str] = []
    skipped: list[str] = []

    # Read current config
    config = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
    config.read(path)

    # Apply updates
    for section, fields in updates.items():
        if not isinstance(fields, dict):
            continue
        if not config.has_section(section):
            skipped.append(f"{section} (unknown section)")
            continue
        for key, value in fields.items():
            if not isinstance(value, str):
                value = str(value)
            # Skip redacted placeholder -- preserve existing value
            if section in REDACTED_FIELDS and key in REDACTED_FIELDS[section]:
                if value == REDACTED_VALUE:
                    continue
            if not config.has_option(section, key):
                skipped.append(f"{section}.{key} (unknown field)")
                continue
            old_value = config.get(section, key)
            if old_value != value:
                config.set(section, key, value)
                logger.info("CONFIG WRITE: %s.%s = %s", section, key, value)
                # Check if restart required
                if (
                    section in RESTART_REQUIRED_FIELDS
                    and key in RESTART_REQUIRED_FIELDS[section]
                ):
                    restart_needed.append(f"{section}.{key}")

    # Back up existing file before writing
    bak = _backup_path()
    if path.exists():
        shutil.copy2(path, bak)

    # Write config with file locking
    lock_fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        with open(path, "w") as f:
            config.write(f)
            f.flush()
            os.fsync(f.fileno())
        logger.info(
            "Config written to %s (%d fields triggered restart)",
            path,
            len(restart_needed),
        )
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)

    return {"restart_required": restart_needed, "skipped": skipped}


# ---------------------------------------------------------------------------
# Backup / Restore
# ---------------------------------------------------------------------------

def has_backup() -> bool:
    """Check if a config backup (.bak) exists."""
    return _backup_path().exists()


def restore_backup() -> bool:
    """Restore argus.ini from argus.ini.bak. Returns True on success."""
    bak = _backup_path()
    if not bak.exists():
        return False
    shutil.copy2(bak, get_config_path())
    logger.info("Config restored from backup: %s", bak)
    return True


def has_factory() -> bool:
    """Check if the factory defaults file (.factory) exists."""
    return _factory_path().exists()


def restore_factory() -> bool:
    """Restore argus.ini from argus.ini.factory. Returns True on success.

    Backs up the current config to .bak before overwriting.
    """
    factory = _factory_path()
    if not factory.exists():
        return False
    path = get_config_path()
    # Preserve current config as backup
    if path.exists():
        shutil.copy2(path, _backup_path())
    shutil.copy2(factory, path)
    logger.info("Config restored from factory defaults: %s", factory)
    return True


def backup_on_boot() -> None:
    """Copy current argus.ini to argus.ini.bak on successful boot.

    Only backs up if the config parses successfully -- preserves
    last-known-good .bak when current config is corrupted.
    """
    path = get_config_path()
    if not path.exists():
        return
    # Only backup if config parses successfully
    cfg = configparser.ConfigParser()
    try:
        cfg.read(path)
        if not cfg.sections():
            logger.warning("Config has no sections -- skipping backup")
            return
    except configparser.Error:
        logger.warning(
            "Config parse error -- skipping backup to preserve "
            "last-known-good .bak"
        )
        return
    bak = _backup_path()
    shutil.copy2(path, bak)
    logger.info("Config backed up to %s", bak)
