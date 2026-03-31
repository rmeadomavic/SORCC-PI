# Pymavlink Usage Guide

Python library for MAVLink protocol communication with ArduPilot flight controllers.

Sources:
- [pymavlink (MAVLink Python)](https://mavlink.io/en/mavgen_python/)
- [ArduSub pymavlink reference](https://www.ardusub.com/developers/pymavlink.html)
- [pymavlink GitHub](https://github.com/ArduPilot/pymavlink)

---

## Table of Contents

1. [Installation](#installation)
2. [Connection Setup](#connection-setup)
3. [Heartbeat and Connection Health](#heartbeat-and-connection-health)
4. [Receiving Messages](#receiving-messages)
5. [Arming and Disarming](#arming-and-disarming)
6. [Changing Flight Modes](#changing-flight-modes)
7. [Position Commands (Guided Mode)](#position-commands-guided-mode)
8. [Velocity Commands](#velocity-commands)
9. [Parameter Management](#parameter-management)
10. [RC Override](#rc-override)
11. [Requesting Message Streams](#requesting-message-streams)
12. [Mission Upload](#mission-upload)
13. [Servo Control](#servo-control)
14. [Complete Examples](#complete-examples)

---

## Installation

```bash
# Standard installation
pip3 install pymavlink

# With MAVProxy (useful for testing)
pip3 install pymavlink mavproxy

# Verify installation
python3 -c "import pymavlink; print(pymavlink.__doc__)"
```

### Dependencies on Raspberry Pi

```bash
sudo apt update
sudo apt install -y python3-pip python3-dev
pip3 install pymavlink
```

### MAVLink 2 Support

Set environment variable before importing, or use dialect import:

```python
import os
os.environ['MAVLINK20'] = '1'

from pymavlink import mavutil
```

Or import a specific dialect directly:

```python
from pymavlink.dialects.v20 import ardupilotmega as mavlink2
```

---

## Connection Setup

### Serial Connection (Raspberry Pi to Flight Controller via UART)

```python
from pymavlink import mavutil

# Typical Pi UART connection to TELEM2
master = mavutil.mavlink_connection('/dev/serial0', baud=921600)

# USB connection to Pixhawk
master = mavutil.mavlink_connection('/dev/ttyACM0', baud=115200)

# Wait for heartbeat to confirm connection
master.wait_heartbeat()
print(f"Connected: system {master.target_system}, component {master.target_component}")
```

### UDP Connections

```python
# Listen for incoming UDP (ground station style)
master = mavutil.mavlink_connection('udpin:0.0.0.0:14550')

# Connect out to a known address
master = mavutil.mavlink_connection('udpout:127.0.0.1:14550')

# Broadcast (locks to first responder)
master = mavutil.mavlink_connection('udpbcast:192.168.1.255:14550')
```

### TCP Connection

```python
# TCP client
master = mavutil.mavlink_connection('tcp:127.0.0.1:5760')
```

### Connection String Format

`[protocol:]address[:port]`

| Format | Use Case |
|--------|----------|
| `/dev/serial0` | Pi UART to FC |
| `/dev/ttyACM0` | USB to FC |
| `/dev/ttyUSB0` | USB-serial adapter |
| `udpin:0.0.0.0:14550` | Listen for UDP |
| `udpout:host:port` | Send UDP to target |
| `tcp:host:port` | TCP client |

---

## Heartbeat and Connection Health

All MAVLink systems must send heartbeats at >= 1 Hz. The companion computer should send its own heartbeats.

```python
import time
import threading
from pymavlink import mavutil

master = mavutil.mavlink_connection('/dev/serial0', baud=921600)

def send_heartbeat():
    """Send companion computer heartbeat every second."""
    while True:
        master.mav.heartbeat_send(
            mavutil.mavlink.MAV_TYPE_GCS,               # type (GCS)
            mavutil.mavlink.MAV_AUTOPILOT_INVALID,       # autopilot
            0,                                            # base_mode
            0,                                            # custom_mode
            mavutil.mavlink.MAV_STATE_ACTIVE              # system_status
        )
        time.sleep(1)

# Run heartbeat in background thread
hb_thread = threading.Thread(target=send_heartbeat, daemon=True)
hb_thread.start()

# Wait for autopilot heartbeat
master.wait_heartbeat()
print(f"Heartbeat from system {master.target_system}")
```

---

## Receiving Messages

### Basic Message Loop

```python
while True:
    msg = master.recv_match(blocking=True, timeout=1.0)
    if msg is None:
        continue
    msg_type = msg.get_type()
    if msg_type == 'BAD_DATA':
        continue
    print(f"{msg_type}: {msg.to_dict()}")
```

### Filter by Message Type

```python
# Wait for a specific message type
msg = master.recv_match(type='GLOBAL_POSITION_INT', blocking=True, timeout=5.0)
if msg:
    lat = msg.lat / 1e7
    lon = msg.lon / 1e7
    alt = msg.relative_alt / 1000.0
    print(f"Position: {lat}, {lon}, alt={alt}m")
```

### Access Last Received Message

```python
# Access cached messages (non-blocking)
try:
    gps = master.messages['GPS_RAW_INT']
    age = master.time_since('GPS_RAW_INT')
    print(f"GPS: {gps.lat/1e7}, {gps.lon/1e7}, age={age:.1f}s")
except KeyError:
    print("No GPS data received yet")
```

### Multiple Message Types

```python
msg = master.recv_match(
    type=['HEARTBEAT', 'GLOBAL_POSITION_INT', 'ATTITUDE'],
    blocking=True,
    timeout=1.0
)
if msg:
    if msg.get_type() == 'ATTITUDE':
        print(f"Roll={msg.roll:.2f} Pitch={msg.pitch:.2f} Yaw={msg.yaw:.2f}")
```

### Condition Filtering

```python
# Wait for armed heartbeat
msg = master.recv_match(
    type='HEARTBEAT',
    condition='HEARTBEAT.base_mode & 128',  # armed flag
    blocking=True
)
```

---

## Arming and Disarming

```python
def arm(master):
    """Arm the vehicle."""
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0,      # confirmation
        1,      # param1: 1=arm
        0, 0, 0, 0, 0, 0  # params 2-7
    )
    # Wait for ACK
    ack = master.recv_match(type='COMMAND_ACK', blocking=True, timeout=3)
    if ack and ack.result == 0:
        print("Armed successfully")
    else:
        print(f"Arm failed: {ack}")

def disarm(master):
    """Disarm the vehicle."""
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0,
        0,      # param1: 0=disarm
        0, 0, 0, 0, 0, 0
    )
    ack = master.recv_match(type='COMMAND_ACK', blocking=True, timeout=3)
    if ack and ack.result == 0:
        print("Disarmed successfully")

def force_arm(master):
    """Force arm (bypass prearm checks) -- USE WITH CAUTION."""
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0,
        1,      # arm
        21196,  # param2: magic number to force arm
        0, 0, 0, 0, 0
    )

# Convenience methods (also available)
master.arducopter_arm()   # arm
master.arducopter_disarm()  # disarm
master.motors_armed_wait()  # block until armed
master.motors_disarmed_wait()  # block until disarmed
```

---

## Changing Flight Modes

### Using SET_MODE message

```python
def set_mode(master, mode_name):
    """Set flight mode by name (e.g., 'GUIDED', 'AUTO', 'RTL')."""
    mode_map = master.mode_mapping()
    if mode_name not in mode_map:
        print(f"Unknown mode: {mode_name}")
        print(f"Available modes: {list(mode_map.keys())}")
        return False

    mode_id = mode_map[mode_name]
    master.mav.set_mode_send(
        master.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode_id
    )

    # Wait for ACK
    ack = master.recv_match(type='COMMAND_ACK', blocking=True, timeout=3)
    return ack and ack.result == 0

# Usage
set_mode(master, 'GUIDED')
set_mode(master, 'AUTO')
set_mode(master, 'RTL')
```

### Using COMMAND_LONG

```python
def set_mode_cmd(master, mode_name):
    """Set flight mode via COMMAND_LONG."""
    mode_id = master.mode_mapping()[mode_name]
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_DO_SET_MODE,
        0,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode_id,
        0, 0, 0, 0, 0
    )
```

### Common Mode Names

**ArduCopter:** STABILIZE, ALT_HOLD, LOITER, AUTO, GUIDED, RTL, LAND, POSHOLD, GUIDED_NOGPS

**ArduRover:** MANUAL, STEERING, HOLD, AUTO, GUIDED, RTL, SMART_RTL

---

## Position Commands (Guided Mode)

### Fly/Drive to GPS Coordinates

```python
def goto_position_global(master, lat, lon, alt, alt_frame='relative'):
    """
    Navigate to a GPS position in GUIDED mode.
    lat, lon: decimal degrees
    alt: meters
    alt_frame: 'relative' (above home), 'amsl' (above sea level), 'terrain'
    """
    frames = {
        'relative': mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        'amsl': mavutil.mavlink.MAV_FRAME_GLOBAL_INT,
        'terrain': mavutil.mavlink.MAV_FRAME_GLOBAL_TERRAIN_ALT_INT,
    }
    frame = frames.get(alt_frame, frames['relative'])

    master.mav.set_position_target_global_int_send(
        0,                  # time_boot_ms (0 = not used)
        master.target_system,
        master.target_component,
        frame,
        0x0DF8,             # type_mask: use position only (3576)
        int(lat * 1e7),     # lat_int
        int(lon * 1e7),     # lon_int
        alt,                # altitude (meters)
        0, 0, 0,            # vx, vy, vz (ignored)
        0, 0, 0,            # afx, afy, afz (ignored)
        0, 0                # yaw, yaw_rate (ignored)
    )

# Usage: fly to coordinates at 10m above home
goto_position_global(master, 35.3621, -149.1651, 10.0)
```

### Move to Local Position (relative to EKF origin)

```python
def goto_position_local(master, north, east, down):
    """
    Move to position in meters relative to EKF origin.
    north: meters north, east: meters east, down: meters down (negative = up)
    """
    master.mav.set_position_target_local_ned_send(
        0,
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_FRAME_LOCAL_NED,
        0x0DF8,             # type_mask: position only
        north, east, down,  # x, y, z (NED)
        0, 0, 0,            # vx, vy, vz
        0, 0, 0,            # afx, afy, afz
        0, 0                # yaw, yaw_rate
    )

# Fly to 100m north, 0m east, 10m above origin
goto_position_local(master, 100, 0, -10)
```

### Move Relative to Current Position

```python
def goto_offset(master, forward, right, down):
    """Move relative to current position."""
    master.mav.set_position_target_local_ned_send(
        0,
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_FRAME_LOCAL_OFFSET_NED,  # offset from current
        0x0DF8,
        forward, right, down,
        0, 0, 0,
        0, 0, 0,
        0, 0
    )
```

---

## Velocity Commands

Velocity commands must be re-sent every second. Vehicle stops after 3 seconds without update.

```python
def send_velocity(master, vn, ve, vd):
    """
    Send velocity command in NED frame (m/s).
    vn: north velocity, ve: east velocity, vd: down velocity (negative = up)
    """
    master.mav.set_position_target_local_ned_send(
        0,
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_FRAME_LOCAL_NED,
        0x0DC7,             # type_mask: velocity only (3527)
        0, 0, 0,            # x, y, z (ignored)
        vn, ve, vd,         # vx, vy, vz
        0, 0, 0,            # afx, afy, afz (ignored)
        0, 0                # yaw, yaw_rate (ignored)
    )

# Fly north at 2 m/s
send_velocity(master, 2.0, 0, 0)

# Fly forward relative to heading at 1 m/s
def send_velocity_body(master, forward, right, down):
    """Velocity relative to vehicle heading."""
    master.mav.set_position_target_local_ned_send(
        0,
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_FRAME_BODY_OFFSET_NED,  # body-relative
        0x0DC7,
        0, 0, 0,
        forward, right, down,
        0, 0, 0,
        0, 0
    )
```

---

## Parameter Management

### Read a Single Parameter

```python
def get_param(master, param_name):
    """Read a single parameter value."""
    master.mav.param_request_read_send(
        master.target_system,
        master.target_component,
        param_name.encode('utf-8'),
        -1  # use name, not index
    )
    msg = master.recv_match(type='PARAM_VALUE', blocking=True, timeout=3)
    if msg:
        print(f"{msg.param_id}: {msg.param_value}")
        return msg.param_value
    return None

# Usage
get_param(master, 'WP_SPEED')
get_param(master, 'WPNAV_SPEED')
```

### Write a Parameter

```python
def set_param(master, param_name, value):
    """Set a parameter value."""
    master.mav.param_set_send(
        master.target_system,
        master.target_component,
        param_name.encode('utf-8'),
        float(value),
        mavutil.mavlink.MAV_PARAM_TYPE_REAL32
    )
    # Wait for confirmation
    msg = master.recv_match(type='PARAM_VALUE', blocking=True, timeout=3)
    if msg and msg.param_id.strip('\x00') == param_name:
        print(f"Set {param_name} = {msg.param_value}")
        return True
    return False

# Usage
set_param(master, 'WP_SPEED', 5.0)  # 5 m/s waypoint speed
```

### Read All Parameters

```python
def get_all_params(master):
    """Read all parameters from the vehicle."""
    master.mav.param_request_list_send(
        master.target_system,
        master.target_component
    )
    params = {}
    while True:
        msg = master.recv_match(type='PARAM_VALUE', blocking=True, timeout=5)
        if msg is None:
            break
        name = msg.param_id.strip('\x00')
        params[name] = msg.param_value
        if msg.param_index == msg.param_count - 1:
            break
    return params
```

---

## RC Override

```python
def set_rc_channel(master, channel, pwm):
    """
    Override a single RC channel.
    channel: 1-18
    pwm: 1000-2000 (microseconds), 0=release, 65535=ignore
    """
    rc_values = [65535] * 18  # ignore all channels
    rc_values[channel - 1] = pwm
    master.mav.rc_channels_override_send(
        master.target_system,
        master.target_component,
        *rc_values
    )

def release_rc_override(master):
    """Release all RC overrides."""
    rc_values = [0] * 18  # 0 = release
    master.mav.rc_channels_override_send(
        master.target_system,
        master.target_component,
        *rc_values
    )
```

---

## Requesting Message Streams

By default the autopilot may not stream all messages you need. Request them explicitly.

```python
def request_message_interval(master, message_id, frequency_hz):
    """Request a specific message at a given rate."""
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
        0,
        message_id,        # param1: message ID
        1e6 / frequency_hz,  # param2: interval in microseconds
        0, 0, 0, 0, 0
    )

# Request GPS at 5 Hz
request_message_interval(master,
    mavutil.mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, 5)

# Request attitude at 10 Hz
request_message_interval(master,
    mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE, 10)

# Request battery status at 1 Hz
request_message_interval(master,
    mavutil.mavlink.MAVLINK_MSG_ID_SYS_STATUS, 1)

# Request single message immediately
def request_message_once(master, message_id):
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_REQUEST_MESSAGE,
        0,
        message_id,
        0, 0, 0, 0, 0, 0
    )
```

---

## Mission Upload

```python
from pymavlink import mavutil, mavwp

def upload_mission(master, waypoints):
    """
    Upload a mission to the vehicle.
    waypoints: list of (lat, lon, alt) tuples in decimal degrees and meters.
    First waypoint is typically the home/launch position.
    """
    wp = mavwp.MAVWPLoader()

    # Home position (seq=0, usually current location)
    wp.add(mavutil.mavlink.MAVLink_mission_item_int_message(
        master.target_system, master.target_component,
        0,  # seq
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT,
        mavutil.mavlink.MAV_CMD_NAV_WAYPOINT,
        0, 1,  # current, autocontinue
        0, 0, 0, 0,  # params
        int(waypoints[0][0] * 1e7),  # lat
        int(waypoints[0][1] * 1e7),  # lon
        waypoints[0][2],  # alt
        mavutil.mavlink.MAV_MISSION_TYPE_MISSION
    ))

    # Add waypoints
    for i, (lat, lon, alt) in enumerate(waypoints[1:], start=1):
        wp.add(mavutil.mavlink.MAVLink_mission_item_int_message(
            master.target_system, master.target_component,
            i,  # seq
            mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT,
            mavutil.mavlink.MAV_CMD_NAV_WAYPOINT,
            0, 1,  # current=0, autocontinue=1
            0, 0, 0, 0,
            int(lat * 1e7),
            int(lon * 1e7),
            alt,
            mavutil.mavlink.MAV_MISSION_TYPE_MISSION
        ))

    # Send mission count
    master.mav.mission_count_send(
        master.target_system,
        master.target_component,
        wp.count(),
        mavutil.mavlink.MAV_MISSION_TYPE_MISSION
    )

    # Respond to mission requests
    for i in range(wp.count()):
        msg = master.recv_match(type='MISSION_REQUEST_INT', blocking=True, timeout=5)
        if msg is None:
            msg = master.recv_match(type='MISSION_REQUEST', blocking=True, timeout=5)
        if msg is None:
            print(f"Timeout waiting for request {i}")
            return False
        master.mav.send(wp.wp(msg.seq))

    # Wait for ACK
    ack = master.recv_match(type='MISSION_ACK', blocking=True, timeout=5)
    if ack and ack.type == 0:
        print(f"Mission uploaded: {wp.count()} items")
        return True
    else:
        print(f"Mission upload failed: {ack}")
        return False

# Usage
waypoints = [
    (35.3621, -149.1651, 0),    # home
    (35.3625, -149.1651, 10),   # waypoint 1
    (35.3625, -149.1655, 10),   # waypoint 2
    (35.3621, -149.1655, 10),   # waypoint 3
]
upload_mission(master, waypoints)
```

---

## Servo Control

```python
def set_servo(master, servo_number, pwm):
    """Set a servo output PWM value."""
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_DO_SET_SERVO,
        0,
        servo_number,  # param1: servo number (1-based on MAIN outputs)
        pwm,           # param2: PWM microseconds
        0, 0, 0, 0, 0
    )
```

---

## Complete Examples

### Minimal Companion Computer Script

```python
#!/usr/bin/env python3
"""
Minimal ArduPilot companion computer interface.
Connects via UART, monitors telemetry, provides GUIDED mode control.
"""

import time
import threading
from pymavlink import mavutil

# --- Connection ---
conn = mavutil.mavlink_connection('/dev/serial0', baud=921600)

# --- Heartbeat thread ---
def heartbeat_loop():
    while True:
        conn.mav.heartbeat_send(
            mavutil.mavlink.MAV_TYPE_GCS,
            mavutil.mavlink.MAV_AUTOPILOT_INVALID,
            0, 0,
            mavutil.mavlink.MAV_STATE_ACTIVE
        )
        time.sleep(1)

threading.Thread(target=heartbeat_loop, daemon=True).start()

# --- Wait for autopilot ---
print("Waiting for heartbeat...")
conn.wait_heartbeat()
print(f"Connected to system {conn.target_system}")

# --- Request telemetry streams ---
def request_stream(msg_id, hz):
    conn.mav.command_long_send(
        conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
        msg_id, 1e6/hz, 0, 0, 0, 0, 0)

request_stream(mavutil.mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, 4)
request_stream(mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE, 10)
request_stream(mavutil.mavlink.MAVLINK_MSG_ID_SYS_STATUS, 1)
request_stream(mavutil.mavlink.MAVLINK_MSG_ID_GPS_RAW_INT, 2)

# --- Telemetry loop ---
while True:
    msg = conn.recv_match(blocking=True, timeout=1.0)
    if msg is None:
        continue
    t = msg.get_type()
    if t == 'GLOBAL_POSITION_INT':
        print(f"POS: {msg.lat/1e7:.6f}, {msg.lon/1e7:.6f}, alt={msg.relative_alt/1000:.1f}m")
    elif t == 'ATTITUDE':
        print(f"ATT: R={msg.roll:.2f} P={msg.pitch:.2f} Y={msg.yaw:.2f}")
    elif t == 'SYS_STATUS':
        print(f"BAT: {msg.voltage_battery/1000:.1f}V {msg.battery_remaining}%")
    elif t == 'STATUSTEXT':
        print(f"[{msg.severity}] {msg.text}")
```

### GUIDED Mode Navigation (Copter)

```python
#!/usr/bin/env python3
"""Navigate copter to a sequence of GPS waypoints in GUIDED mode."""

import time
from pymavlink import mavutil

conn = mavutil.mavlink_connection('/dev/serial0', baud=921600)
conn.wait_heartbeat()

def set_mode(mode):
    mode_id = conn.mode_mapping()[mode]
    conn.mav.set_mode_send(conn.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode_id)
    time.sleep(1)

def arm():
    conn.mav.command_long_send(conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0,
        1, 0, 0, 0, 0, 0, 0)
    conn.motors_armed_wait()

def takeoff(alt):
    conn.mav.command_long_send(conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, 0,
        0, 0, 0, 0, 0, 0, alt)
    time.sleep(5)

def goto(lat, lon, alt):
    conn.mav.set_position_target_global_int_send(
        0, conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        0x0DF8,
        int(lat*1e7), int(lon*1e7), alt,
        0, 0, 0, 0, 0, 0, 0, 0)

# Execute
set_mode('GUIDED')
arm()
takeoff(10)
goto(35.3625, -149.1651, 10)
time.sleep(15)
set_mode('RTL')
```

### GUIDED Mode Navigation (Rover)

```python
#!/usr/bin/env python3
"""Drive rover to a GPS waypoint in GUIDED mode."""

import time
from pymavlink import mavutil

conn = mavutil.mavlink_connection('/dev/serial0', baud=921600)
conn.wait_heartbeat()

# Set GUIDED mode
mode_id = conn.mode_mapping()['GUIDED']
conn.mav.set_mode_send(conn.target_system,
    mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode_id)
time.sleep(1)

# Arm
conn.mav.command_long_send(conn.target_system, conn.target_component,
    mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0,
    1, 0, 0, 0, 0, 0, 0)
conn.motors_armed_wait()

# Drive to GPS coordinate
conn.mav.set_position_target_global_int_send(
    0, conn.target_system, conn.target_component,
    mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
    0x0DF8,
    int(35.3625 * 1e7), int(-149.1651 * 1e7), 0,
    0, 0, 0, 0, 0, 0, 0, 0)

# Monitor progress
while True:
    msg = conn.recv_match(type='GLOBAL_POSITION_INT', blocking=True, timeout=2)
    if msg:
        print(f"Position: {msg.lat/1e7:.6f}, {msg.lon/1e7:.6f}")
    time.sleep(1)
```

---

## Important Notes

- **Heartbeat requirement:** Both the companion computer and the autopilot must send heartbeats at >= 1 Hz. Without heartbeats, the connection will be considered lost.
- **Velocity command timeout:** Velocity/acceleration commands expire after 3 seconds if not re-sent.
- **Thread safety:** pymavlink is NOT thread-safe. Use a single thread for all mavlink I/O or protect with locks.
- **MAVLink routing:** If running alongside MAVProxy or mavlink-router, use separate UDP ports. Don't share a serial port between multiple programs.
- **System IDs:** The companion computer should use a unique system ID (e.g., 255) different from the autopilot (typically 1).
- **ArduPilot dialect:** For full ArduPilot message support, use the `ardupilotmega` dialect (default when connecting to ArduPilot).
