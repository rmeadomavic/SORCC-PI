# ArduPilot Companion Computer Setup Guide

How to connect a Raspberry Pi companion computer to ArduPilot flight controllers (Pixhawk 6C, Matek H743) via MAVLink.

Sources:
- [ArduPilot Companion Computers](https://ardupilot.org/dev/docs/companion-computers.html)
- [Raspberry Pi via MAVLink](https://ardupilot.org/dev/docs/raspberry-pi-via-mavlink.html)

---

## Table of Contents

1. [Overview](#overview)
2. [Hardware Wiring](#hardware-wiring)
3. [Flight Controller Configuration](#flight-controller-configuration)
4. [Raspberry Pi Serial Setup](#raspberry-pi-serial-setup)
5. [MAVLink Router Software](#mavlink-router-software)
6. [Testing the Connection](#testing-the-connection)
7. [Software Options](#software-options)
8. [Multiple GCS Connections](#multiple-gcs-connections)
9. [WiFi Access Point](#wifi-access-point)
10. [Troubleshooting](#troubleshooting)

---

## Overview

A companion computer (Raspberry Pi) connects to the flight controller's TELEM port via UART serial. The Pi can then:

- Read telemetry (GPS, attitude, battery, status)
- Send commands (arm, disarm, change mode, navigate)
- Route MAVLink to ground stations over WiFi/network
- Run autonomous logic (obstacle avoidance, mission planning)
- Log data locally
- Integrate with TAK, mesh networks, or other systems

The connection uses MAVLink protocol over a serial UART link, typically at 921600 baud.

---

## Hardware Wiring

### Raspberry Pi to TELEM2 Port

Connect three wires between the flight controller's TELEM2 port and the Raspberry Pi GPIO header:

| FC TELEM2 Pin | RPi GPIO Pin | Function |
|---------------|-------------|----------|
| TX | GPIO 15 (RXD, pin 10) | FC transmit -> Pi receive |
| RX | GPIO 14 (TXD, pin 8) | Pi transmit -> FC receive |
| GND | GND (pin 6, 9, 14, 20, 25, 30, 34, 39) | Common ground |

**DO NOT connect the +5V power pin from TELEM to the Pi** unless you know the voltage is regulated and safe. Power the Pi separately via USB-C or a dedicated 5V supply.

### Voltage Level Notes

- **Pixhawk 6C TELEM ports:** 3.3V logic levels -- safe for direct connection to Raspberry Pi GPIO (also 3.3V)
- **Matek H743:** UART TX/RX are 3.3V logic -- safe for direct Pi connection
- If using a 5V-logic flight controller, you MUST use a logic level converter

### Wiring Diagram (text)

```
Flight Controller (TELEM2)          Raspberry Pi
+---+                               +---+
| TX|------------------------------>|RX (GPIO15, pin 10)|
| RX|<------------------------------|TX (GPIO14, pin 8) |
|GND|------------------------------>|GND (pin 6)        |
+---+                               +---+
```

### Alternative: USB Connection

Some flight controllers can connect via USB cable to a Pi USB port. This appears as `/dev/ttyACM0`. Simpler wiring but adds USB overhead and a cable that can vibrate loose.

```
FC USB port ---[USB cable]---> Pi USB port
Device: /dev/ttyACM0
Baud: 115200 (typical for USB)
```

---

## Flight Controller Configuration

Configure these parameters on the flight controller (via Mission Planner, QGroundControl, or MAVProxy):

### For TELEM2 (Serial2) Connection

| Parameter | Value | Description |
|-----------|-------|-------------|
| SERIAL2_PROTOCOL | 2 | MAVLink 2 protocol |
| SERIAL2_BAUD | 921 | 921600 baud rate |
| BRD_SER2_RTSCTS | 0 | Disable hardware flow control (Pi doesn't use it) |

### For Other Serial Ports

If using a different serial port, change the number accordingly:

| Port | Parameters |
|------|-----------|
| TELEM1 | SERIAL1_PROTOCOL=2, SERIAL1_BAUD=921 |
| TELEM2 | SERIAL2_PROTOCOL=2, SERIAL2_BAUD=921 |
| SERIAL4 | SERIAL4_PROTOCOL=2, SERIAL4_BAUD=921 |
| SERIAL5 | SERIAL5_PROTOCOL=2, SERIAL5_BAUD=921 |

### Pixhawk 6C Specific

The Pixhawk 6C has:
- TELEM1 (Serial1): Usually reserved for ground station telemetry radio
- TELEM2 (Serial2): Recommended for companion computer
- GPS1 (Serial3): GPS module
- GPS2 (Serial4): Secondary GPS or companion computer

### Matek H743 Specific

The Matek H743 has multiple UARTs. Common assignments:
- SERIAL1 (UART1): Telemetry
- SERIAL2 (UART2): Companion computer
- SERIAL3 (UART3): GPS
- Check the Matek H743 pinout documentation for physical pin locations

### Stream Rates (Optional but Recommended)

To control which telemetry the FC sends to the companion computer:

| Parameter | Value | Description |
|-----------|-------|-------------|
| SR2_POSITION | 5 | Position data at 5 Hz |
| SR2_EXTRA1 | 10 | Attitude at 10 Hz |
| SR2_EXTRA2 | 2 | VFR_HUD at 2 Hz |
| SR2_EXTRA3 | 1 | Battery/status at 1 Hz |
| SR2_RAW_SENS | 1 | Raw sensors at 1 Hz |
| SR2_RC_CHAN | 1 | RC channels at 1 Hz |

(SR2_ = Stream Rate for Serial2. Use SR1_ for Serial1, etc.)

Alternatively, request specific messages at specific rates from pymavlink using `MAV_CMD_SET_MESSAGE_INTERVAL`.

### Logging to Companion Computer

To also stream dataflash logs to the Pi (for APSync or custom logging):

| Parameter | Value | Description |
|-----------|-------|-------------|
| LOG_BACKEND_TYPE | 3 | Log to both SD card and MAVLink |

---

## Raspberry Pi Serial Setup

### Enable Hardware UART

```bash
sudo raspi-config
```

Navigate to: **Interface Options -> Serial Port**
- "Would you like a login shell to be accessible over serial?" -> **No**
- "Would you like the serial port hardware to be enabled?" -> **Yes**

Reboot after changing.

### Verify Serial Port

After reboot, the UART is available at:
- `/dev/serial0` (symlink to the correct UART, recommended)
- `/dev/ttyAMA0` (on Pi 4/5 with Bluetooth moved or disabled)
- `/dev/ttyS0` (mini UART on some Pi models, less reliable)

```bash
# Check the symlink
ls -la /dev/serial0

# Verify UART is enabled
dmesg | grep tty
```

### Disable Bluetooth (Pi 4/5) for Full UART

On Pi 4 and Pi 5, the full UART (PL011) is used by Bluetooth by default. To reclaim it for the serial connection:

Add to `/boot/firmware/config.txt` (or `/boot/config.txt` on older OS):

```
dtoverlay=disable-bt
```

Then disable the Bluetooth service:

```bash
sudo systemctl disable hciuart
sudo reboot
```

After this, `/dev/serial0` points to the full PL011 UART which is more reliable for high baud rates.

---

## MAVLink Router Software

You need software to manage MAVLink routing between the serial port, local applications, and remote ground stations.

### Option 1: mavlink-router (Recommended)

Lightweight, reliable C++ MAVLink router.

```bash
# Install
sudo apt install -y git meson ninja-build pkg-config gcc g++ systemd
git clone https://github.com/mavlink-router/mavlink-router.git
cd mavlink-router
git submodule update --init --recursive
meson setup build .
ninja -C build
sudo ninja -C build install
```

Configuration file `/etc/mavlink-router/main.conf`:

```ini
[General]
TcpServerPort = 5760
ReportStats = false
MavlinkDialect = ardupilotmega

[UartEndpoint to_fc]
Device = /dev/serial0
Baud = 921600

[UdpEndpoint to_gcs]
Mode = Normal
Address = 0.0.0.0
Port = 14550

[UdpEndpoint to_local]
Mode = Normal
Address = 127.0.0.1
Port = 14551
```

Run as service:

```bash
sudo systemctl enable mavlink-router
sudo systemctl start mavlink-router
```

### Option 2: MAVProxy

Python-based, feature-rich but heavier. Good for development/testing.

```bash
pip3 install MAVProxy

# Basic routing
mavproxy.py --master=/dev/serial0 --baudrate 921600 \
  --out udp:0.0.0.0:14550 \
  --out udp:127.0.0.1:14551 \
  --daemon --non-interactive
```

**Warning:** MAVProxy may not be reliable on heavily loaded Raspberry Pi, especially older models.

### Option 3: mavp2p

Lightweight Go-based MAVLink proxy. Pre-built binaries for ARM.

```bash
# Download from https://github.com/bluenviron/mavp2p/releases
wget https://github.com/bluenviron/mavp2p/releases/download/v1.1.0/mavp2p_v1.1.0_linux_arm64v8.tar.gz
tar xzf mavp2p_*.tar.gz
sudo mv mavp2p /usr/local/bin/

# Run
mavp2p serial:/dev/serial0:921600 udps:0.0.0.0:14550 udps:127.0.0.1:14551
```

---

## Testing the Connection

### Quick Test with pymavlink

```python
#!/usr/bin/env python3
from pymavlink import mavutil

# Connect directly (without router)
conn = mavutil.mavlink_connection('/dev/serial0', baud=921600)

# Or via router UDP
# conn = mavutil.mavlink_connection('udpin:127.0.0.1:14551')

print("Waiting for heartbeat...")
conn.wait_heartbeat(timeout=30)
print(f"Connected! System {conn.target_system}, Component {conn.target_component}")

# Read some telemetry
for i in range(10):
    msg = conn.recv_match(blocking=True, timeout=5)
    if msg:
        print(f"{msg.get_type()}: {msg.to_dict()}")
```

### Quick Test with MAVProxy

```bash
mavproxy.py --master=/dev/serial0 --baudrate 921600

# In the MAVProxy console:
# status         - show vehicle status
# mode GUIDED    - change mode
# arm throttle   - arm (REMOVE PROPS FIRST)
# param show WP_SPEED  - read parameter
```

---

## Software Options

| Software | Language | Best For |
|----------|----------|----------|
| pymavlink | Python | Custom scripts, direct MAVLink control |
| MAVProxy | Python | Testing, interactive control, routing |
| mavlink-router | C++ | Production routing, low overhead |
| mavp2p | Go | Lightweight routing |
| DroneKit-Python | Python | High-level API (legacy, less maintained) |
| MAVSDK-Python | Python | Modern high-level API |
| ROS/MAVROS | C++/Python | Robotics framework integration |
| Rpanion-server | Node.js | Web-based config GUI |

### For SORCC-PI (Recommended Stack)

1. **mavlink-router** for serial-to-UDP routing
2. **pymavlink** for custom Python control logic
3. **FastAPI** for the web dashboard (already in use)

---

## Multiple GCS Connections

The flight controller can serve multiple MAVLink consumers simultaneously:

```
                    +---> TELEM1 ---> Telemetry Radio ---> Mission Planner
Flight Controller --+
                    +---> TELEM2 ---> Raspberry Pi
                                        |
                    mavlink-router ------+---> UDP :14550 ---> GCS over WiFi
                                        +---> UDP :14551 ---> pymavlink app
                                        +---> TCP :5760  ---> Other tools
```

---

## WiFi Access Point

To create a WiFi hotspot on the Pi for field use (connecting tablets, laptops):

```bash
# Using NetworkManager (Pi OS Bookworm)
sudo nmcli device wifi hotspot ifname wlan0 ssid SORCC-PI password sorcc1234 band bg

# Or for persistent AP, configure in /etc/NetworkManager/system-connections/
```

Ground stations then connect to the Pi WiFi and use UDP port 14550 for MAVLink.

---

## Troubleshooting

### No Heartbeat Received

1. **Check wiring:** TX->RX and RX->TX (crossover). GND connected.
2. **Check baud rate:** Must match on both FC and Pi (921600 recommended).
3. **Check serial port:** `ls -la /dev/serial0` should exist.
4. **Check FC parameters:** SERIAL2_PROTOCOL=2, SERIAL2_BAUD=921.
5. **Check permissions:** `sudo usermod -aG dialout $USER` then re-login.
6. **Check console is disabled:** `sudo raspi-config` -> serial login shell must be disabled.

### Garbled Data

1. **Baud rate mismatch** between FC and Pi.
2. **Using mini UART** (`/dev/ttyS0`) which is clock-dependent. Switch to PL011 by disabling Bluetooth.
3. **Electrical noise.** Keep serial wires short and away from motors/ESCs.

### Intermittent Disconnects

1. **Loose wiring** -- solder connections or use quality connectors.
2. **Pi under heavy load** -- MAVProxy may drop packets. Use mavlink-router instead.
3. **Power supply** -- insufficient power causes Pi instability. Use a quality 5V 3A supply.

### Permission Denied on /dev/serial0

```bash
sudo usermod -aG dialout $USER
# Log out and back in, or:
sudo chmod 666 /dev/serial0  # temporary fix
```

### Identifying the Correct Serial Port

```bash
# List serial ports
ls -la /dev/serial* /dev/ttyACM* /dev/ttyUSB* /dev/ttyAMA* 2>/dev/null

# Monitor serial port for data
python3 -c "
import serial
s = serial.Serial('/dev/serial0', 921600, timeout=1)
while True:
    data = s.read(100)
    if data:
        print(data.hex())
"
```
