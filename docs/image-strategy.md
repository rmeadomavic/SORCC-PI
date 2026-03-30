# Image Strategy: Stock Kali + Setup Script

## Decision

Use the official **Kali Linux ARM64** image for Raspberry Pi 4, flashed with
RPi Imager, then run `sudo bash scripts/sorcc-setup.sh` for all customization.

## Rationale

1. **Kali ARM images are official and well-maintained** — regular releases,
   security updates, tested on Pi 4 hardware
2. **Custom pre-baked images add maintenance burden** — must rebuild for every
   Kali release; difficult for students/instructors to flash with RPi Imager
3. **The setup script handles all customization** — and is idempotent, so it can
   be re-run safely after OS updates
4. **APN must be configurable per-SIM** — cannot bake a carrier-specific APN into
   a base image since deployments use different carriers
5. **Matches Hydra's pattern** — the Jetson project uses the same approach (stock
   L4T image + setup script) and it works well in practice

## Flashing Instructions

1. Download **Kali Linux ARM64** for Raspberry Pi from
   [kali.org/get-kali/#kali-arm](https://kali.org/get-kali/#kali-arm)
2. Open **Raspberry Pi Imager** (or Balena Etcher)
3. Select the downloaded Kali image
4. Select the target SD card (128GB+ recommended)
5. In RPi Imager settings, configure:
   - Hostname (e.g., `sorcc-pi-01`)
   - WiFi credentials (if applicable)
   - Enable SSH
   - Set timezone
6. Flash the SD card
7. Insert into Pi, power on, SSH in
8. Clone the repo and run the installer:

```bash
git clone https://github.com/rmeadomavic/sorcc-pi.git
cd sorcc-pi
sudo bash scripts/sorcc-setup.sh
```

## Alternative: Pre-baked Image (Not Recommended)

Using `kali-arm-build-scripts` to create a custom `.img`:
- Pros: Zero setup time for students, everything pre-installed
- Cons: Must rebuild per Kali release, hard to flash with RPi Imager,
  can't customize APN/hostname at flash time, large image files to distribute

This approach may be revisited if the course needs to scale to many more devices
where the 15-minute setup time becomes a bottleneck.
