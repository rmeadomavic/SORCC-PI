# Configuration Reference

All settings live in `config/sorcc.ini`. Edit via the web dashboard (Settings tab)
or directly on the Pi at `/opt/sorcc/config/sorcc.ini`.

Factory defaults are in `config/sorcc.ini.factory`.

## Sections

### [general]

| Key | Default | Description |
|-----|---------|-------------|
| `hostname` | `sorcc-pi-01` | mDNS hostname (reachable as `<hostname>.local`) |
| `callsign` | `SORCC-01` | Identifier shown in instructor overview |

### [lte]

| Key | Default | Description |
|-----|---------|-------------|
| `apn` | *(blank)* | Carrier APN — blank triggers interactive prompt during setup |
| `connection_name` | `sorcc-lte` | NetworkManager connection name |
| `dns` | `8.8.8.8,1.1.1.1` | DNS servers (comma-separated) |

**Common APNs:**
- T-Mobile: `b2b.static`
- AT&T: `broadband`
- Verizon: `vzwinternet`
- FirstNet: `firstnet`

### [gps]

| Key | Default | Description |
|-----|---------|-------------|
| `serial_port` | `/dev/ttyUSB1` | GPS NMEA serial port |
| `serial_baud` | `9600` | GPS serial baud rate |
| `at_port` | `/dev/ttyUSB2` | AT command port (modem control) |
| `at_baud` | `115200` | AT command baud rate |

### [kismet]

| Key | Default | Description |
|-----|---------|-------------|
| `user` | `kismet` | Kismet web UI username |
| `pass` | `kismet` | Kismet web UI password |
| `port` | `2501` | Kismet REST API port |
| `source_bluetooth` | `hci0` | Bluetooth source |
| `source_wifi` | *(blank)* | WiFi monitor-mode adapter (e.g., `wlan0`) |
| `source_rtl433` | *(blank)* | RTL-433 source (e.g., `rtl433-0:channel=433000000`) |
| `source_adsb` | *(blank)* | ADS-B source (e.g., `rtladsb-00000001`) |
| `log_dir` | `/opt/sorcc/output_data` | Kismet capture data directory |

### [dashboard]

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `0.0.0.0` | Dashboard bind address |
| `port` | `8080` | Dashboard port |
| `password` | *(blank)* | Login password for browser access. Empty = no login required. |
| `session_timeout_min` | `480` | Login session timeout in minutes (default 8 hours) |

### [tailscale]

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Install/enable Tailscale |
| `ssh` | `true` | Enable Tailscale SSH |

### [pisugar]

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Install PiSugar battery manager |

### [wifi]

| Key | Default | Description |
|-----|---------|-------------|
| `ssid` | *(blank)* | WiFi network for auto-connect (headless boot) |
| `password` | *(blank)* | WiFi password |

### [recon_tools]

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Install gr-gsm, kalibrate, IMSI-catcher, GQRX |

## Editing Config

### Via Web Dashboard (Recommended)
1. Open the dashboard at `http://<pi-ip>:8080`
2. Click the **Settings** tab
3. Select a section (e.g., LTE)
4. Edit fields and click **Apply**

### Via Terminal
```bash
nano /opt/sorcc/config/sorcc.ini
sudo systemctl restart sorcc-dashboard  # to pick up changes
```

### Import/Export
- **Export:** Settings tab → Export button (downloads JSON)
- **Import:** Settings tab → Import button (upload JSON from another Pi)
- **Factory Reset:** Settings tab → Factory Reset button

## Password Protection

Set `password` under `[dashboard]` to require login for all dashboard pages and APIs.
Leave blank to allow open access (default).

When a password is set:
- All routes redirect to `/login` for unauthenticated users.
- `/api/status` stays open for instructor polling.
- Sessions use HMAC-signed cookies. They expire after `session_timeout_min` minutes.
- Failed login attempts are rate-limited (10 failures = 5 minute lockout).

Change the password via the Settings tab or by editing `sorcc.ini` directly.

## Config File Locations

| File | Purpose |
|------|---------|
| `/opt/sorcc/config/sorcc.ini` | Active runtime config |
| `/opt/sorcc/config/sorcc.ini.bak` | Auto-backup before each write |
| `/opt/sorcc/config/sorcc.ini.factory` | Factory defaults (never modified) |
