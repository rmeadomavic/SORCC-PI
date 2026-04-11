# Kismet REST API Reference

> Offline reference for Argus payload integration.
> Compiled from kismetwireless.net official docs + supplemental knowledge.

Kismet uses a REST-like interface on its embedded webserver (default port **2501**).
All endpoints support JSON serialization (`.json`, `.ekjson` for line-delimited, `.prettyjson` for human-readable).

## Authentication

- Since 2019-04-git, most endpoints require login.
- **HTTP Basic Auth** or session cookie (`KISMET` cookie / API token).
- API keys configured in `~/.kismet/kismet_httpd.conf`:
  ```
  httpd_auth=user:password
  ```
- Roles: `readonly`, `admin`, `datasource`, `scanreport`, `WEBGPS`.
- Public (no login): `/system/user_status`, `/session/check_login`, `/session/check_session`, `/session/check_setup_ok`.

### Session Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/session/check_session` | GET | Validate current session |
| `/session/check_login` | GET | Validate credentials |
| `/session/check_setup_ok` | GET | Check if initial setup is complete |

---

## Field Simplification

POST a `fields` array to reduce payload size:

```json
{
  "fields": [
    "kismet.device.base.macaddr",
    "kismet.device.base.signal/kismet.common.signal.last_signal",
    ["kismet.device.base.name", "device_name"]
  ]
}
```

- Simple field path: `"kismet.device.base.macaddr"`
- Renamed field: `["original.path", "short_name"]`
- Sub-path: `"parent/child.field"`

## Regex Filters

POST a `regex` array (requires PCRE support compiled in):

```json
{
  "regex": [
    ["kismet.device.base.macaddr", "^AA:BB:CC.*"],
    ["kismet.device.base.name", "MyNetwork"]
  ]
}
```

## Timestamps

- Absolute: UNIX epoch seconds (e.g., `1605736428`)
- Relative: Negative seconds from now (e.g., `-60` for last minute)
- Microsecond precision supported where noted (e.g., `1234567.12345`)

---

## Devices API

### Recently Active Devices

| | |
|---|---|
| **URI** | `/devices/last-time/{TIMESTAMP}/devices.json` |
| **Methods** | GET, POST |
| **Role** | `readonly` |
| **Params** | `TIMESTAMP` (required), `fields` (optional), `regex` (optional) |

### Device by Key

| | |
|---|---|
| **URI** | `/devices/by-key/{DEVICEKEY}/device.json` |
| **Methods** | GET, POST |
| **Role** | `readonly` |
| **Params** | `DEVICEKEY` (required), `fields` (optional) |
| **Errors** | 404 if not found |

### Devices by MAC Address

| | |
|---|---|
| **URI** | `/devices/by-mac/{MACADDRESS}/devices.json` |
| **Methods** | GET, POST |
| **Role** | `readonly` |
| **Returns** | Array (even for single match) |

### Multiple Devices by MAC

| | |
|---|---|
| **URI** | `/devices/multimac/devices.json` |
| **Method** | POST |
| **Role** | `readonly` |
| **Body** | `{"devices": ["AA:BB:CC:DD:EE:FF", "11:22:33:00:00:00/FF:FF:FF:00:00:00"], "fields": [...]}` |

### Multiple Devices by Key (List)

| | |
|---|---|
| **URI** | `/devices/multikey/devices.json` |
| **Method** | POST |
| **Body** | `{"devices": ["key1", "key2"], "fields": [...]}` |

### Multiple Devices by Key (Dictionary)

| | |
|---|---|
| **URI** | `/devices/multikey/as-object/devices.json` |
| **Method** | POST |
| **Returns** | Dictionary keyed by device key |

### Edit Device Tags

| | |
|---|---|
| **URI** | `/devices/by-key/{DEVICEKEY}/set_tag.cmd` |
| **Method** | POST |
| **Role** | `admin` |
| **Body** | `{"tagname": "...", "tagvalue": "..."}` |

---

## Device Views API

### List All Views

| | |
|---|---|
| **URI** | `/devices/views/all_views.json` |
| **Method** | GET |
| **Role** | `readonly` |

### Devices by View (Paginated)

| | |
|---|---|
| **URI** | `/devices/views/{VIEWID}/devices.json` |
| **Method** | POST |
| **Role** | `readonly` |
| **Params** | `fields`, `regex`, jQuery DataTables params (`start`, `length`, `draw`, `search[value]`, `order[0][column]`, `order[0][dir]`), `colmap`, `datatable` |

### Devices by View and Time

| | |
|---|---|
| **URI** | `/devices/views/{VIEWID}/last-time/{TIMESTAMP}/devices.json` |
| **Methods** | GET, POST |

### View-Specific Device Monitor (WebSocket)

| | |
|---|---|
| **URI** | `/devices/views/{VIEWID}/monitor.ws` |
| **Method** | WEBSOCKET UPGRADE |
| **Subscribe** | `{"monitor": "*", "request": 1, "rate": 5, "fields": [...]}` |
| **Unsubscribe** | `{"cancel": 1}` |

### Built-in Views

| View ID | Description |
|---------|-------------|
| `all` | All devices |
| `seenby-{UUID}` | Devices seen by a specific datasource |
| `phy/{PHYNAME}` | Devices filtered by PHY type |
| `phydot11_accesspoints` | WiFi access points only |

---

## Device Presence Alerts

### View Monitored MACs

| | |
|---|---|
| **URI** | `/devices/alerts/mac/{TYPE}/macs.json` |
| **Method** | GET |
| **TYPE** | `found`, `lost`, or `both` |

### Add/Remove Monitored MACs

| | |
|---|---|
| **URI** | `/devices/alerts/mac/{TYPE}/{ACTION}.cmd` |
| **Method** | POST |
| **TYPE** | `found`, `lost`, or `both` |
| **ACTION** | `add` or `remove` |
| **Body** | `{"mac": "AA:BB:CC:DD:EE:FF"}` or `{"macs": ["AA:BB:...", "11:22:..."]}` |

---

## Device Monitor WebSocket

| | |
|---|---|
| **URI** | `/devices/monitor.ws` |
| **Method** | WEBSOCKET UPGRADE |
| **Auth** | `user`/`password` or `KISMET` token as query params |

### Subscribe

```json
{
  "monitor": "AA:BB:CC:DD:EE:FF",
  "request": 1,
  "rate": 5,
  "fields": [
    "kismet.device.base.key",
    "kismet.device.base.last_time",
    "kismet.common.signal.last_signal"
  ]
}
```

- `monitor`: Device MAC, key, group `MAC/MASK`, or `*` for all
- `request`: Unique subscription ID (integer)
- `rate`: Update interval in seconds
- `fields`: Optional field simplification

### Unsubscribe

```json
{"cancel": 1}
```

---

## GPS API

### List GPS Drivers

| | |
|---|---|
| **URI** | `/gps/drivers.json` |
| **Method** | GET |
| **Role** | `readonly` |

### List All GPS Devices

| | |
|---|---|
| **URI** | `/gps/all_gps.json` |
| **Method** | GET |
| **Role** | `readonly` |

### Add GPS Device

| | |
|---|---|
| **URI** | `/gps/add_gps.cmd` |
| **Method** | POST |
| **Role** | `admin` |
| **Body** | `{"definition": "gpsd:host=localhost,port=2947"}` |

### Remove GPS Device

| | |
|---|---|
| **URI** | `/gps/by-uuid/{UUID}/remove_gps.cmd` |
| **Method** | POST |
| **Role** | `admin` |

### Current Best Location

| | |
|---|---|
| **URI** | `/gps/location.json` |
| **Methods** | GET, POST |
| **Role** | `readonly` |
| **Returns** | Best fix from all enabled GPS devices |

### All GPS Locations

| | |
|---|---|
| **URI** | `/gps/all_locations.json` |
| **Methods** | GET, POST |

### Per-Receiver Location

| | |
|---|---|
| **URI** | `/gps/by-uuid/{UUID}/location.json` |
| **Methods** | GET, POST |

### Web GPS (HTTP Push)

| | |
|---|---|
| **URI** | `/gps/web/update.cmd` |
| **Method** | POST |
| **Role** | `admin` or `WEBGPS` |
| **Params** | `lat`, `lon`, `alt` (meters), `spd` (km/h) |

### Web GPS (WebSocket)

| | |
|---|---|
| **URI** | `/gps/web/update.ws` |
| **Method** | WEBSOCKET UPGRADE |
| **Payload** | `{"lat": 0.0, "lon": 0.0, "alt": 0.0, "spd": 0.0}` |

### Meta GPS (Named)

| | |
|---|---|
| **URI** | `/gps/meta/{NAME}/update.cmd` |
| **Method** | POST |
| **WebSocket** | `/gps/meta/{NAME}/update.ws` |

---

## Datasources API

### List Datasource Types

| | |
|---|---|
| **URI** | `/datasource/types.json` |
| **Method** | GET |
| **Role** | `readonly` |

### Datasource Defaults

| | |
|---|---|
| **URI** | `/datasource/defaults.json` |
| **Method** | GET |
| **Returns** | Default hopping behavior, speeds from kismet.conf |

### List All Datasources

| | |
|---|---|
| **URI** | `/datasource/all_sources.json` |
| **Method** | GET |
| **Role** | `readonly` |
| **Returns** | State, driver info, configuration, packet counts |

### Datasource Details

| | |
|---|---|
| **URI** | `/datasource/by-uuid/{UUID}/source.json` |
| **Method** | GET |

### Add Datasource

| | |
|---|---|
| **URI** | `/datasource/add_source.cmd` |
| **Method** | POST |
| **Role** | `admin` |
| **Body** | `{"definition": "wlan0:name=MyWifi,channel_hop=true"}` |

### Set Channel

| | |
|---|---|
| **URI** | `/datasource/by-uuid/{UUID}/set_channel.cmd` |
| **Method** | POST |
| **Role** | `admin` |
| **Body** | `{"channel": "6"}` or `{"channels": ["1","6","11"], "rate": 5, "shuffle": 1}` |

### Enable Channel Hopping

| | |
|---|---|
| **URI** | `/datasource/by-uuid/{UUID}/set_hop.cmd` |
| **Method** | POST |

### Close / Open / Pause / Resume Source

| Action | URI |
|--------|-----|
| Close | `/datasource/by-uuid/{UUID}/close_source.cmd` |
| Reopen | `/datasource/by-uuid/{UUID}/open_source.cmd` |
| Pause | `/datasource/by-uuid/{UUID}/pause_source.cmd` |
| Resume | `/datasource/by-uuid/{UUID}/resume_source.cmd` |

All: POST, `admin` role.

### List Available Interfaces

| | |
|---|---|
| **URI** | `/datasource/list_interfaces.json` |
| **Method** | GET |
| **Role** | `admin` |

### Remote Capture WebSocket

| | |
|---|---|
| **URI** | `/datasource/remote/remotesource.ws` |
| **Method** | WEBSOCKET UPGRADE |
| **Role** | `datasource` |

---

## Alerts API

### Alert Definitions

| | |
|---|---|
| **URI** | `/alerts/definitions.json` |
| **Method** | GET |
| **Role** | `readonly` |
| **Returns** | Alert types, severity levels, rate limiting config |

### All Stored Alerts

| | |
|---|---|
| **URI** | `/alerts/all_alerts.json` |
| **Method** | GET |
| **Returns** | Last N alerts (default 50, configured in `kismet_memory.conf`) |

### Alerts Since Timestamp

| | |
|---|---|
| **URI** | `/alerts/last-time/{TIMESTAMP}/alerts.json` |
| **Method** | GET |
| **TIMESTAMP** | UNIX epoch with microsecond precision (e.g., `1234567.12345`) |

### Alerts Since Timestamp (Wrapped)

| | |
|---|---|
| **URI** | `/alerts/wrapped/last-time/{TIMESTAMP}/alerts.json` |
| **Method** | GET |
| **Returns** | JSON object with alerts list + server-side timestamp for polling |

---

## System Status API

### System Status

| | |
|---|---|
| **URI** | `/system/status.json` |
| **Methods** | GET, POST |
| **Role** | `readonly` |
| **Returns** | Load metrics, health, thermal/fan sensors, memory, battery, runtime stats |

### System Timestamp

| | |
|---|---|
| **URI** | `/system/timestamp.json` |
| **Method** | GET |
| **Returns** | Current time in seconds + microseconds (for UI sync / keep-alive) |

### Tracked Fields Reference

| | |
|---|---|
| **URI** | `/system/tracked_fields.html` |
| **Method** | GET |
| **Returns** | HTML doc of all field names, types, descriptions |

### Packet Statistics

| | |
|---|---|
| **URI** | `/packetchain/packet_stats.json` |
| **Methods** | GET, POST |
| **Returns** | RRD-format packet rates, processing speeds, data volume, history |

---

## Channels API

### Channel Summary

| | |
|---|---|
| **URI** | `/channels/channels.json` |
| **Method** | GET |
| **Role** | `readonly` |
| **Returns** | Channels with observed traffic, device counts, coverage info |

---

## Messages API

### All Messages

| | |
|---|---|
| **URI** | `/messagebus/all_messages.json` |
| **Method** | GET |
| **Returns** | Last 50 messages from internal message bus |

### Messages Since Timestamp

| | |
|---|---|
| **URI** | `/messagebus/last-time/{TIMESTAMP}/messages.json` |
| **Method** | GET |

---

## Packet Capture API (Live Streaming)

All return PCAP-NG format, stream indefinitely until disconnected.

| Scope | URI | Params |
|-------|-----|--------|
| All packets | `/pcap/all_packets.pcapng` | None |
| By datasource | `/datasource/pcap/by-uuid/{UUID}/packets.pcapng` | UUID |
| By device | `/devices/pcap/by-key/{KEY}/packets.pcapng` | Device key |

---

## Packet Filter API

### Filter Status

| | |
|---|---|
| **URI** | `/filters/packet/{FILTERID}/filter.json` |
| **Methods** | GET, POST |

### Set Default Filter Behavior

| | |
|---|---|
| **URI** | `/filters/packet/{FILTERID}/set_default.cmd` |
| **Method** | POST |
| **Body** | `{"default": "reject"}` or `{"default": "allow"}` |

### Add MAC Filter

| | |
|---|---|
| **URI** | `/filters/packet/{FILTERID}/{PHYNAME}/{BLOCKNAME}/set_filter.cmd` |
| **Method** | POST |
| **BLOCKNAME** | `source`, `destination`, `network`, `other`, or `any` |
| **Body** | `{"filter": {"AA:BB:CC:DD:EE:FF": true, "11:22:33:00:00:00/FF:FF:FF:00:00:00": true}}` |

`true` = block, `false` = allow.

### Remove MAC Filter

| | |
|---|---|
| **URI** | `/filters/{FILTERID}/{PHYNAME}/{BLOCKNAME}/remove_filter.json` |
| **Method** | POST |
| **Body** | `{"addresses": ["AA:BB:CC:DD:EE:FF"]}` |

---

## Logging API

### List Log Drivers

| | |
|---|---|
| **URI** | `/logging/drivers.json` |
| **Method** | GET |

### List Active Logs

| | |
|---|---|
| **URI** | `/logging/active.json` |
| **Method** | GET |

### Start a Log

| | |
|---|---|
| **URI** | `/logging/by-class/{LOGCLASS}/start.cmd` |
| **Methods** | GET, POST |
| **Body** | `{"title": "optional_filename"}` |

### Stop a Log

| | |
|---|---|
| **URI** | `/logging/by-uuid/{UUID}/stop.cmd` |
| **Method** | GET |

---

## KismetDB API (Historical Packet Query)

### Query Historical Packets

| | |
|---|---|
| **URI** | `/logging/kismetdb/pcap/{TITLE}.pcapng` |
| **Methods** | GET, POST |
| **Returns** | PCAP-NG stream matching filters |

**Filter parameters** (all optional, AND logic):

| Parameter | Description |
|-----------|-------------|
| `timestamp_start` | Start time (POSIX with microseconds) |
| `timestamp_end` | End time |
| `datasource` | Datasource UUID |
| `device_id` | Kismet device key |
| `dlt` | PCAP DLT value |
| `frequency` | Exact frequency in KHz |
| `frequency_min` / `frequency_max` | Frequency range |
| `signal_min` / `signal_max` | Signal level range |
| `address_source` | Source MAC |
| `address_dest` | Destination MAC |
| `address_trans` | Transmitter MAC |
| `location_lat_min` / `location_lat_max` | Latitude bounds |
| `location_lon_min` / `location_lon_max` | Longitude bounds |
| `size_min` / `size_max` | Packet size range (bytes) |
| `tag` | Packet tag match |
| `limit` | Max packets returned |

### Delete Historical Packets

| | |
|---|---|
| **URI** | `/logging/kismetdb/pcap/drop.cmd` |
| **Method** | POST |
| **Body** | `{"drop_before": 1605736428}` |

---

## Common Key Fields Reference

### Device Base Fields (`kismet.device.base.*`)

| Field | Type | Description |
|-------|------|-------------|
| `kismet.device.base.key` | string | Unique device key |
| `kismet.device.base.macaddr` | MAC | Device MAC address |
| `kismet.device.base.name` | string | Device name (if known) |
| `kismet.device.base.type` | string | Device type string |
| `kismet.device.base.phyname` | string | PHY handler name |
| `kismet.device.base.first_time` | uint64 | First seen timestamp |
| `kismet.device.base.last_time` | uint64 | Last seen timestamp |
| `kismet.device.base.packets.total` | uint64 | Total packet count |
| `kismet.device.base.signal` | sub-object | Signal data |
| `kismet.device.base.channel` | string | Last channel |
| `kismet.device.base.frequency` | double | Last frequency (KHz) |
| `kismet.device.base.manuf` | string | Manufacturer (OUI lookup) |
| `kismet.device.base.location` | sub-object | GPS location data |
| `kismet.device.base.seenby` | array | Datasources that saw this device |
| `kismet.device.base.tags` | map | User-defined tags |
| `kismet.device.base.crypt` | string | Encryption type |

### Signal Fields (`kismet.common.signal.*`)

| Field | Type | Description |
|-------|------|-------------|
| `kismet.common.signal.last_signal` | int32 | Last signal (dBm) |
| `kismet.common.signal.min_signal` | int32 | Minimum signal |
| `kismet.common.signal.max_signal` | int32 | Maximum signal |
| `kismet.common.signal.last_noise` | int32 | Last noise floor |
| `kismet.common.signal.signal_rrd` | RRD | Signal strength over time |

### Location Fields (`kismet.common.location.*`)

| Field | Type | Description |
|-------|------|-------------|
| `kismet.common.location.last` | sub | Last known lat/lon/alt |
| `kismet.common.location.avg` | sub | Average position |
| `kismet.common.location.min_loc` | sub | Bounding box min |
| `kismet.common.location.max_loc` | sub | Bounding box max |

---

## Python Client Example

```python
import requests

KISMET_URL = "http://localhost:2501"
API_KEY = "your_api_key_here"

# Get all devices seen in the last 60 seconds
r = requests.post(
    f"{KISMET_URL}/devices/last-time/-60/devices.json",
    cookies={"KISMET": API_KEY},
    json={
        "fields": [
            "kismet.device.base.macaddr",
            "kismet.device.base.name",
            "kismet.device.base.phyname",
            "kismet.common.signal.last_signal",
            "kismet.device.base.channel",
            "kismet.device.base.frequency"
        ]
    }
)
devices = r.json()

# Get system status
r = requests.get(
    f"{KISMET_URL}/system/status.json",
    cookies={"KISMET": API_KEY}
)
status = r.json()

# Get current GPS location
r = requests.get(
    f"{KISMET_URL}/gps/location.json",
    cookies={"KISMET": API_KEY}
)
location = r.json()

# Add a datasource
r = requests.post(
    f"{KISMET_URL}/datasource/add_source.cmd",
    cookies={"KISMET": API_KEY},
    json={"definition": "wlan1:name=Survey,channel_hop=true"}
)

# Lock a datasource to channel 6
r = requests.post(
    f"{KISMET_URL}/datasource/by-uuid/{uuid}/set_channel.cmd",
    cookies={"KISMET": API_KEY},
    json={"channel": "6"}
)
```
