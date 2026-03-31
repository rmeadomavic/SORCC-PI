# Kismet Export Formats Reference

> Offline reference for SORCC payload integration.
> Compiled from kismetwireless.net official docs + supplemental knowledge.

Kismet supports multiple logging and export formats. The primary format is **KismetDB** (unified SQLite3), with conversion tools and live streaming for PCAP-NG, WigleCSV, KML, JSON, and more.

---

## Logging Configuration

### Enable/Disable Logging

In `kismet_logging.conf`:
```
# Enable logging (default: true)
logging_enabled=true

# Disable logging entirely
logging_enabled=false
```

Command line:
```bash
# Disable logging
kismet -n

# Custom log title
kismet -t MySurvey
```

### Log Type Selection

Enable multiple simultaneous formats:
```
log_types=kismet
log_types=kismet,pcapng
log_types=kismet,pcapng,wiglecsv
```

### Log Naming

```
# Log title (default: "Kismet")
log_title=SORCC_Survey

# Output directory
log_prefix=/opt/kismet/logs

# Custom naming template
log_template=%p/%n-%D-%t-%i.%l
```

**Template codes:**

| Code | Meaning |
|------|---------|
| `%p` | Log prefix directory |
| `%n` | Log title |
| `%d` | Date: Mmm-DD-YYYY |
| `%D` | Date: YYYYMMDD |
| `%t` | Time: HH-MM-SS |
| `%T` | Time: HHMMSS |
| `%i` | Sequential log number |
| `%I` | Zero-padded log number |
| `%l` | Log type extension |
| `%h` | Home directory |

Default pattern: `{prefix}/{title}-{YYYYMMDD}-{HH-MM-SS}-{#}.{type}`

---

## Format 1: KismetDB (`.kismet`)

The primary unified logging format. A single SQLite3 file containing everything.

### What it Contains

- All packets (raw, with headers)
- Device records (all PHY types)
- GPS/location data
- System messages
- Datasource information
- Historical trends and snapshots
- Alert records

### Configuration

```
log_types=kismet
```

### Data Retention / Timeout Settings

Control how long data is kept in active logs (seconds):

```
kis_log_alert_timeout=86400
kis_log_device_timeout=86400
kis_log_message_timeout=86400
kis_log_packet_timeout=86400
kis_log_snapshot_timeout=86400
```

Devices inactive longer than `kis_log_device_timeout` are automatically removed.

### Ephemeral Logging

Logs are deleted on Kismet exit (useful for sensor mode):
```
kis_log_ephemeral_dangerous=true
```

### Duplicate Packet Suppression

When multiple datasources capture the same packet:
```
kis_log_duplicate_packets=false
```

### Data Packet Filtering

Log only management frames (skip data payloads):
```
kis_log_data_packets=false
```

### Device Filters

In `kismet_filter.conf`:

```
# Default behavior
kis_log_device_filter_default=pass

# Per-device filters: phyname,macaddress,action
kis_log_device_filter=IEEE802.11,aa:bb:cc:dd:ee:ff,pass
kis_log_device_filter=IEEE802.11,00:11:22:00:00:00/ff:ff:ff:00:00:00,block
```

### Packet Filters

```
# Filter by address type: phyname,addresstype,macaddress,action
# addresstype: source, destination, network, other, any
kis_log_packet_filter=IEEE802.11,source,aa:bb:cc:dd:ee:ff,pass
kis_log_packet_filter=IEEE802.11,any,00:11:22:00:00:00/ff:ff:ff:00:00:00,block
```

### MAC Address Masking

- Single: `AA:BB:CC:DD:EE:FF`
- OUI match: `11:22:33:00:00:00/FF:FF:FF:00:00:00`

### Journal Files

SQLite creates `...-journal` files during abnormal exits. Recover with:
```bash
sqlite3 Kismet-foo.kismet 'VACUUM;'
# or
kismetdb_clean foo.kismet
```

### KismetDB SQLite Schema (Key Tables)

| Table | Contents |
|-------|----------|
| `packets` | Raw packet data with timestamps, GPS, signal, frequency, datasource |
| `data` | Non-packet data records |
| `devices` | JSON device records (periodically updated snapshots) |
| `alerts` | Alert records |
| `messages` | System message log |
| `snapshots` | Periodic device state snapshots |
| `datasources` | Datasource definitions and metadata |

**Useful SQL queries:**

```sql
-- Count total packets
SELECT COUNT(*) FROM packets;

-- List all WiFi access points
SELECT json_extract(device, '$.kismet.device.base.macaddr'),
       json_extract(device, '$.kismet.device.base.name'),
       json_extract(device, '$.kismet.device.base.type')
FROM devices
WHERE json_extract(device, '$.kismet.device.base.phyname') = 'IEEE802.11'
  AND json_extract(device, '$.kismet.device.base.type') LIKE '%AP%';

-- Get packets in a time range
SELECT ts_sec, sourcemac, destmac, frequency, signal
FROM packets
WHERE ts_sec BETWEEN 1605700000 AND 1605800000;

-- Get devices seen by a specific datasource
SELECT json_extract(device, '$.kismet.device.base.macaddr'),
       json_extract(device, '$.kismet.device.base.name')
FROM devices, json_each(json_extract(device, '$.kismet.device.base.seenby'))
WHERE json_extract(json_each.value, '$.kismet.common.seenby.uuid') = 'YOUR-UUID';
```

### Live Filter Control via REST API

Packet filters can be dynamically modified at runtime via the filter endpoints (see `kismet-rest-api.md`).

---

## Format 2: PCAP-NG (`.pcapng`)

Modern packet capture format compatible with Wireshark, tshark, tcpdump.

### Advantages over Legacy PCAP

- Multi-protocol: WiFi, BTLE, Zigbee, and other packet types simultaneously
- Original metadata: unmodified radiotap headers, full signal info
- Datasource tracking: records which interface captured each packet
- Lossless: no header translation
- Annotations and contextual data support

### Configuration

```
log_types=pcapng
```

### Log Rotation (v2023-12+)

```
# Rotate when file exceeds size (MB)
pcapng_log_max_mb=1024
```

New files are created seamlessly without packet loss.

### Filtering

```
# Suppress duplicate packets
pcapng_log_duplicate_packets=false

# Skip data packets (management only)
pcapng_log_data_packets=false
```

### Performance Note

For extremely high-density logging, PCAP-NG may offer better write performance than KismetDB because it writes sequentially rather than using SQLite random-access patterns.

---

## Format 3: Legacy PCAP with PPI Headers (`.pcap`)

```
log_types=pcapppi
```

- Older PCAP format with PPI (Per-Packet Information) headers
- **WiFi packets only** -- cannot handle BT, Zigbee, etc.
- Translates/reduces some header metadata
- Supported by older tools
- Generally superseded by PCAP-NG

### Filtering

```
ppi_log_duplicate_packets=false
ppi_log_data_packets=false
```

---

## Format 4: WigleCSV (`.wiglecsv`)

CSV format for uploading to the Wigle wardriving community database.

### Configuration

```
log_types=wiglecsv
```

### Requirements

- **GPS must be connected and providing a fix** -- without location data, the wiglecsv log remains empty.

### Content

- WiFi access points
- Bluetooth devices
- Geographic coordinates
- Signal strength
- No raw packets

### Important Note

Cannot recover packet data from WigleCSV. If you need packets, also enable `kismet` or `pcapng` logging.

---

## Conversion Tools

KismetDB files can be converted to other formats after capture using built-in tools.

### kismetdb_to_pcap

Convert KismetDB to PCAP-NG:

```bash
kismetdb_to_pcap --in capture.kismet --out capture.pcapng
```

Options:

| Flag | Description |
|------|-------------|
| `--in` | Input .kismet file |
| `--out` | Output .pcapng file |
| `--old-pcap` | Output legacy PCAP instead of PCAP-NG |
| `--dlt` | Filter by DLT type (e.g., 127 for radiotap) |
| `--skip-clean` | Skip database optimization |
| `--verbose` | Verbose output |

### kismetdb_to_wiglecsv

Convert KismetDB to WigleCSV format:

```bash
kismetdb_to_wiglecsv --in capture.kismet --out capture.csv
```

Options:

| Flag | Description |
|------|-------------|
| `--in` | Input .kismet file |
| `--out` | Output .csv file |
| `--verbose` | Verbose output |
| `--skip-clean` | Skip database optimization |
| `--rate-limit={seconds}` | Record emission rate per AP (default: 1/sec) |
| `--cache-limit={count}` | Device cache size (default: 1000) |

Upload the CSV to [wigle.net](https://wigle.net).

### kismetdb_to_kml

Convert KismetDB to KML for Google Earth / mapping:

```bash
kismetdb_to_kml --in capture.kismet --out capture.kml
```

Exports device locations as KML placemarks with metadata (name, MAC, signal, encryption).

### kismetdb_to_json (Device Export)

Export device records as JSON:

```bash
kismetdb_to_json --in capture.kismet --out devices.json
```

Exports full device JSON records from the database.

### kismetdb_statistics

Generate statistical reports from a capture:

```bash
kismetdb_statistics --in capture.kismet
```

### kismetdb_strip_packets

Remove raw packet data from a database (reduce file size while keeping device records):

```bash
kismetdb_strip_packets --in capture.kismet
```

### kismetdb_clean

Clean/vacuum the database (merge journal files, optimize):

```bash
kismetdb_clean capture.kismet
```

---

## Live Packet Streaming (REST API)

### Stream All Packets

```
GET /pcap/all_packets.pcapng
```

Returns PCAP-NG stream of all packets from all datasources. Streams until connection is closed.

### Stream by Datasource

```
GET /datasource/pcap/by-uuid/{UUID}/packets.pcapng
```

### Stream by Device

```
GET /devices/pcap/by-key/{KEY}/packets.pcapng
```

### Historical Packet Query from KismetDB

```
GET/POST /logging/kismetdb/pcap/{TITLE}.pcapng
```

Filter parameters (all optional, combined with AND):

| Parameter | Description |
|-----------|-------------|
| `timestamp_start` | Start time (POSIX with microseconds) |
| `timestamp_end` | End time |
| `datasource` | Datasource UUID |
| `device_id` | Kismet device key |
| `dlt` | PCAP DLT value |
| `frequency` | Exact frequency (KHz) |
| `frequency_min` / `frequency_max` | Frequency range |
| `signal_min` / `signal_max` | Signal level range |
| `address_source` | Source MAC |
| `address_dest` | Destination MAC |
| `address_trans` | Transmitter MAC |
| `location_lat_min` / `location_lat_max` | Latitude bounds |
| `location_lon_min` / `location_lon_max` | Longitude bounds |
| `size_min` / `size_max` | Packet size (bytes) |
| `tag` | Packet tag match |
| `limit` | Max packets |

Example:

```bash
# Get all packets from the last hour on channel 6 with good signal
curl "http://localhost:2501/logging/kismetdb/pcap/filtered.pcapng" \
  -b "KISMET=$API_KEY" \
  -d '{"timestamp_start": 1605700000, "frequency": 2437000, "signal_min": -70}' \
  -o filtered.pcapng
```

### Delete Old Packets

```
POST /logging/kismetdb/pcap/drop.cmd
Body: {"drop_before": 1605736428}
```

---

## Logging API Endpoints

### List Available Log Drivers

```
GET /logging/drivers.json
```

### List Active Logs

```
GET /logging/active.json
```

### Start a New Log

```
POST /logging/by-class/{LOGCLASS}/start.cmd
Body: {"title": "optional_filename"}
```

Note: Some log types (like kismetdb) only allow a single instance.

### Stop a Log

```
GET /logging/by-uuid/{UUID}/stop.cmd
```

---

## Recommended SORCC Payload Configuration

For an RF survey payload, a practical logging configuration:

```conf
# kismet_logging.conf additions for SORCC payload

# Log title with mission identifier
log_title=SORCC_RF_Survey

# Output to mounted storage
log_prefix=/opt/kismet/logs

# Enable unified DB + PCAP-NG for Wireshark analysis
log_types=kismet,pcapng

# Rotate PCAP files at 512MB
pcapng_log_max_mb=512

# Drop duplicate packets to save space
kis_log_duplicate_packets=false
pcapng_log_duplicate_packets=false

# Keep everything for 7 days
kis_log_alert_timeout=604800
kis_log_device_timeout=604800
kis_log_message_timeout=604800
kis_log_packet_timeout=604800
```

Post-mission export workflow:
```bash
# Convert to WigleCSV for mapping upload
kismetdb_to_wiglecsv --in SORCC_RF_Survey*.kismet --out survey_wigle.csv

# Convert to KML for Google Earth overlay
kismetdb_to_kml --in SORCC_RF_Survey*.kismet --out survey_map.kml

# Export device inventory as JSON
kismetdb_to_json --in SORCC_RF_Survey*.kismet --out devices.json

# Strip packets for lightweight device-only archive
cp SORCC_RF_Survey*.kismet archive_devices.kismet
kismetdb_strip_packets --in archive_devices.kismet
```
