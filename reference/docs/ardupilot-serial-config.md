# ArduPilot Serial Port & MAVLink Configuration

How to configure serial ports on ArduPilot flight controllers for MAVLink communication with a companion computer.

Sources:
- [ArduPilot Telemetry Port Setup](https://ardupilot.org/copter/docs/common-telemetry-port-setup.html)
- [ArduPilot Serial Options](https://ardupilot.org/copter/docs/common-serial-options.html)

---

## Table of Contents

1. [Serial Port Mapping](#serial-port-mapping)
2. [SERIALn_PROTOCOL Parameter](#serialn_protocol-parameter)
3. [SERIALn_BAUD Parameter](#serialn_baud-parameter)
4. [SERIALn_OPTIONS Parameter](#serialn_options-parameter)
5. [MAVLink Version (v1 vs v2)](#mavlink-version-v1-vs-v2)
6. [MAVLink Options](#mavlink-options)
7. [Stream Rate Parameters](#stream-rate-parameters)
8. [Pixhawk 6C Configuration](#pixhawk-6c-configuration)
9. [Matek H743 Configuration](#matek-h743-configuration)
10. [Companion Computer Recommended Settings](#companion-computer-recommended-settings)

---

## Serial Port Mapping

ArduPilot uses logical serial port numbers (SERIAL0-SERIAL9) that map to physical UARTs on the flight controller.

### Default Assignments

| Logical Port | Physical Port | Default Protocol | Default Baud | Typical Use |
|-------------|---------------|-----------------|-------------|-------------|
| SERIAL0 | USB | MAVLink2 (2) | 115200 | Ground station via USB |
| SERIAL1 | TELEM1 | MAVLink1 (1) | 57600 | Telemetry radio |
| SERIAL2 | TELEM2 | MAVLink1 (1) | 57600 | Companion computer |
| SERIAL3 | GPS1 | GPS (5) | 115200 | GPS module |
| SERIAL4 | GPS2 | GPS (5) | 115200 | Secondary GPS |
| SERIAL5 | varies | Disabled (-1) | 57600 | User configurable |
| SERIAL6 | varies | Disabled (-1) | 57600 | User configurable |
| SERIAL7 | varies | Disabled (-1) | 57600 | User configurable |

**Any protocol can be assigned to any port** via the SERIALn_PROTOCOL parameter.

---

## SERIALn_PROTOCOL Parameter

Sets the communication protocol for each serial port. Change the `n` to match the port number.

| Value | Protocol | Description |
|-------|----------|-------------|
| -1 | None | Port disabled |
| 1 | MAVLink1 | MAVLink version 1 |
| 2 | MAVLink2 | MAVLink version 2 (recommended for companion computers) |
| 3 | FrSky D | FrSky D-series telemetry |
| 4 | FrSky SPort | FrSky S.Port telemetry |
| 5 | GPS | GPS module (NMEA/UBlox/etc.) |
| 7 | Alexmos Gimbal | Alexmos gimbal serial |
| 8 | SToRM32 Gimbal | SToRM32 serial gimbal |
| 9 | Rangefinder | Lidar/rangefinder |
| 10 | FrSky SPort Passthrough | FrSky passthrough |
| 11 | Lidar360 | 360-degree lidar |
| 12 | Beacon | Pozyx/Marvelmind beacon |
| 13 | Volz Servo | Volz servo protocol |
| 14 | SBus Servo | SBus servo output |
| 15 | ESC Telemetry | ESC telemetry input |
| 16 | Devo Telemetry | Walkera Devo telemetry |
| 17 | OpticalFlow | Optical flow sensor |
| 18 | RobotisServo | Dynamixel servo |
| 19 | NMEA Output | NMEA GPS output |
| 20 | WindVane | Wind vane sensor |
| 21 | SLCAN | CAN bus over serial |
| 22 | RCIN | RC input (serial RC receiver) |
| 23 | MegaSquirt EFI | Engine fuel injection |
| 24 | DJI FPV OSD | DJI FPV system |
| 25 | CoDevESC | CoDevESC |
| 26 | MSP | MultiWii Serial Protocol (for BetaFlight OSD, etc.) |
| 27 | MSP DisplayPort | OSD |
| 28 | MAVLink High Latency | Satellite link MAVLink |
| 29 | DDS/ROS2 | DDS for ROS 2 |
| 30 | Scripting | Lua scripting serial |
| 32 | CRSF (Crossfire/ELRS) | Crossfire/ExpressLRS RC |
| 33 | Generator | Generator control |
| 34 | Winch | Winch control |
| 35 | AIS | AIS receiver (marine) |
| 36 | CoDevESC | CoDevESC output |
| 39 | EFI MS | EFI MegaSquirt |
| 40 | Serial6 GPS | Serial GPS |
| 42 | Torqeedo | Torqeedo motor |
| 43 | AirSpeed | Airspeed sensor |
| 44 | IQ Motor | IQ motor control |

---

## SERIALn_BAUD Parameter

Sets the baud rate for the serial port. Common values:

| Parameter Value | Actual Baud Rate | Recommended For |
|----------------|-----------------|-----------------|
| 1 | 1200 | — |
| 2 | 2400 | — |
| 4 | 4800 | — |
| 9 | 9600 | Low-speed telemetry |
| 19 | 19200 | — |
| 38 | 38400 | Some telemetry radios |
| 57 | 57600 | SiK telemetry radios (default) |
| 111 | 111100 | — |
| 115 | 115200 | USB connections, GPS |
| 230 | 230400 | — |
| 256 | 256000 | — |
| 460 | 460800 | — |
| 500 | 500000 | — |
| 921 | 921600 | Companion computers (recommended) |
| 1500 | 1500000 | High-speed companion link |
| 2000 | 2000000 | Maximum speed |

**For companion computers, use 921600 (parameter value: 921).** This provides high bandwidth for telemetry and commands without reliability issues.

---

## SERIALn_OPTIONS Parameter

Bitmask controlling signal behavior on the serial port. Set to 0 for default behavior in most cases.

| Bit | Value | Function | Notes |
|-----|-------|----------|-------|
| 0 | 1 | Invert RX line | F7/H7 only |
| 1 | 2 | Invert TX line | F7/H7 only |
| 2 | 4 | Half-duplex (TX pin only) | F7/H7 only |
| 3 | 8 | Swap TX and RX pins | F7/H7 only |
| 4 | 16 | RX pull-down | — |
| 5 | 32 | RX pull-up | — |
| 6 | 64 | TX pull-down | — |
| 7 | 128 | TX pull-up | — |
| 8 | 256 | Disable RX DMA | — |
| 9 | 512 | Disable TX DMA | — |
| 10 | 1024 | Don't forward mavlink to/from | — |
| 11 | 2048 | Disable H7 FIFO | H7 only |

**For normal companion computer UART connection: set to 0.**

Signal inversion and pin swap are only available on F7 and H7 processors (both the Pixhawk 6C with STM32H7 and Matek H743 support these).

---

## MAVLink Version (v1 vs v2)

### MAVLink 1 (SERIAL_PROTOCOL = 1)
- Compatible with all MAVLink devices
- Default for TELEM1/TELEM2 for backward compatibility with older telemetry radios
- 8 bytes overhead per message

### MAVLink 2 (SERIAL_PROTOCOL = 2) -- RECOMMENDED
- Message signing (authentication)
- Variable-length messages (more efficient)
- Required for uploading complex geofences
- Required for some newer messages
- Backwards compatible (can still receive v1)
- 14 bytes overhead per message (but variable length saves overall)

**Always use MAVLink 2 for companion computer connections.**

---

## MAVLink Options

### MAV_OPTIONS (affects all MAVLink channels)

| Bit | Function |
|-----|----------|
| 0 | Only accept MAVLink from specific system IDs (MAV_GCS_SYSID) |

### MAVn_OPTIONS (per-channel options)

Where n corresponds to the MAVLink channel number (not the serial port number):

| Bit | Function |
|-----|----------|
| 0 | Accept unsigned MAVLink2 messages |
| 1 | Don't forward messages between MAVLink channels |
| 2 | Ignore GCS stream rate requests (use SR_ parameters only) |
| 3 | Forward packets with bad CRC |

---

## Stream Rate Parameters

Control which telemetry data the flight controller sends, and at what rate, on each MAVLink serial port.

Format: `SRn_<category>` where n is the stream rate channel number.

| Parameter | Data Included | Recommended Hz |
|-----------|--------------|----------------|
| SRn_RAW_SENS | RAW_IMU, SCALED_PRESSURE, SENSOR_OFFSETS | 1-2 |
| SRn_EXT_STAT | SYS_STATUS, POWER_STATUS, MCU_STATUS, MEMINFO, MISSION_CURRENT, GPS_RAW_INT, NAV_CONTROLLER_OUTPUT | 1-2 |
| SRn_RC_CHAN | SERVO_OUTPUT_RAW, RC_CHANNELS | 1-2 |
| SRn_RAW_CTRL | — | 0 |
| SRn_POSITION | GLOBAL_POSITION_INT, LOCAL_POSITION_NED | 3-5 |
| SRn_EXTRA1 | ATTITUDE, SIMSTATE | 4-10 |
| SRn_EXTRA2 | VFR_HUD | 2-4 |
| SRn_EXTRA3 | AHRS, SYSTEM_TIME, RANGEFINDER, BATTERY_STATUS | 1-2 |
| SRn_PARAMS | PARAM_VALUE (parameter stream) | 0 |
| SRn_ADSB | ADSB_VEHICLE | 0 |

**The "n" is the MAVLink instance number, not the serial port number:**
- SR0_ = USB (Serial0)
- SR1_ = TELEM1 (Serial1)
- SR2_ = TELEM2 (Serial2)

**Alternative:** Instead of using SR_ parameters, request specific messages from pymavlink using `MAV_CMD_SET_MESSAGE_INTERVAL`. This is more flexible and doesn't require changing FC parameters.

---

## Pixhawk 6C Configuration

The Pixhawk 6C uses an STM32H753 processor. Physical port assignments:

| Logical Port | Physical Connector | UART |
|-------------|-------------------|------|
| SERIAL0 | USB-C | USB |
| SERIAL1 | TELEM1 (6-pin JST-GH) | USART2 |
| SERIAL2 | TELEM2 (6-pin JST-GH) | USART3 |
| SERIAL3 | GPS1 (6-pin JST-GH) | UART4 |
| SERIAL4 | GPS2 (6-pin JST-GH) | USART1 |
| SERIAL5 | Debug | USART6 |

### Recommended Configuration for Pi Companion Computer on TELEM2

```
SERIAL2_PROTOCOL = 2      (MAVLink2)
SERIAL2_BAUD = 921         (921600 baud)
SERIAL2_OPTIONS = 0        (default)
BRD_SER2_RTSCTS = 0       (no hardware flow control)
```

### TELEM2 Pinout (JST-GH 6-pin)

| Pin | Function | Connect to Pi |
|-----|----------|---------------|
| 1 | +5V | DO NOT connect to Pi |
| 2 | TX (out) | Pi GPIO15 (RXD) |
| 3 | RX (in) | Pi GPIO14 (TXD) |
| 4 | CTS | Not used |
| 5 | RTS | Not used |
| 6 | GND | Pi GND |

---

## Matek H743 Configuration

The Matek H743 uses an STM32H743 processor with many UART options.

### Available UARTs

| Logical Port | UART | TX Pin | RX Pin |
|-------------|------|--------|--------|
| SERIAL1 | UART1 | TX1 | RX1 |
| SERIAL2 | UART2 | TX2 | RX2 |
| SERIAL3 | UART3 | TX3 | RX3 |
| SERIAL4 | UART4 | TX4 | RX4 |
| SERIAL5 | UART5 | TX5 | RX5 |
| SERIAL6 | UART6 | TX6 | RX6 |
| SERIAL7 | UART7 | TX7 | RX7 |
| SERIAL8 | UART8 | TX8 | RX8 |

### Recommended Configuration

Use UART2 (SERIAL2) for the companion computer:

```
SERIAL2_PROTOCOL = 2      (MAVLink2)
SERIAL2_BAUD = 921         (921600 baud)
SERIAL2_OPTIONS = 0        (default)
```

Check the specific Matek H743 variant documentation for physical pin locations.

---

## Companion Computer Recommended Settings

### Flight Controller Side

```
# On TELEM2 (or whichever port connects to the Pi)
SERIAL2_PROTOCOL = 2       # MAVLink 2
SERIAL2_BAUD = 921          # 921600 baud
SERIAL2_OPTIONS = 0         # Default (no inversion, no swap)

# Stream rates (Hz) for companion computer
SR2_POSITION = 5            # GPS position at 5 Hz
SR2_EXTRA1 = 10             # Attitude at 10 Hz
SR2_EXTRA2 = 4              # VFR_HUD at 4 Hz
SR2_EXTRA3 = 2              # Battery/status at 2 Hz
SR2_EXT_STAT = 2            # Extended status at 2 Hz
SR2_RAW_SENS = 1            # Raw sensors at 1 Hz
SR2_RC_CHAN = 1              # RC channels at 1 Hz
```

### Raspberry Pi Side

```bash
# Serial port
Device: /dev/serial0
Baud: 921600

# pymavlink connection string
conn = mavutil.mavlink_connection('/dev/serial0', baud=921600)
```

### Summary of All Required Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| SERIAL2_PROTOCOL | 2 | Enable MAVLink 2 |
| SERIAL2_BAUD | 921 | 921600 baud |
| SERIAL2_OPTIONS | 0 | Default serial options |
| BRD_SER2_RTSCTS | 0 | Disable flow control |
| SR2_POSITION | 5 | Position stream rate |
| SR2_EXTRA1 | 10 | Attitude stream rate |
| SR2_EXTRA2 | 4 | VFR HUD stream rate |
| SR2_EXTRA3 | 2 | Status stream rate |

---

## Quick Reference: Setting Parameters via pymavlink

```python
from pymavlink import mavutil

conn = mavutil.mavlink_connection('/dev/serial0', baud=57600)  # connect at default baud first
conn.wait_heartbeat()

# Change SERIAL2 to MAVLink2 at 921600
def set_param(name, value):
    conn.mav.param_set_send(
        conn.target_system, conn.target_component,
        name.encode('utf-8'), float(value),
        mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
    msg = conn.recv_match(type='PARAM_VALUE', blocking=True, timeout=3)
    if msg:
        print(f"Set {msg.param_id} = {msg.param_value}")

set_param('SERIAL2_PROTOCOL', 2)
set_param('SERIAL2_BAUD', 921)

# Reboot to apply
conn.reboot_autopilot()
```
