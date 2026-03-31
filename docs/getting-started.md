# Getting Started — Instructor Setup Guide

## Prerequisites

| Component | Required | Notes |
|-----------|----------|-------|
| Raspberry Pi 4 (8GB) | Yes | 4GB works but 8GB recommended for full RF capture |
| SixFab LE910Cx LTE hat | Yes | Includes Telit modem for GPS + cellular |
| SIM card | Yes | Carrier-specific — set APN during setup |
| PiSugar 5000mAh battery | Yes | Powers the Pi during flight |
| Nooelec SMART RTL-SDR + antenna | Yes | 433 MHz / ADS-B reception |
| 128GB+ micro SD card | Yes | Kali + capture data |
| Laptop/computer | Yes | For initial SSH setup and flashing |
| USB WiFi adapter | Optional | Required for WiFi monitor mode while staying connected |

## Step 1: Assemble Hardware

Refer to course slides 8-11 for assembly photos.

1. Attach PiSugar battery to GPIO (align pins carefully).
2. Mount SixFab LTE hat with risers.
3. Insert SIM card into SixFab hat.
4. Connect LTE antennas.
5. Plug in Nooelec SDR via USB.
6. Insert prepared SD card.

![Hardware assembly](../images/hardware-assembly.png)
<!-- TODO: capture photo of assembled Pi payload -->

## Step 2: Flash Kali Linux

See [Image Strategy](image-strategy.md) for detailed instructions.

1. Download Kali Linux ARM64 for Pi from kali.org.
2. Flash to SD card with RPi Imager.
3. In Imager settings: set hostname, enable SSH, configure WiFi.

## Step 3: Run the Installer

```bash
ssh kali@<pi-ip>
git clone https://github.com/rmeadomavic/sorcc-pi.git
cd sorcc-pi
sudo bash scripts/sorcc-setup.sh
```

The installer takes ~15 minutes. It installs Kismet, SDR tools, GPS support,
and configures all systemd services.

## Step 4: Configure for Headless Operation

```bash
sudo bash scripts/sorcc-headless.sh --ssid "ClassroomWiFi" --password "s3cret"
```

After this, the Pi boots ready to fly — no monitor or keyboard needed.

## Step 5: Set a Dashboard Password

If students will access the dashboard over a shared or public network,
set a password to prevent unauthorized access.

1. Open the dashboard at `http://<pi-ip>:8080`.
2. Go to **Settings > Dashboard**.
3. Enter a password in the **Dashboard Password** field.
4. Click **Apply**.

Or edit the config directly:

```bash
nano /opt/sorcc/config/sorcc.ini
# Set [dashboard] password = your-password
sudo systemctl restart sorcc-dashboard
```

Leave `password` blank to allow open access (safe on Tailscale-only networks).

## Step 6: Verify

```bash
bash scripts/sorcc-preflight.sh
```

Or open the dashboard and check the **Preflight** tab. All checks should show green.

![Preflight tab](../images/preflight-tab.png)
<!-- TODO: capture screenshot of preflight tab with all checks passing -->

## Step 7: Access the Dashboard

| Method | URL |
|--------|-----|
| Local network | `http://<pi-ip>:8080` |
| mDNS | `http://sorcc-pi.local:8080` |
| Tailscale | `http://<tailscale-ip>:8080` |
| Instructor view | `http://<pi-ip>:8080/instructor` |

![Dashboard operations tab](../images/dashboard-operations.png)
<!-- TODO: capture screenshot of operations tab with device list -->
