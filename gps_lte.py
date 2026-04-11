#!/usr/bin/env python3
"""Enable GPS NMEA output on the SixFab LTE modem via AT commands.

Standalone script — the dashboard calls this at boot via argus-boot.service.
"""

import glob
import logging
import serial
import sys
import time

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

AT_CMD = "AT$GPSNMUN=2,1,1,1,1,1,1\r\n"
DEFAULT_PORT = "/dev/ttyUSB2"
BAUD = 115200
TIMEOUT = 2
MAX_RETRIES = 3


def find_serial_port():
    """Auto-detect the AT command serial port, falling back to the default."""
    candidates = sorted(glob.glob("/dev/ttyUSB*"))
    if DEFAULT_PORT in candidates:
        return DEFAULT_PORT
    if candidates:
        log.warning("Default port %s not found, trying %s", DEFAULT_PORT, candidates[-1])
        return candidates[-1]
    return DEFAULT_PORT


def enable_gps(port=None, retries=MAX_RETRIES):
    """Send AT command to enable NMEA GPS output on the modem.

    Returns True on success, False on failure.
    """
    port = port or find_serial_port()

    for attempt in range(1, retries + 1):
        try:
            log.info("Attempt %d/%d: opening %s at %d baud", attempt, retries, port, BAUD)
            ser = serial.Serial(port, BAUD, timeout=TIMEOUT)
            ser.write(AT_CMD.encode())
            time.sleep(0.5)
            response = ser.readline().decode(errors="replace").strip()
            ser.close()

            if "OK" in response or "GPSNMUN" in response:
                log.info("GPS NMEA enabled successfully: %s", response)
                return True

            if response:
                log.warning("Unexpected response: %s", response)
            else:
                log.warning("No response from modem")

        except serial.SerialException as e:
            log.error("Serial error on %s: %s", port, e)
        except OSError as e:
            log.error("OS error on %s: %s", port, e)

        if attempt < retries:
            log.info("Retrying in 2 seconds...")
            time.sleep(2)

    log.error("Failed to enable GPS after %d attempts", retries)
    return False


if __name__ == "__main__":
    success = enable_gps()
    sys.exit(0 if success else 1)
