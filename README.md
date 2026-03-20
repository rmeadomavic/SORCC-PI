# SORCC-PI — Raspberry Pi RF Survey Payload

Automated setup and mission dashboard for the **Special Operations Robotics Capabilities Course (SORCC)** Module 4.3: Raspberry Pi Payload Integrator.

Transforms a Raspberry Pi 4 into a deployable RF survey payload for robotics platforms — including FPV quadcopters — capable of WiFi, Bluetooth, SDR, and cellular reconnaissance.

## Parts List

| Component | Model |
|-----------|-------|
| SBC | Raspberry Pi 4 8GB |
| LTE Hat | SixFab LE910Cx |
| Battery | PiSugar 5000mAh |
| SDR | Nooelec SMART (RTL2832U) + antenna |
| SIM | T-Mobile (dynamic IP) |
| Storage | 128GB+ SD card |
| OS | Raspberry Pi OS 64-bit (Bookworm) |

## Quick Start (Instructors)

### 1. Flash the SD Card
Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to flash **Raspberry Pi OS 64-bit** (Bookworm). In the customization settings:
- Set hostname (e.g., `sorcc-pi-01`)
- Set username and password
- Configure WiFi
- Enable SSH

### 2. Assemble Hardware
Follow slides 8-11 in the course presentation:
1. Mount PiSugar battery on RPi (Slide 9)
2. Install SixFab LTE hat with LE910C4-NF modem (Slide 10)
3. Attach Nooelec SDR + antenna (Slide 11)
4. Insert SIM card

### 3. Run the Installer
```bash
git clone https://github.com/rmeadomavic/SORCC-PI.git
cd SORCC-PI
sudo bash scripts/sorcc-setup.sh
```

The installer runs 11 automated steps: preflight checks, system update, SDR tools, Kismet, LTE modem, GPS, Tailscale, PiSugar, cellular recon tools, systemd services, and the SORCC dashboard.

### 4. Validate
```bash
bash scripts/sorcc-preflight.sh
```

### 5. Reboot
```bash
sudo reboot
```

After reboot, Kismet and the dashboard start automatically.

## Architecture

```
Student's Browser (phone/laptop)
        │ port 8080
   SORCC Dashboard (FastAPI)
        │ port 2501
      Kismet Wireless Monitor
     ┌──┼──┐
   WiFi  BT  SDR
```

## What Students Do

### Exercise 1: RF Survey
Open the SORCC Dashboard at `http://<pi-ip>:8080` → **Live View** tab. Observe WiFi, Bluetooth, and SDR devices being detected in real time.

### Exercise 2: WiFi Hunt (FPV Mission)
1. Open **Hunt Mode** tab on a phone/tablet
2. Enter the target SSID
3. Mount the payload on the FPV quadcopter
4. Fly toward the signal — the dashboard shows live "WARMER / COLDER" feedback
5. Land and export KML for Google Earth analysis

### Exercise 3: RF Recording
Use GQRX to tune to frequencies and record I/Q data (Slide 22):
```bash
gqrx
```

### Exercise 4: TPMS Monitoring
Monitor tire pressure sensors at 433 MHz (Slide 21):
```bash
rtl_433 -f 433M -p 26
```

### Exercise 5: Cellular Recon (Instructor Demo)
Instructor demonstrates IMSI catching workflow (Slide 23):
```bash
kal -s 1900                                    # Find cell towers
grgsm-livemon -f 1987.6M -p 26                # Sniff tower
cd ~/IMSI-catcher && python3 simple_IMSI-catcher.py -s -t test.txt
```

### Exercise 6: Google Earth Export
1. Open **Export** tab in the dashboard and click "Download KML File"
2. Or from terminal:
   ```bash
   sudo kismetdb_to_kml -v --in Kismet-*.kismet --out survey.kml
   ```
3. Transfer KML to your computer and open in Google Earth

## Remote Access

Tailscale provides SSH and dashboard access over the internet:
```bash
# Set up Tailscale (during install or standalone)
sudo bash scripts/setup-tailscale.sh

# SSH from anywhere
ssh <user>@<tailscale-ip>

# Dashboard from anywhere
http://<tailscale-ip>:8080
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| `sorcc-boot` | — | GPS init + Avahi on boot |
| `kismet` | 2501 | Wireless monitoring |
| `sorcc-dashboard` | 8080 | SORCC web dashboard |

```bash
# Check status
systemctl status kismet sorcc-dashboard sorcc-boot

# View logs
journalctl -u kismet -f
journalctl -u sorcc-dashboard -f
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No LTE connection | `sudo mmcli -m 0` — check modem status. Verify SIM and APN. |
| Kismet won't start | `sudo kismet --no-ncurses` — check error output |
| No GPS data | `sudo mmcli -m 0 --location-get` — GPS needs sky view to acquire |
| Dashboard not loading | `systemctl status sorcc-dashboard` — check if service is running |
| SDR not detected | `lsusb` — verify Nooelec SMART is plugged in (0bda:2838) |
| Cannot SSH remotely | `tailscale status` — verify Tailscale is connected |
| Battery not reporting | `systemctl status pisugar-server` — check PiSugar service |

## Course Documents

- `4.3 Raspberry Pi Payload Integrator_v2 - Copy.pptx` — Full lesson plan presentation
- `Slide1.JPG` through `Slide29.JPG` — Extracted slide images for reference
