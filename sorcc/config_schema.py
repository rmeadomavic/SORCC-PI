"""Config schema -- typed validation for sorcc.ini with plain-English errors.

Validates every section and field in the SORCC-PI configuration file so that
problems surface as clear messages ("LTE APN is blank -- set it to your
carrier's APN") instead of cryptic Python tracebacks.
"""

from __future__ import annotations

import configparser
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class FieldType(Enum):
    BOOL = "bool"
    INT = "int"
    FLOAT = "float"
    STRING = "string"
    ENUM = "enum"


@dataclass
class FieldSpec:
    """Specification for a single config field."""

    type: FieldType
    required: bool = False
    default: Any = None
    min_val: float | None = None
    max_val: float | None = None
    choices: list[str] | None = None  # for ENUM type
    description: str = ""


@dataclass
class ValidationResult:
    """Result of config validation."""

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return len(self.errors) == 0


# ---------------------------------------------------------------------------
# Schema definition -- every config key with type, range, and description.
# Descriptions are written for soldiers, not sysadmins.
# ---------------------------------------------------------------------------

SCHEMA: dict[str, dict[str, FieldSpec]] = {
    "general": {
        "hostname": FieldSpec(
            FieldType.STRING,
            required=True,
            default="sorcc-pi-01",
            description=(
                "mDNS hostname -- this is how you reach the Pi on the "
                "network (e.g. sorcc-pi-01.local)"
            ),
        ),
        "callsign": FieldSpec(
            FieldType.STRING,
            required=True,
            default="SORCC-01",
            description="Identifier shown on the instructor overview screen",
        ),
    },
    "lte": {
        "apn": FieldSpec(
            FieldType.STRING,
            required=False,
            default="",
            description=(
                "Carrier APN for the SIM card. Common values:\n"
                "  T-Mobile:  b2b.static\n"
                "  AT&T:      broadband\n"
                "  Verizon:   vzwinternet\n"
                "  FirstNet:  firstnet\n"
                "Leave blank to be prompted during setup."
            ),
        ),
        "connection_name": FieldSpec(
            FieldType.STRING,
            default="sorcc-lte",
            description="NetworkManager connection name for the LTE link",
        ),
        "dns": FieldSpec(
            FieldType.STRING,
            default="8.8.8.8,1.1.1.1",
            description="DNS servers, comma-separated (e.g. 8.8.8.8,1.1.1.1)",
        ),
    },
    "gps": {
        "serial_port": FieldSpec(
            FieldType.STRING,
            required=True,
            default="/dev/ttyUSB1",
            description="GPS NMEA serial port (usually /dev/ttyUSB1 on the LTE modem)",
        ),
        "serial_baud": FieldSpec(
            FieldType.INT,
            min_val=300,
            max_val=115200,
            default=9600,
            description="GPS serial baud rate (9600 for most NMEA devices)",
        ),
        "at_port": FieldSpec(
            FieldType.STRING,
            required=True,
            default="/dev/ttyUSB2",
            description="AT command port for modem control (usually /dev/ttyUSB2)",
        ),
        "at_baud": FieldSpec(
            FieldType.INT,
            min_val=300,
            max_val=921600,
            default=115200,
            description="AT command port baud rate",
        ),
    },
    "kismet": {
        "user": FieldSpec(
            FieldType.STRING,
            required=True,
            default="kismet",
            description="Kismet web UI username",
        ),
        "pass": FieldSpec(
            FieldType.STRING,
            required=True,
            default="kismet",
            description="Kismet web UI password (change from default before field use!)",
        ),
        "port": FieldSpec(
            FieldType.INT,
            min_val=1,
            max_val=65535,
            default=2501,
            description="Kismet REST API port",
        ),
        "source_bluetooth": FieldSpec(
            FieldType.STRING,
            default="hci0",
            description="Bluetooth source interface (hci0 is built into the RPi 4)",
        ),
        "source_wifi": FieldSpec(
            FieldType.STRING,
            default="",
            description=(
                "WiFi monitor-mode adapter (e.g. wlan0). "
                "Leave blank if no external WiFi adapter is connected."
            ),
        ),
        "source_rtl433": FieldSpec(
            FieldType.STRING,
            default="",
            description=(
                "RTL-433 SDR source (e.g. rtl433-0:channel=433000000). "
                "Leave blank if no SDR dongle is connected."
            ),
        ),
        "source_adsb": FieldSpec(
            FieldType.STRING,
            default="",
            description=(
                "ADS-B SDR source (e.g. rtladsb-00000001). "
                "Leave blank if not using ADS-B."
            ),
        ),
        "log_dir": FieldSpec(
            FieldType.STRING,
            default="/opt/sorcc/output_data",
            description="Directory where Kismet stores capture data",
        ),
    },
    "dashboard": {
        "host": FieldSpec(
            FieldType.STRING,
            default="0.0.0.0",
            description=(
                "Dashboard bind address. 0.0.0.0 means it listens on all "
                "network interfaces (LTE, WiFi, Tailscale)."
            ),
        ),
        "port": FieldSpec(
            FieldType.INT,
            min_val=1,
            max_val=65535,
            default=8080,
            description="Dashboard web port -- open this in your browser",
        ),
    },
    "tailscale": {
        "enabled": FieldSpec(
            FieldType.BOOL,
            default=True,
            description="Install and enable Tailscale VPN for remote access",
        ),
        "ssh": FieldSpec(
            FieldType.BOOL,
            default=True,
            description="Allow SSH connections through Tailscale",
        ),
    },
    "pisugar": {
        "enabled": FieldSpec(
            FieldType.BOOL,
            default=True,
            description="Install PiSugar battery manager software",
        ),
    },
    "wifi": {
        "ssid": FieldSpec(
            FieldType.STRING,
            default="",
            description=(
                "WiFi network name to auto-connect on boot (useful for "
                "headless setup). Leave blank to skip."
            ),
        ),
        "password": FieldSpec(
            FieldType.STRING,
            default="",
            description="WiFi password for the SSID above",
        ),
    },
    "recon_tools": {
        "enabled": FieldSpec(
            FieldType.BOOL,
            default=True,
            description=(
                "Install reconnaissance tools: gr-gsm, kalibrate, "
                "IMSI-catcher, and GQRX"
            ),
        ),
    },
}


def validate(config_path: str | Path) -> ValidationResult:
    """Validate a SORCC config file against the schema.

    Returns a ValidationResult with plain-English errors and warnings.
    """
    result = ValidationResult()
    path = Path(config_path)

    if not path.exists():
        result.errors.append(
            f"Config file not found at {path}. "
            "Run the setup script or copy sorcc.ini.factory to sorcc.ini."
        )
        return result

    cfg = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
    try:
        cfg.read(path)
    except configparser.Error as exc:
        result.errors.append(
            f"Config file is malformed and cannot be read: {exc}. "
            "Try restoring from the factory file."
        )
        return result

    if not cfg.sections():
        result.errors.append(
            "Config file is empty (no sections found). "
            "It may be corrupted -- restore from factory defaults."
        )
        return result

    for section, fields in SCHEMA.items():
        if not cfg.has_section(section):
            has_required = any(f.required for f in fields.values())
            if has_required:
                result.errors.append(
                    f"Missing required section [{section}] -- "
                    f"add it to your config file."
                )
            else:
                result.warnings.append(
                    f"Section [{section}] is missing. "
                    f"Defaults will be used, but you may want to review it."
                )
            continue

        for key, spec in fields.items():
            if not cfg.has_option(section, key):
                if spec.required:
                    result.errors.append(
                        f"[{section}] is missing the required field '{key}' "
                        f"-- {spec.description}"
                    )
                continue

            raw = cfg.get(section, key).strip()

            # Empty values are fine for optional fields
            if not raw and not spec.required:
                continue
            if not raw and spec.required:
                result.errors.append(
                    f"[{section}] '{key}' is blank but it must have a value "
                    f"-- {spec.description}"
                )
                continue

            # --- Type validation ---
            try:
                if spec.type == FieldType.BOOL:
                    if raw.lower() not in (
                        "true", "false", "yes", "no", "1", "0", "on", "off",
                    ):
                        result.errors.append(
                            f"[{section}] {key} should be true or false, "
                            f'but it says "{raw}".'
                        )

                elif spec.type == FieldType.INT:
                    val = int(raw)
                    if spec.min_val is not None and val < spec.min_val:
                        result.errors.append(
                            f"[{section}] {key} must be at least "
                            f"{int(spec.min_val)}, but it is set to {val}."
                        )
                    if spec.max_val is not None and val > spec.max_val:
                        result.errors.append(
                            f"[{section}] {key} must be at most "
                            f"{int(spec.max_val)}, but it is set to {val}."
                        )

                elif spec.type == FieldType.FLOAT:
                    val = float(raw)
                    if spec.min_val is not None and val < spec.min_val:
                        result.errors.append(
                            f"[{section}] {key} must be at least "
                            f"{spec.min_val}, but it is set to {val}."
                        )
                    if spec.max_val is not None and val > spec.max_val:
                        result.errors.append(
                            f"[{section}] {key} must be at most "
                            f"{spec.max_val}, but it is set to {val}."
                        )

                elif spec.type == FieldType.ENUM:
                    if spec.choices and raw.lower() not in [
                        c.lower() for c in spec.choices
                    ]:
                        result.errors.append(
                            f"[{section}] {key} must be one of "
                            f'{spec.choices}, but it says "{raw}".'
                        )

            except ValueError:
                if spec.type == FieldType.INT:
                    result.errors.append(
                        f"[{section}] {key} must be a whole number, "
                        f'but it says "{raw}".'
                    )
                elif spec.type == FieldType.FLOAT:
                    result.errors.append(
                        f"[{section}] {key} must be a number, "
                        f'but it says "{raw}".'
                    )
                else:
                    result.errors.append(
                        f"[{section}] {key} has an invalid value: "
                        f'"{raw}".'
                    )

        # Warn on unknown keys (typo detection)
        for key in cfg.options(section):
            if key not in fields:
                result.warnings.append(
                    f"[{section}] has an unknown field '{key}' "
                    f"-- could be a typo."
                )

    # Warn on unknown sections
    for section in cfg.sections():
        if section not in SCHEMA:
            result.warnings.append(
                f"Unknown section [{section}] in config -- "
                f"could be a typo or leftover from an old version."
            )

    return result
