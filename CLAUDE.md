# SORCC-PI — Claude Code Guidelines

## Project Context

SORCC-PI is the software toolkit for the **Special Operations Robotics Capabilities
Course (SORCC)** Module 4.3: Raspberry Pi Payload Integrator. It transforms a
Raspberry Pi 4 into a multi-capability RF survey payload that students mount on
robotics platforms — including 10" FPV quadcopters — for wireless reconnaissance
training exercises.

The primary training mission is an airborne WiFi hunt: students fly the payload
over an area to locate a known WiFi SSID, track its signal strength in real time,
and map the results in Google Earth after landing.

### Hardware Stack

| Component | Model | Purpose |
|-----------|-------|---------|
| SBC | Raspberry Pi 4 8GB | Main compute |
| OS | Raspberry Pi OS 64-bit (Bookworm) | Base operating system |
| LTE | SixFab LE910Cx hat (Telit modem) | Cellular connectivity |
| Battery | PiSugar 5000mAh | Portable power |
| SDR | Nooelec SMART (RTL2832U) + antenna | RF reception (433MHz, ADS-B, etc.) |
| SIM | T-Mobile dynamic IP | Cellular data |
| Storage | 128GB+ SD card | OS + capture data |

### Architecture

```
                    ┌─────────────┐
                    │  Student's  │
                    │   Browser   │
                    │ (phone/laptop)
                    └──────┬──────┘
                           │ :8080
                    ┌──────┴──────┐
                    │   SORCC     │
                    │  Dashboard  │
                    │  (FastAPI)  │
                    └──────┬──────┘
                           │ :2501
                    ┌──────┴──────┐
              ┌─────┤   Kismet    ├─────┐
              │     │  Wireless   │     │
              │     │  Monitor    │     │
              │     └─────────────┘     │
         ┌────┴────┐  ┌────┴────┐  ┌───┴────┐
         │  WiFi   │  │Bluetooth│  │  SDR   │
         │ (wlan0) │  │ (hci0)  │  │(rtl433)│
         └─────────┘  └─────────┘  └────────┘
```

### Serial Device Map

| Port | Baud | Purpose |
|------|------|---------|
| `/dev/ttyUSB1` | 9600 | GPS NMEA data (via LTE modem) |
| `/dev/ttyUSB2` | 115200 | AT command interface (LTE modem) |

### Systemd Services

| Service | Purpose | Depends On |
|---------|---------|------------|
| `sorcc-boot.service` | GPS init, avahi startup | ModemManager |
| `kismet.service` | Wireless monitoring | sorcc-boot |
| `sorcc-dashboard.service` | Web dashboard on :8080 | kismet |

## Course Documents

The repository contains the full lesson plan presentation as both a PowerPoint
file and extracted slide images:

- **`4.3 Raspberry Pi Payload Integrator_v2 - Copy.pptx`** — Full presentation (24MB)
- **`Slide1.JPG`** — Title: Raspberry Pi Payload Integrator (20 Sep 2024)
- **`Slide2.JPG`** — Markings (DFARS, Distribution Statement C)
- **`Slide3.JPG`** — Outline: Assembly, OS, Networking, Kismet, Testing, Troubleshooting
- **`Slide4.JPG`** — Administrative Information (4 hours, 15:1 ratio, classroom)
- **`Slide5.JPG`** — Learning Objectives: Assemble/Configure/Operate RPi payload, collect WiFi/PTT/ADS-B
- **`Slide6.JPG`** — Introduction
- **`Slide7.JPG`** — Parts List: RPi 4, SixFab LE910Cx, PiSugar, SDR, SIM, SD card
- **`Slide8.JPG`** — Assembly overview (RPi + PiSugar + SixFab + SDR)
- **`Slide9.JPG`** — PiSugar installation (GPIO alignment, screw mounting)
- **`Slide10.JPG`** — SixFab 4G/LTE hat installation (risers, LE910C4-NF, antennas)
- **`Slide11.JPG`** — SDR installation (antenna + USB)
- **`Slide12.JPG`** — Nooelec SMART SDR types (frequency ranges, XTR models)
- **`Slide13.JPG`** — Installing OS: RPi Imager → Kali Linux 64-bit
- **`Slide14.JPG`** — OS customization: hostname, WiFi, SSH, timezone
- **`Slide15.JPG`** — LTE hat config (static): SCP scripts, run config.sh
- **`Slide16.JPG`** — LTE hat config: NetworkManager mobile broadband (T-Mobile, b2b.static)
- **`Slide17.JPG`** — Crontab setup for reboot.sh
- **`Slide18.JPG`** — Configuring Kismet: browse to IP:2501, set username/password
- **`Slide19.JPG`** — Testing section divider
- **`Slide20.JPG`** — Kismet testing: start kismet, verify data sources (hci0, wlan0, rtladsb)
- **`Slide21.JPG`** — TPMS monitoring: rtl433 at 433MHz, 315MHz considerations
- **`Slide22.JPG`** — RF Recording with GQRX & RTL_SDR (waterfall display, I/Q recording)
- **`Slide23.JPG`** — IMSI Capture: rtl-test, kal, grgsm-livemon, IMSI-catcher script
- **`Slide24.JPG`** — Google Earth: kismetdb_to_kml export, SCP to Windows, plot results
- **`Slide25.JPG`** — Check on Learning quiz (frequency range, RPi Imager, kismet_site.conf, GQRX)
- **`Slide26.JPG`** — Lesson Review
- **`Slide27.JPG`** — Troubleshooting: mmcli, LTE config verification
- **`Slide28.JPG`** — Questions
- **`Slide29.JPG`** — Points of Contact

## Development Guidelines

### Audience
The end users are soldiers — smart, motivated, but not Linux sysadmins. Every
script and UI must work without debugging. Error messages must tell the user
exactly what to do next. Silent failures are unacceptable.

### Scripts
- All bash scripts use `set -euo pipefail`
- Use color-coded output: `ok()`, `warn()`, `fail()`, `info()` helpers
- Every operation must be idempotent (safe to re-run)
- Auto-detect hardware — never hardcode device paths without fallbacks
- Use `$SORCC_USER` / `$SORCC_HOME` — never hardcode `/home/kali/`

### Dashboard
- FastAPI app serving on port 8080 (network-accessible)
- Proxies Kismet REST API on localhost:2501
- SORCC branding: green (#4a7c3f) / black / white
- Must work on phones and tablets (responsive, large touch targets)
- No external CDN dependencies — all assets served locally

### Common Commands

```bash
# Run the installer (as instructor)
sudo bash scripts/sorcc-setup.sh

# Validate the install
bash scripts/sorcc-preflight.sh

# Start Kismet manually
sudo kismet --no-ncurses

# Access the dashboard
# http://<pi-ip>:8080

# Export Kismet data to KML
sudo kismetdb_to_kml -v --in Kismet-*.kismet --out survey.kml

# Check service status
systemctl status kismet sorcc-dashboard sorcc-boot

# View Kismet logs
journalctl -u kismet -f

# Check modem status
sudo mmcli -m 0

# Check GPS
sudo mmcli -m 0 --location-get
```
