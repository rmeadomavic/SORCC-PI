# MAVLink Common Messages Reference

Reference for key MAVLink messages used when controlling ArduPilot vehicles (Copter, Rover) from a Raspberry Pi companion computer.

Source: [MAVLink Common Messages](https://mavlink.io/en/messages/common.html)

---

## Table of Contents

1. [HEARTBEAT](#1-heartbeat)
2. [COMMAND_LONG](#2-command_long)
3. [COMMAND_ACK](#3-command_ack)
4. [SET_MODE](#4-set_mode)
5. [SET_POSITION_TARGET_LOCAL_NED](#5-set_position_target_local_ned)
6. [SET_POSITION_TARGET_GLOBAL_INT](#6-set_position_target_global_int)
7. [SET_ATTITUDE_TARGET](#7-set_attitude_target)
8. [Mission Protocol Messages](#8-mission-protocol-messages)
9. [Position Telemetry](#9-position-telemetry)
10. [Attitude and Flight Data](#10-attitude-and-flight-data)
11. [Parameter Protocol](#11-parameter-protocol)
12. [RC_CHANNELS_OVERRIDE](#12-rc_channels_override)
13. [STATUSTEXT](#13-statustext)
14. [Guided Mode Commands (Copter)](#14-guided-mode-commands-copter)
15. [Guided Mode Commands (Rover)](#15-guided-mode-commands-rover)
16. [Key MAV_CMD Values](#16-key-mav_cmd-values)

---

## 1. HEARTBEAT

**Message ID: 0**

Announces system presence and status. Must be sent at least 1 Hz by all MAVLink systems. The companion computer should send heartbeats and monitor the autopilot's heartbeats for connection health.

| Field | Type | Description |
|-------|------|-------------|
| type | uint8_t | Vehicle type (MAV_TYPE enum) |
| autopilot | uint8_t | Autopilot type (MAV_AUTOPILOT enum) |
| base_mode | uint8_t | System mode bitmap (MAV_MODE_FLAG) |
| custom_mode | uint32_t | Autopilot-specific mode (ArduPilot flight mode number) |
| system_status | uint8_t | System health state (MAV_STATE enum) |
| mavlink_version | uint8_t | Protocol version (3 for current) |

**Key MAV_TYPE values for SORCC:**
- 1 = MAV_TYPE_FIXED_WING
- 2 = MAV_TYPE_QUADROTOR
- 10 = MAV_TYPE_GROUND_ROVER
- 6 = MAV_TYPE_GCS (for companion computer heartbeats)

---

## 2. COMMAND_LONG

**Message ID: 76**

Sends a command with up to 7 float parameters. This is the primary way to send commands like arm/disarm, mode changes, takeoff, etc.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | Destination system ID |
| target_component | uint8_t | Destination component (0 = all) |
| command | uint16_t | MAV_CMD command identifier |
| confirmation | uint8_t | 0 for first attempt, increment for retries |
| param1 | float | Command-specific |
| param2 | float | Command-specific |
| param3 | float | Command-specific |
| param4 | float | Command-specific |
| param5 | float | Command-specific |
| param6 | float | Command-specific |
| param7 | float | Command-specific |

Unused parameters should be set to 0 or NaN.

---

## 3. COMMAND_ACK

**Message ID: 77**

Response to a COMMAND_LONG. Always check this to confirm command execution.

| Field | Type | Description |
|-------|------|-------------|
| command | uint16_t | The MAV_CMD that was processed |
| result | uint8_t | MAV_RESULT enum (0=ACCEPTED, 1=TEMPORARILY_REJECTED, etc.) |
| progress | uint8_t | Completion percentage (255 = unknown) |
| result_param2 | int32_t | Additional error info |
| target_system | uint8_t | System that sent the command |
| target_component | uint8_t | Component that sent the command |

**MAV_RESULT values:**
- 0 = MAV_RESULT_ACCEPTED
- 1 = MAV_RESULT_TEMPORARILY_REJECTED
- 2 = MAV_RESULT_DENIED
- 3 = MAV_RESULT_UNSUPPORTED
- 4 = MAV_RESULT_FAILED
- 5 = MAV_RESULT_IN_PROGRESS

---

## 4. SET_MODE

**Message ID: 11** (deprecated in favor of MAV_CMD_DO_SET_MODE via COMMAND_LONG, but still widely used)

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System to change mode |
| base_mode | uint8_t | MAV_MODE_FLAG_CUSTOM_MODE_ENABLED (1) |
| custom_mode | uint32_t | ArduPilot flight mode number |

**ArduCopter mode numbers:**
- 0 = STABILIZE
- 2 = ALT_HOLD
- 3 = AUTO
- 4 = GUIDED
- 5 = LOITER
- 6 = RTL
- 9 = LAND
- 16 = POSHOLD
- 20 = GUIDED_NOGPS

**ArduRover mode numbers:**
- 0 = MANUAL
- 3 = STEERING
- 4 = HOLD
- 10 = AUTO
- 15 = GUIDED
- 11 = RTL
- 12 = SMART_RTL

---

## 5. SET_POSITION_TARGET_LOCAL_NED

**Message ID: 84**

Command position, velocity, or acceleration in local NED (North-East-Down) frame. Used in GUIDED mode.

| Field | Type | Description |
|-------|------|-------------|
| time_boot_ms | uint32_t | Timestamp since boot (ms) |
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| coordinate_frame | uint8_t | MAV_FRAME reference |
| type_mask | uint16_t | Bitmask: 1 = ignore field |
| x, y, z | float | Position in meters (NED: +N, +E, +Down) |
| vx, vy, vz | float | Velocity in m/s |
| afx, afy, afz | float | Acceleration in m/s^2 |
| yaw | float | Heading in radians (0 = North, CW positive) |
| yaw_rate | float | Yaw rate in rad/s |

### Coordinate Frames

| Frame | Value | Description |
|-------|-------|-------------|
| MAV_FRAME_LOCAL_NED | 1 | Relative to EKF origin |
| MAV_FRAME_LOCAL_OFFSET_NED | 7 | Relative to current position |
| MAV_FRAME_BODY_NED | 8 | Position in NED, velocity relative to heading |
| MAV_FRAME_BODY_OFFSET_NED | 9 | Everything relative to current position/heading |

### Type Mask Values (common combinations)

| Use Case | type_mask | Decimal |
|----------|-----------|---------|
| Position only | 0x0DF8 | 3576 |
| Velocity only | 0x0DC7 | 3527 |
| Acceleration only | 0x0C3F | 3135 |
| Position + Velocity | 0x0DC0 | 3520 |
| Position + Velocity + Accel | 0x0C00 | 3072 |
| Yaw only | 0x09FF | 2559 |
| Yaw rate only | 0x05FF | 1535 |

**Bitmask breakdown:** bit0=PosX, bit1=PosY, bit2=PosZ, bit3=VelX, bit4=VelY, bit5=VelZ, bit6=AccX, bit7=AccY, bit8=AccZ, bit10=Yaw, bit11=YawRate. Set bit to 1 to IGNORE that field.

**Important:** Velocity and acceleration commands must be re-sent every second. The vehicle will stop after 3 seconds if no command is received.

---

## 6. SET_POSITION_TARGET_GLOBAL_INT

**Message ID: 86**

Command position using GPS coordinates (WGS84). Most common for waypoint-style navigation in GUIDED mode.

| Field | Type | Description |
|-------|------|-------------|
| time_boot_ms | uint32_t | Timestamp (ms) |
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| coordinate_frame | uint8_t | MAV_FRAME |
| type_mask | uint16_t | Bitmask (same as LOCAL_NED) |
| lat_int | int32_t | Latitude in degrees * 1e7 |
| lon_int | int32_t | Longitude in degrees * 1e7 |
| alt | float | Altitude in meters (meaning depends on frame) |
| vx, vy, vz | float | Velocity (m/s, NED) |
| afx, afy, afz | float | Acceleration (m/s^2) |
| yaw | float | Heading in radians |
| yaw_rate | float | Yaw rate in rad/s |

### Coordinate Frames

| Frame | Value | Altitude Reference |
|-------|-------|--------------------|
| MAV_FRAME_GLOBAL | 0 | Above sea level (AMSL) |
| MAV_FRAME_GLOBAL_INT | 5 | Above sea level (AMSL) |
| MAV_FRAME_GLOBAL_RELATIVE_ALT | 3 | Above home position |
| MAV_FRAME_GLOBAL_RELATIVE_ALT_INT | 6 | Above home position |
| MAV_FRAME_GLOBAL_TERRAIN_ALT | 10 | Above terrain |
| MAV_FRAME_GLOBAL_TERRAIN_ALT_INT | 11 | Above terrain |

### Type Mask Values

Same as SET_POSITION_TARGET_LOCAL_NED (see above).

**Latitude/Longitude encoding:** Multiply decimal degrees by 1e7 and cast to int32.
Example: 35.362147 S, 149.165175 E -> lat_int=-353621470, lon_int=1491651750

---

## 7. SET_ATTITUDE_TARGET

**Message ID: 82**

Direct attitude and thrust control. Accepted in GUIDED and GUIDED_NOGPS modes (Copter). GUIDED_NOGPS is the ONLY mode that accepts this as the sole control input.

| Field | Type | Description |
|-------|------|-------------|
| time_boot_ms | uint32_t | Timestamp (ms) |
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| type_mask | uint8_t | Should be 0x07 (7) to use quaternion + thrust |
| q | float[4] | Attitude quaternion [w, x, y, z]. {1,0,0,0} = level |
| body_roll_rate | float | Not currently supported in ArduPilot |
| body_pitch_rate | float | Not currently supported in ArduPilot |
| body_yaw_rate | float | Not currently supported in ArduPilot |
| thrust | float | 0.5 = hover (climb rate mode) or throttle 0-1 (depends on GUID_OPTIONS) |

---

## 8. Mission Protocol Messages

### MISSION_COUNT (ID: 44)
Initiates a mission upload by telling the vehicle how many items to expect.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| count | uint16_t | Number of mission items |
| mission_type | uint8_t | 0=mission, 1=fence, 2=rally |

### MISSION_ITEM_INT (ID: 73)
Defines a single mission waypoint using integer lat/lon.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| seq | uint16_t | Waypoint sequence number (0-indexed) |
| frame | uint8_t | Coordinate frame (MAV_FRAME) |
| command | uint16_t | MAV_CMD (16=WAYPOINT, 22=TAKEOFF, 21=LAND, etc.) |
| current | uint8_t | 1 if this is the active waypoint |
| autocontinue | uint8_t | 1 to auto-advance to next waypoint |
| param1-param4 | float | Command-specific parameters |
| x | int32_t | Latitude * 1e7 |
| y | int32_t | Longitude * 1e7 |
| z | float | Altitude (meters) |
| mission_type | uint8_t | 0=mission, 1=fence, 2=rally |

### MISSION_REQUEST_INT (ID: 51)
Vehicle requests a specific mission item during upload.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| seq | uint16_t | Item index to send |
| mission_type | uint8_t | Mission type |

### MISSION_ACK (ID: 47)
Confirms mission upload/download completion.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| type | uint8_t | MAV_MISSION_RESULT (0=accepted) |
| mission_type | uint8_t | Mission type |

### MISSION_REQUEST_LIST (ID: 43)
Request the vehicle to send its mission item count.

### MISSION_CURRENT (ID: 42)
Vehicle broadcasts the currently active waypoint index.

### Mission Upload Protocol Flow

```
Companion          Autopilot
   |                  |
   |--MISSION_COUNT-->|
   |                  |
   |<-MISSION_REQUEST_INT(0)--|
   |--MISSION_ITEM_INT(0)-->|
   |                  |
   |<-MISSION_REQUEST_INT(1)--|
   |--MISSION_ITEM_INT(1)-->|
   |    ...           |
   |<--MISSION_ACK----|
```

---

## 9. Position Telemetry

### GPS_RAW_INT (ID: 24)

Raw GPS sensor output.

| Field | Type | Description |
|-------|------|-------------|
| time_usec | uint64_t | Timestamp (microseconds) |
| fix_type | uint8_t | 0=no fix, 1=no fix, 2=2D, 3=3D, 4=DGPS, 5=RTK float, 6=RTK fixed |
| lat | int32_t | Latitude (degrees * 1e7) |
| lon | int32_t | Longitude (degrees * 1e7) |
| alt | int32_t | Altitude MSL (millimeters) |
| eph | uint16_t | Horizontal dilution * 100 |
| epv | uint16_t | Vertical dilution * 100 |
| vel | uint16_t | Ground speed (cm/s) |
| cog | uint16_t | Course over ground (centidegrees, 0-35999) |
| satellites_visible | uint8_t | Number of visible satellites |

### GLOBAL_POSITION_INT (ID: 33)

Filtered/fused position estimate (EKF output). More useful than GPS_RAW_INT for navigation.

| Field | Type | Description |
|-------|------|-------------|
| time_boot_ms | uint32_t | Timestamp (ms since boot) |
| lat | int32_t | Latitude (degrees * 1e7) |
| lon | int32_t | Longitude (degrees * 1e7) |
| alt | int32_t | Altitude MSL (millimeters) |
| relative_alt | int32_t | Altitude above home (millimeters) |
| vx | int16_t | Ground speed X (North) in cm/s |
| vy | int16_t | Ground speed Y (East) in cm/s |
| vz | int16_t | Ground speed Z (Down) in cm/s |
| hdg | uint16_t | Heading (0-35999 centidegrees, UINT16_MAX if unknown) |

---

## 10. Attitude and Flight Data

### ATTITUDE (ID: 30)

| Field | Type | Description |
|-------|------|-------------|
| time_boot_ms | uint32_t | Timestamp (ms) |
| roll | float | Roll angle (radians, -pi to +pi) |
| pitch | float | Pitch angle (radians) |
| yaw | float | Yaw angle (radians) |
| rollspeed | float | Roll rate (rad/s) |
| pitchspeed | float | Pitch rate (rad/s) |
| yawspeed | float | Yaw rate (rad/s) |

### VFR_HUD (ID: 74)

| Field | Type | Description |
|-------|------|-------------|
| airspeed | float | Indicated airspeed (m/s) |
| groundspeed | float | Ground speed (m/s) |
| heading | int16_t | Compass heading (0-360 degrees) |
| throttle | uint16_t | Throttle (0-100%) |
| alt | float | MSL altitude (meters) |
| climb | float | Climb rate (m/s) |

### SYS_STATUS (ID: 1)

| Field | Type | Description |
|-------|------|-------------|
| voltage_battery | uint16_t | Battery voltage (millivolts) |
| current_battery | int16_t | Battery current (10mA units) |
| battery_remaining | int8_t | Remaining capacity (0-100%) |

---

## 11. Parameter Protocol

### PARAM_SET (ID: 23)

Write a parameter value.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| param_id | char[16] | Parameter name (null-terminated) |
| param_value | float | New value |
| param_type | uint8_t | MAV_PARAM_TYPE (9=REAL32 for most ArduPilot params) |

### PARAM_VALUE (ID: 22)

Response to PARAM_SET or PARAM_REQUEST_READ.

| Field | Type | Description |
|-------|------|-------------|
| param_id | char[16] | Parameter name |
| param_value | float | Current value |
| param_type | uint8_t | Data type |
| param_count | uint16_t | Total number of parameters |
| param_index | uint16_t | Index of this parameter |

### PARAM_REQUEST_READ (ID: 20)

Request a single parameter by name or index.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| param_id | char[16] | Parameter name (or empty if using index) |
| param_index | int16_t | Parameter index (-1 to use param_id) |

---

## 12. RC_CHANNELS_OVERRIDE

**Message ID: 70**

Override RC input from a companion computer. Used for software-controlled RC channels.

| Field | Type | Description |
|-------|------|-------------|
| target_system | uint8_t | System ID |
| target_component | uint8_t | Component ID |
| chan1_raw - chan18_raw | uint16_t | PWM values in microseconds |

**PWM values:**
- 1000 = minimum (0%)
- 1500 = center
- 2000 = maximum (100%)
- 65535 (UINT16_MAX) = ignore this channel (no override)
- 0 = release override, return to RC radio

---

## 13. STATUSTEXT

**Message ID: 253**

Text messages from the autopilot (errors, warnings, info).

| Field | Type | Description |
|-------|------|-------------|
| severity | uint8_t | MAV_SEVERITY (0=EMERGENCY, 4=WARNING, 6=INFO) |
| text | char[50] | Status message text |
| id | uint16_t | Unique ID for multi-chunk messages |
| chunk_seq | uint8_t | Chunk sequence number |

---

## 14. Guided Mode Commands (Copter)

When in GUIDED mode, ArduCopter accepts these messages:

### Position Control
- **SET_POSITION_TARGET_GLOBAL_INT** — fly to GPS coordinates
- **SET_POSITION_TARGET_LOCAL_NED** — fly to local position

### Velocity Control
- Use SET_POSITION_TARGET_LOCAL_NED with velocity fields and type_mask=0x0DC7
- Must re-send every second (vehicle stops after 3s timeout)

### Attitude Control
- **SET_ATTITUDE_TARGET** — direct quaternion + thrust (also works in GUIDED_NOGPS)

### Key COMMAND_LONG commands in GUIDED mode
- **MAV_CMD_NAV_TAKEOFF** — initiate takeoff
- **MAV_CMD_NAV_LAND** — switch to Land mode
- **MAV_CMD_NAV_RETURN_TO_LAUNCH** — switch to RTL mode
- **MAV_CMD_NAV_LOITER_UNLIM** — switch to Loiter mode
- **MAV_CMD_CONDITION_YAW** — change heading
- **MAV_CMD_DO_CHANGE_SPEED** — modify speed

---

## 15. Guided Mode Commands (Rover)

When in GUIDED mode, ArduRover accepts:

- **SET_POSITION_TARGET_GLOBAL_INT** — drive to GPS coordinates
- **SET_POSITION_TARGET_LOCAL_NED** — drive to local position
- **SET_ATTITUDE_TARGET** — direct steering/throttle control

Speed is governed by **WP_SPEED** parameter.

---

## 16. Key MAV_CMD Values

Used with COMMAND_LONG (msg ID 76):

| Command | ID | Parameters | Description |
|---------|----|------------|-------------|
| MAV_CMD_NAV_WAYPOINT | 16 | p1=hold_time, p5=lat, p6=lon, p7=alt | Navigate to waypoint |
| MAV_CMD_NAV_TAKEOFF | 22 | p7=altitude | Takeoff to altitude |
| MAV_CMD_NAV_LAND | 21 | p5=lat, p6=lon | Land at location |
| MAV_CMD_NAV_RETURN_TO_LAUNCH | 20 | — | Return to launch |
| MAV_CMD_DO_SET_MODE | 176 | p1=base_mode, p2=custom_mode | Change flight mode |
| MAV_CMD_DO_CHANGE_SPEED | 178 | p1=speed_type, p2=speed, p3=throttle | Change speed |
| MAV_CMD_COMPONENT_ARM_DISARM | 400 | p1=1(arm)/0(disarm), p2=21196(force) | Arm or disarm motors |
| MAV_CMD_CONDITION_YAW | 115 | p1=angle, p2=rate, p3=dir, p4=rel/abs | Change yaw heading |
| MAV_CMD_DO_SET_SERVO | 183 | p1=servo_num, p2=PWM | Set servo output |
| MAV_CMD_DO_SET_ROI | 201 | p5=lat, p6=lon, p7=alt | Point camera at location |
| MAV_CMD_SET_MESSAGE_INTERVAL | 511 | p1=msg_id, p2=interval_us | Request message at rate |
| MAV_CMD_REQUEST_MESSAGE | 512 | p1=msg_id | Request single message |
| MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN | 246 | p1=1 | Reboot autopilot |
| MAV_CMD_DO_FLIGHTTERMINATION | 185 | p1=1 | Emergency motor kill |

---

## Implementation Notes

- All MAVLink systems must send HEARTBEAT at >= 1 Hz
- Integer coordinates use scaling: lat/lon * 1e7, local positions in meters
- Float fields use NaN to indicate unset/default values
- Companion computers should use target_system=1, target_component=1 (typical autopilot IDs)
- Velocity/acceleration commands timeout after 3 seconds without update
- Always wait for COMMAND_ACK after sending COMMAND_LONG
- ArduPilot custom_mode numbers differ between Copter, Rover, and Plane
