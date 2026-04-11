# Kismet Datasource Configuration Reference

> Offline reference for Argus payload integration.
> Compiled from kismetwireless.net official docs + supplemental knowledge.

Every source of packet/device data in Kismet is a **datasource**. A datasource is typically a network interface but can also be an SDR, serial capture device, or replay source.

---

## General Source Definition Syntax

```
source={interface}:{option1}={value1},{option2}={value2},...
```

In `kismet.conf`:
```
source=wlan0:name=WiFiSurvey,channel_hop=true
source=hci0:name=Bluetooth
```

On the command line:
```bash
kismet -c wlan0:name=WiFiSurvey,channel_hop=true
kismet -c 'wlan0:channels="1,6,11,36,40,44,48"'
```

### Common Options (All Datasource Types)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | interface name | Human-readable source name |
| `type` | string | auto-detect | Force datasource type |
| `channel_hop` | bool | true | Enable channel hopping |
| `channel_hoprate` | string | `5/sec` | Hop rate (e.g., `10/sec`, `50/min`) |
| `channel` | string | | Lock to single channel |
| `channels` | string (quoted) | auto | Custom channel list |
| `add_channels` | string (quoted) | | Append additional channels |
| `info_antenna_type` | string | | Antenna description |
| `info_antenna_gain` | number | | Antenna gain in dB |
| `info_antenna_orientation` | number | | Antenna bearing in degrees |

---

## WiFi Sources: Linux (`linuxwifi`)

Capture tool: `kismet_cap_linux_wifi` (requires suid-root).

### Basic Examples

```
# Auto-detect, default settings
source=wlan0

# Named source, no hopping, locked to channel 6
source=wlan0:name=Channel6_Monitor,channel_hop=false,channel=6

# Custom channel list
source=wlan0:channels="1,2,3,4,5,6,7,8,9,10,11,36,40,44,48"

# 5GHz only, fast hopping
source=wlan1:name=HighBand,band5ghz=true,channel_hoprate=10/sec
```

### Monitor Mode

Linux WiFi sources automatically enter monitor mode. Kismet creates a virtual interface (VIF) for monitoring:

- Default VIF naming: `{interface}mon` (e.g., `wlan0` -> `wlan0mon`)
- Custom VIF: `source=wlan0:vif=custom_name`
- If interface is already in monitor mode, Kismet uses it directly.

```
# Prevent shutdown of the primary interface (rare use case)
source=wlan0:ignoreprimary=true,channel_hop=false
```

### Channel Definition Syntax

| Format | Example | Description |
|--------|---------|-------------|
| Basic number | `6` or `153` | 20MHz channel |
| Frequency | `2412` | 20MHz by frequency |
| HT20 | `6HT20` | 802.11n 20MHz explicit |
| HT40+ | `6HT40+` | 40MHz upper secondary |
| HT40- | `6HT40-` | 40MHz lower secondary |
| VHT80 | `116VHT80` | 802.11ac 80MHz |
| VHT160 | `36VHT160` | 802.11ac 160MHz |
| WiFi 6E | `1W6e` | 6GHz band channels |
| Half-rate | `1W10` | 10MHz (Atheros only) |
| Quarter-rate | `1W5` | 5MHz (Atheros only) |

### Band Filtering

Restrict capture to specific frequency bands:

```
source=wlan0:band24ghz=true
source=wlan1:band5ghz=true,band6ghz=true
source=wlan2:band24ghz=true,band5ghz=true
```

By default, all detected bands are enabled.

### HT/VHT Channel Control

```
# Disable 40MHz channel detection
source=wlan0:ht_channels=false

# Use HT20 for all 20MHz channels
source=wlan0:default_ht20=true

# Include both standard and HT20 variants
source=wlan0:expand_ht20=true

# Disable 80/160MHz VHT channels
source=wlan0:vht_channels=false
```

### Packet Processing Options

| Option | Default | Description |
|--------|---------|-------------|
| `filter_mgmt=true` | false | BPF: only management + EAPOL frames (wardrive mode) |
| `truncate_data=true` | false | Capture only 802.11 headers, drop payloads |
| `dot11_process_phy=true` | false | Process PHY-layer packets (noisy, may create spurious devices) |
| `fcsfail=true` | false | Include packets with bad FCS |
| `plcpfail=true` | false | Include packets with bad PLCP headers |
| `filter_locals=true` | false | BPF: filter out local interfaces (max 8) |
| `timestamp=false` | true | Disable timestamp override |
| `verbose=true` | false | Verbose error reporting |

### Common Configuration Profiles

**Wardrive mode** (low overhead, management frames only):
```
source=wlan0:name=Wardrive,filter_mgmt=true
```

**Single channel monitoring** (targeted analysis):
```
source=wlan0:name=Channel6,channel_hop=false,channel=6
```

**5GHz + 6GHz only**:
```
source=wlan1:name=HighBand,band5ghz=true,band6ghz=true
```

**Remote capture** (bandwidth-optimized):
```
source=wlan0:name=Remote,truncate_data=true,filter_locals=true
```

**Intel with HT/VHT disabled** (stability):
```
source=wlp4s0:name=Intel,ht_channels=false,vht_channels=false
```

### Supported Hardware

**Well-supported chipsets:**

| Chipset/Driver | Notes |
|----------------|-------|
| Atheros ath9k | Most reliable, excellent monitor mode |
| Atheros ath5k | Legacy but solid |
| Atheros AR9271 (USB) | Popular for wardriving |
| Intel iwlwifi | All modern Intel (AX200, AX210, etc.) |
| Realtek rtl8187 | Alfa AWUS036H |
| RALink rt2x00 | Decent support |
| Mediatek mt7612u | Excellent 802.11ac support |
| ZyDAS | All models |

**Problematic hardware:**

| Chipset | Issue |
|---------|-------|
| ath10k (802.11ac) | Closed firmware, spurious packets in monitor mode |
| rtl8812/8814 USB | Out-of-kernel drivers, inconsistent monitor mode |
| rtl88x2bu | No mac80211 VIF, no HT channel support |
| Broadcom (RPi) | Requires nexmon patches |

### WiFi 6E (Intel AX210)

Requires scanning before starting Kismet to enable 6GHz channels:
```bash
sudo iw dev wlan0 scan
kismet
```

### Lockfile

Kismet uses `/tmp/.kismet_cap_linux_wifi_interface_lock` to prevent race conditions. If stuck:
```bash
sudo rm /tmp/.kismet_cap_linux_wifi_interface_lock
```

---

## Bluetooth: Linux HCI (`linuxbluetooth`)

Capture tool: `kismet_cap_linux_bluetooth` (requires suid-root).

### Configuration

```
source=hci0
source=hci0:name=Bluetooth_Survey
source=hci0:type=linuxbluetooth
source=hci1:name=BT_External
```

### Capabilities

- **Active scanning only** -- discovers broadcasting/discoverable devices
- Captures basic device info: name, class, MAC, RSSI
- Identifies Bluetooth Classic and BLE devices
- Any standard Linux HCI interface works (built-in or USB dongles like Sena UD100)
- Linux-only

### Limitations

- No passive packet sniffing (Bluetooth frequency-hopping prevents this without specialized hardware)
- No advanced service enumeration (planned for future)
- Cannot capture raw Bluetooth packets -- use Ubertooth for that

---

## Bluetooth: Ubertooth

For passive Bluetooth sniffing, use an Ubertooth One:

```
source=ubertooth-one-0:type=ubertooth
```

Captures raw BTLE advertisement and data packets. Requires `libubertooth` and the Ubertooth firmware.

---

## Bluetooth: TI CC-2540

USB Bluetooth LE sniffer:

```
source=/dev/ttyACM0:type=ticc2540
```

Captures BTLE advertisements. Low-cost USB dongle.

---

## Bluetooth: nRF 51822 (BTLE)

Nordic Semiconductor BLE sniffer:

```
source=nrf51822-0:type=nrf51822
```

---

## SDR Sources: RTL-433 (`rtl433`)

Captures ISM-band sensor data (weather stations, tire pressure monitors, thermometers, etc.) using RTL-SDR dongles and the `rtl_433` tool.

Capture tool: `kismet_cap_sdr_rtl433`.

### Prerequisites

- RTL-SDR USB dongle (RTL2832U-based)
- `rtl_433` installed and in PATH
- `librtlsdr` installed

### Configuration

```
# Basic -- uses first available RTL-SDR
source=rtl433-0:name=ISM_Sensors

# Specify device by index
source=rtl433-0:type=rtl433

# Specify device by serial number
source=rtl433-SN12345678:type=rtl433
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `device` | auto | RTL-SDR device index or serial |
| `gain` | auto | Tuner gain (device-dependent, typically 0-49.6) |
| `channel` | `433.920MHz` | Center frequency |

### Frequency Configuration

RTL-433 typically operates on ISM bands:
- 433.92 MHz (Europe/Asia)
- 315 MHz (North America)
- 868 MHz (Europe)
- 915 MHz (North America)

```
source=rtl433-0:name=ISM_433,channel=433.920MHz
source=rtl433-1:name=ISM_315,channel=315.000MHz
```

### Detected Device Types

RTL-433 can decode 200+ device protocols including:
- Weather stations (Acurite, LaCrosse, Oregon Scientific, Fine Offset)
- Tire pressure monitors (TPMS)
- Thermometers and hygrometers
- Smoke/CO detectors
- Doorbells and remote switches
- Soil moisture sensors
- Power meters

---

## SDR Sources: RTL-ADSB (`rtladsb`)

Captures ADS-B aircraft transponder data at 1090 MHz using RTL-SDR.

Capture tool: `kismet_cap_sdr_rtladsb`.

### Prerequisites

- RTL-SDR USB dongle
- Typically uses built-in decoder or `rtl_adsb`

### Configuration

```
source=rtladsb-0:name=Aircraft
source=rtladsb-0:type=rtladsb
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `device` | auto | RTL-SDR device index or serial |
| `gain` | auto | Tuner gain |

### Captured Data

- Aircraft ICAO address
- Callsign
- Altitude, speed, heading
- Position (lat/lon)
- Squawk code

---

## SDR Sources: RTL-AMR (`rtlamr`)

Captures AMR (Automatic Meter Reading) utility meter data using RTL-SDR.

Capture tool: `kismet_cap_sdr_rtlamr`.

### Prerequisites

- RTL-SDR USB dongle
- `rtlamr` tool from `github.com/bemasher/rtlamr`
- `rtl_tcp` running (rtlamr connects to it)

### Configuration

```
source=rtlamr-0:name=Meters
source=rtlamr-0:type=rtlamr
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `device` | auto | RTL-SDR device index |
| `gain` | auto | Tuner gain |

### Captured Data

- Meter ID
- Meter type (electric, gas, water)
- Consumption values
- Endpoint type

---

## Zigbee Sources

### NXP KW41Z

```
source=kw41z-0:type=kw41z
```

### TI CC2531

```
source=/dev/ttyACM0:type=ticc2531
```

### nRF 52840

```
source=nrf52840-0:type=nrf52840
```

### Freaklabs

```
source=/dev/ttyUSB0:type=freaklabs
```

---

## Replay Sources

### KismetDB Replay

Replay a previous capture from a `.kismet` database file:

```
source=/path/to/capture.kismet:type=kismetdb
```

Options:
- `realtime=true` -- replay at original capture speed
- `realtime=false` -- replay as fast as possible (default)
- `pps={N}` -- limit packets per second

### PCAP Replay

Replay from a pcap/pcapng file:

```
source=/path/to/capture.pcap:type=pcapfile
source=/path/to/capture.pcapng:type=pcapfile
```

Same options as KismetDB replay (`realtime`, `pps`).

---

## Remote Capture

Kismet supports remote capture sources where the capture hardware is on a different machine.

### Remote Capture Tool

Run on the remote device:
```bash
kismet_cap_linux_wifi \
  --connect ws://kismet-server:2501/datasource/remote/remotesource.ws \
  --source wlan0:name=RemoteWifi \
  --apikey YOUR_API_KEY
```

### Bandwidth Optimization

For remote captures over limited links:
```
source=wlan0:name=Remote,truncate_data=true,filter_mgmt=true
```

### WebSocket Connection

Remote captures connect via WebSocket to:
```
ws://{server}:2501/datasource/remote/remotesource.ws
```

---

## Multiple RTL-SDR Dongles

When using multiple RTL-SDR dongles simultaneously, assign unique serial numbers:

```bash
# Set serial number on RTL-SDR dongle
rtl_eeprom -s RTLSDR01
rtl_eeprom -s RTLSDR02
```

Then reference by serial:
```
source=rtl433-RTLSDR01:name=ISM_Sensors
source=rtladsb-RTLSDR02:name=Aircraft
```

---

## kismet.conf Datasource Defaults

```conf
# Default channel hopping behavior
channel_hop=true
channel_hop_speed=5/sec

# Split hopping across interfaces (spread channel coverage)
split_source_hopping=true

# Randomize channel order
randomized_hopping=true

# Retry failed sources
source_stale_timeout=60
source_launch_group=all
source_launch_delay=0

# Default source definitions
source=wlan0:name=WiFi
source=hci0:name=Bluetooth
```

---

## Runtime Source Management via REST API

### Add a source at runtime

```bash
curl -X POST http://localhost:2501/datasource/add_source.cmd \
  -H "Content-Type: application/json" \
  -b "KISMET=$API_KEY" \
  -d '{"definition": "wlan1:name=NewSource,channel_hop=true"}'
```

### Lock to a channel

```bash
curl -X POST http://localhost:2501/datasource/by-uuid/$UUID/set_channel.cmd \
  -H "Content-Type: application/json" \
  -b "KISMET=$API_KEY" \
  -d '{"channel": "6HT40+"}'
```

### Set custom hop list

```bash
curl -X POST http://localhost:2501/datasource/by-uuid/$UUID/set_channel.cmd \
  -H "Content-Type: application/json" \
  -b "KISMET=$API_KEY" \
  -d '{"channels": ["1","6","11","36","40","44","48"], "rate": 3, "shuffle": 1}'
```

### List available interfaces

```bash
curl http://localhost:2501/datasource/list_interfaces.json \
  -b "KISMET=$API_KEY"
```

### Close / reopen a source

```bash
# Close
curl -X POST http://localhost:2501/datasource/by-uuid/$UUID/close_source.cmd \
  -b "KISMET=$API_KEY"

# Reopen
curl -X POST http://localhost:2501/datasource/by-uuid/$UUID/open_source.cmd \
  -b "KISMET=$API_KEY"
```
