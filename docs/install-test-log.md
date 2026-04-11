# Argus Install Test Log

## Test Environment
- **Date:** 2026-03-30
- **Device:** Raspberry Pi 4 8GB
- **OS:** Kali GNU/Linux 2026.1 Rolling (aarch64)
- **Kernel:** 6.12.34+rpt-rpi-v8
- **Python:** 3.13.12
- **Hardware connected:** SixFab LE910Cx LTE hat (5 serial ports detected), Bluetooth hci0. NO SDR dongle, NO PiSugar battery.
- **Network:** WiFi + Tailscale (100.71.115.45)
- **Branch:** claude/setup-argus-pi-qxVWN
- **Goal:** Document every issue for one-click refinement

## Pre-Install State
- No `/opt/argus` directory
- Kismet already installed (Kali default repos: 2025.09.0-b5d5a2d04)
- Tailscale already running
- No argus systemd services

---

## Install Run #1

**Command:** `yes | sudo bash scripts/argus-setup.sh 2>&1 | tee /tmp/argus-install-run1.log`
**Result:** PARTIAL FAILURE — PiSugar whiptail dialog crashed, killing Steps 7+8

### Step 1/8: Preflight Checks — PASS
- Kali Linux detected
- python3, git, curl, pip all present
- Serial devices found: /dev/ttyUSB0-4 (SixFab modem)
- WARN: No SDR dongle (expected — not plugged in)
- User kali already in dialout group

### Step 2/8: System Update & Base Packages — PASS (SLOW)
- `apt-get upgrade -y` upgraded 333 packages
- **This took ~15 minutes on Pi 4** — biggest bottleneck
- All base packages installed successfully

### Step 3/8: SDR Tools — PASS
- rtl-sdr, librtlsdr0, rtl-433 installed
- Kernel DVB modules blacklisted
- Udev rules created for non-root SDR access

### Step 4/8: Kismet — PASS
- Already installed from Kali repos (skipped download)
- Credentials set (kismet/kismet)
- kismet_site.conf generated from argus.ini
- User kali added to kismet group

### Step 5/8: LTE Modem & GPS — PASS (with bug)
- LTE modem detected (modem 0)
- **BUG: APN prompt received "y" from `yes` pipe** — APN was set to literal "y" instead of being left blank for auto-detect
- LTE connection configured and activated
- Internet connectivity verified (ping 8.8.8.8)
- GPS enabled on modem
- GPS script installed to /opt/argus/

### Step 6/8: Tailscale & PiSugar — **FAILED**
- Tailscale: Already running, PASS (100.71.115.45)
- **PiSugar: BLOCKER** — `bash /tmp/pisugar-install.sh -c release` downloads .deb packages and `dpkg -i` them. The pisugar-server package runs `whiptail` during postinst to ask for PiSugar model selection. whiptail requires a real terminal — fails with "Failed to open terminal" in non-interactive (piped) mode.
- `dpkg: error processing package pisugar-server (--install)` — exit code 255
- `dpkg: error processing package pisugar-poweroff (--install)` — also fails (also uses whiptail)
- pisugar-poweroff postinst also calls `raspi-config` which doesn't exist on Kali
- **`set -euo pipefail` caused the entire script to abort here**

### Step 7/8: Boot Services — NEVER RAN
- Skipped due to Step 6 failure

### Step 8/8: Dashboard — NEVER RAN
- Skipped due to Step 6 failure

---

## Manual Recovery

After the failed run, Steps 7+8 were executed manually:

1. Fixed PiSugar: `sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a` — packages configured successfully
2. Fixed APN: Cleared the "y" value back to empty string
3. Copied service files and enabled services manually
4. Installed dashboard to /opt/argus and installed Python deps
5. `pip3 install --break-system-packages fastapi` hit a `starlette` conflict — Kali ships starlette 0.50.0 as a system package, pip can't upgrade it. FastAPI 0.118.0 still works with it.
6. Started and verified dashboard: HTTP 200 on port 8080
7. Enabled and started avahi-daemon (wasn't enabled by default on this Kali install)
8. Enabled and started pisugar-server

## Post-Install Preflight Results

| Check | Status | Detail |
|-------|--------|--------|
| RTL-SDR | WARN | No dongle plugged in (expected) |
| Serial Devices | PASS | 5 devices present |
| Bluetooth | PASS | hci0 present |
| PiSugar | PASS | Running (after manual fix) |
| Dialout Group | PASS | kali in dialout |
| Kismet Service | WARN | Enabled, not running (needs reboot) |
| Argus Boot Service | WARN | Enabled, not running (needs reboot) |
| Argus Dashboard | PASS | Responding on 8080 |
| Avahi mDNS | PASS | Running (after manual fix) |
| LTE Modem | PASS | Detected |
| Internet | PASS | Connectivity OK |
| Tailscale | PASS | Connected (100.71.115.45) |
| Kismet Config | PASS | Site config exists |
| Kismet Credentials | PASS | Configured |
| Kismet Web UI | WARN | Not responding (not started yet) |
| argus.ini | PASS | Exists |
| GPS Script | PASS | Installed |

**Final: PASS=13, WARN=4, FAIL=0** (after manual fixes)

---

## Issues to Fix for One-Click

### BLOCKER: PiSugar whiptail dialog (P0)
- **Problem:** PiSugar installer uses interactive whiptail TUI for model selection
- **Fix:** Pre-seed debconf before install: `echo "pisugar-server pisugar-server/model select PiSugar 2 (2-LEDs)" | sudo debconf-set-selections` then install with `DEBIAN_FRONTEND=noninteractive`
- **Also:** pisugar-poweroff calls `raspi-config` which doesn't exist on Kali — need to handle gracefully

### HIGH: Script aborts on non-critical failure (P1)
- **Problem:** `set -euo pipefail` kills the entire install if PiSugar (optional) fails
- **Fix:** Wrap optional components (PiSugar, recon tools) in subshells or trap errors: `(install_pisugar) || warn "PiSugar install failed"`

### HIGH: APN prompt doesn't work headlessly (P1)
- **Problem:** Interactive `read` prompt gets garbage when piped
- **Fix:** Add `--noninteractive` flag to installer. If APN is empty and noninteractive, skip the prompt and use auto-detect. Check `[ -t 0 ]` to detect if stdin is a terminal.

### MEDIUM: apt-get upgrade is slow and risky (P2)
- **Problem:** Full system upgrade takes 15+ min and could break things
- **Fix:** Change to `apt-get install -y` only (skip upgrade), or add `--skip-upgrade` flag

### MEDIUM: starlette pip conflict (P2)
- **Problem:** Kali ships starlette as system package, pip can't upgrade
- **Fix:** Use `--break-system-packages` (already done) but also pin compatible versions, or use a venv

### LOW: Avahi not enabled by default (P3)
- **Problem:** Avahi daemon was installed but not enabled/started
- **Fix:** Add `systemctl enable --now avahi-daemon` to Step 2

### LOW: raspi-config missing on Kali (P3)
- **Problem:** pisugar-poweroff postinst expects raspi-config
- **Fix:** Install `raspi-config` or create a stub, or pre-configure debconf

---

## Timing (approximate)
| Step | Duration |
|------|----------|
| Step 1: Preflight | ~5 sec |
| Step 2: apt upgrade + packages | ~15 min |
| Step 3: SDR tools | ~30 sec |
| Step 4: Kismet | ~10 sec (already installed) |
| Step 5: LTE/GPS | ~15 sec |
| Step 6: Tailscale + PiSugar | ~2 min |
| Step 7: Services | ~5 sec |
| Step 8: Dashboard | ~30 sec |
| **Total (if no upgrade):** | **~4 min** |
| **Total (with upgrade):** | **~19 min** |
