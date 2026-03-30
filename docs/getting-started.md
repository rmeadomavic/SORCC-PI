# Getting Started — Instructor Setup Guide

## Prerequisites

- Raspberry Pi 4 (8GB recommended)
- SixFab LE910Cx LTE hat with SIM card
- PiSugar 5000mAh battery
- Nooelec SMART RTL-SDR dongle with antenna
- 128GB+ micro SD card
- Laptop/computer for initial setup

## Step 1: Assemble Hardware

Refer to course slides 8-11 for assembly:

1. Attach PiSugar battery to GPIO (align pins carefully)
2. Mount SixFab LTE hat with risers
3. Insert SIM card into SixFab hat
4. Connect LTE antennas
5. Plug in Nooelec SDR via USB
6. Insert prepared SD card

## Step 2: Flash Kali Linux

See [Image Strategy](image-strategy.md) for detailed flashing instructions.

Quick version:
1. Download Kali Linux ARM64 for Pi from kali.org
2. Flash to SD card with RPi Imager
3. Enable SSH, set hostname, configure WiFi in Imager settings

## Step 3: Run the Installer

```bash
ssh kali@<pi-ip>
git clone https://github.com/rmeadomavic/sorcc-pi.git
cd sorcc-pi
sudo bash scripts/sorcc-setup.sh
```

## Step 4: Configure for Headless Operation

```bash
sudo bash scripts/sorcc-headless.sh --ssid "ClassroomWiFi" --password "s3cret"
```

## Step 5: Verify

```bash
bash scripts/sorcc-preflight.sh
```

Or open the dashboard at `http://<pi-ip>:8080` and check the Preflight tab.

## Step 6: Access the Dashboard

- **Local:** `http://<pi-ip>:8080`
- **mDNS:** `http://sorcc-pi.local:8080`
- **Tailscale:** `http://<tailscale-ip>:8080`
- **Instructor view:** `http://<pi-ip>:8080/instructor`
