# SORCC-PI — RF Survey Payload Integrator

![Platform](https://img.shields.io/badge/Platform-Raspberry_Pi_4-c51a4a?style=flat-square)
![OS](https://img.shields.io/badge/OS-Kali_Linux_ARM64-557C94?style=flat-square)
![RF](https://img.shields.io/badge/RF-Kismet_+_RTL--SDR-4a7c3f?style=flat-square)
![Status](https://img.shields.io/badge/Status-Field_Ready-2ecc71?style=flat-square)

Software toolkit for the **Special Operations Robotics Capabilities Course (SORCC)**
Module 4.3: Raspberry Pi Payload Integrator. Transforms a Raspberry Pi 4 into a
deployable RF survey payload for robotics platforms.

```
Student Browser ──:8080──▶ SORCC Dashboard (FastAPI)
                                    │
                              :2501 │
                                    ▼
                          Kismet Wireless Monitor
                          ┌────┬────┬────┐
                          │WiFi│ BT │SDR │
                          └────┴────┴────┘
                                    │
                        LTE Modem ──┤── GPS
                                    │
                        PiSugar ────┘── Battery
```

## Quick Start

```bash
# 1. Flash Kali Linux ARM64 onto SD card (use RPi Imager)
# 2. Clone the repo
git clone https://github.com/rmeadomavic/sorcc-pi.git
cd sorcc-pi

# 3. Run the one-click installer
sudo bash scripts/sorcc-setup.sh

# 4. Open the dashboard
# http://<pi-ip>:8080
```

## Hardware

| Component | Model | Purpose |
|-----------|-------|---------|
| SBC | Raspberry Pi 4 8GB | Main compute |
| OS | Kali Linux ARM64 | Base operating system |
| LTE | SixFab LE910Cx hat | Cellular connectivity |
| Battery | PiSugar 5000mAh | Portable power |
| SDR | Nooelec SMART (RTL2832U) | RF reception |
| Storage | 128GB+ SD card | OS + capture data |

## Dashboard Features

### Operations
- **Live View** — Real-time device list with signal strength, MAC, type, packet count
- **Hunt Mode** — Enter a target SSID, track signal with WARMER/COLDER feedback
- **RF Mission Profiles** — Switch between WiFi Survey, Bluetooth Recon, TPMS, ADS-B, Full Spectrum
- **Export** — Download KML for Google Earth or CSV for analysis

### Settings
- **Config Editor** — Edit all settings from the browser (APN, Kismet sources, GPS, WiFi)
- **APN Management** — Carrier dropdown with common APNs (T-Mobile, AT&T, Verizon, FirstNet)
- **Import/Export** — Share configurations between devices

### Preflight
- **Visual Checklist** — Hardware, services, network, and config checks with pass/warn/fail indicators
- **Auto-refresh** — Continuous monitoring of system health

### Instructor Overview
- **Multi-Device View** — Monitor all Pi payloads from a single browser tab
- **Real-time Status** — Kismet, GPS, LTE, battery, device count per Pi
- **Access:** `http://<any-pi-ip>:8080/instructor`

## RF Mission Profiles

| Profile | Sources | Use Case |
|---------|---------|----------|
| WiFi Survey | WiFi + Bluetooth | Scan all access points and clients |
| Bluetooth Recon | Bluetooth only | BLE and Classic device discovery |
| TPMS Monitoring | Bluetooth + RTL-433 @ 433MHz | Vehicle tire pressure sensors |
| ADS-B Aircraft | Bluetooth + ADS-B @ 1090MHz | Aircraft transponder tracking |
| Full Spectrum | All sources | Complete RF survey |

## Student Exercises

1. **RF Survey** — Fly the payload, map all WiFi/BT devices, export KML
2. **WiFi Hunt** — Locate a hidden access point using Hunt Mode signal tracking
3. **RF Recording** — Capture signals with GQRX and RTL-SDR
4. **TPMS Monitoring** — Detect vehicle tire pressure sensors at 433 MHz
5. **Cellular Recon** — Use gr-gsm and IMSI-catcher (instructor-led)
6. **KML Export** — Visualize survey results in Google Earth

## Configuration

All settings live in `config/sorcc.ini`. Edit via the web dashboard (Settings tab)
or directly on the Pi:

```bash
nano /opt/sorcc/config/sorcc.ini
```

Key settings:
- `[lte] apn` — Your carrier's APN (blank for auto-detect)
- `[kismet] source_wifi` — WiFi adapter for monitor mode
- `[general] hostname` — mDNS hostname (e.g., `sorcc-pi.local`)

## Remote Access

```bash
# Set up Tailscale VPN
sudo bash scripts/setup-tailscale.sh

# SSH from anywhere
ssh <user>@<tailscale-ip>

# Dashboard from anywhere
http://<tailscale-ip>:8080
```

## Headless Field-Boot

Configure zero-touch operation — power on and the dashboard is ready:

```bash
# With WiFi
sudo bash scripts/sorcc-headless.sh --ssid "ClassroomWiFi" --password "s3cret"

# LTE only
sudo bash scripts/sorcc-headless.sh --ethernet-only

# Custom hostname
sudo bash scripts/sorcc-headless.sh --hostname sorcc-pi-03
```

## Service Management

| Service | Purpose | Depends On |
|---------|---------|------------|
| `sorcc-boot` | GPS init, Avahi startup | ModemManager |
| `kismet` | Wireless monitoring | sorcc-boot |
| `sorcc-dashboard` | Web UI on :8080 | kismet |

```bash
# Check all services
systemctl status kismet sorcc-dashboard sorcc-boot

# View logs
journalctl -u sorcc-dashboard -f
journalctl -u kismet -f

# Restart services
sudo systemctl restart sorcc-dashboard
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No devices in Live View | Check Kismet: `systemctl status kismet` |
| LTE not connecting | Verify APN in Settings tab or `sudo mmcli -m 0` |
| No GPS fix | Move to open sky area, check `sudo mmcli -m 0 --location-get` |
| Dashboard not loading | Check: `systemctl status sorcc-dashboard` |
| SDR not detected | Replug the Nooelec dongle, check `lsusb` |
| Bluetooth missing | Check `hciconfig` — may need `sudo hciconfig hci0 up` |

## Validation

```bash
# Full preflight check
bash scripts/sorcc-preflight.sh

# JSON output (used by dashboard)
bash scripts/sorcc-preflight.sh --json
```

## Course Materials

Presentation slides are in the `courseware/` directory:
- `4.3 Raspberry Pi Payload Integrator_v2 - Copy.pptx` — Full lesson plan
- `Slide1.JPG` through `Slide29.JPG` — Individual slides for reference
