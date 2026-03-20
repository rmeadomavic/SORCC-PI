#!/usr/bin/env bash
# SORCC-PI — One-script Raspberry Pi payload setup
# Usage: sudo bash scripts/sorcc-setup.sh
set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

ask() {
    local prompt="$1" default="${2:-Y}"
    local yn
    if [[ "$default" == "Y" ]]; then
        read -rp "$prompt [Y/n]: " yn
        yn="${yn:-Y}"
    else
        read -rp "$prompt [y/N]: " yn
        yn="${yn:-N}"
    fi
    [[ "$yn" =~ ^[Yy] ]]
}

# ── Determine paths ──────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="/opt/sorcc"

# Detect the real user (even when running under sudo)
if [ -n "${SUDO_USER:-}" ]; then
    SORCC_USER="$SUDO_USER"
else
    SORCC_USER="$(whoami)"
fi
SORCC_HOME="$(eval echo ~"$SORCC_USER")"

NEED_RELOGIN=false
SERIAL_DEVICES=()
SDR_FOUND=false

echo ""
echo "========================================"
echo "  SORCC-PI — Raspberry Pi Payload Setup"
echo "========================================"
echo ""
info "Repo:     $REPO_DIR"
info "Install:  $INSTALL_DIR"
info "User:     $SORCC_USER ($SORCC_HOME)"
echo ""

# ── Root check ───────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root. Use: sudo bash scripts/sorcc-setup.sh"
    exit 1
fi

# ── Step 1/11: Preflight Checks ──────────────────────────────
info "Step 1/11: Preflight checks"
echo ""

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [[ "${ID:-}" == "raspbian" || "${ID:-}" == "debian" ]]; then
        ok "Raspberry Pi OS detected ($PRETTY_NAME)"
    elif [[ "${ID:-}" == "kali" ]]; then
        warn "Kali Linux detected. Raspberry Pi OS is recommended for stability."
        if ! ask "Continue with Kali?" "Y"; then
            info "Flash Raspberry Pi OS 64-bit using RPi Imager, then re-run this script."
            exit 0
        fi
    else
        warn "Unknown OS: ${PRETTY_NAME:-unknown}. Script designed for Raspberry Pi OS."
    fi
else
    warn "Cannot detect OS (no /etc/os-release)"
fi

# Check required tools
for cmd in python3 git curl; do
    if command -v "$cmd" >/dev/null 2>&1; then
        ok "$cmd is installed"
    else
        fail "$cmd is not installed"
        exit 1
    fi
done

# Check pip
if python3 -m pip --version >/dev/null 2>&1; then
    ok "pip is installed"
else
    warn "pip not found, will install"
fi

# Detect serial devices
for dev in /dev/ttyUSB* /dev/ttyACM*; do
    [ -e "$dev" ] && SERIAL_DEVICES+=("$dev")
done || true
if [ ${#SERIAL_DEVICES[@]} -gt 0 ]; then
    ok "Serial devices found: ${SERIAL_DEVICES[*]}"
else
    warn "No serial devices found (LTE modem may not be connected)"
fi

# Detect SDR
if lsusb 2>/dev/null | grep -q "0bda:2838"; then
    ok "RTL-SDR dongle detected (RTL2832U)"
    SDR_FOUND=true
elif lsusb 2>/dev/null | grep -qi "nooelec"; then
    ok "Nooelec SDR detected"
    SDR_FOUND=true
else
    warn "No SDR dongle detected (plug in the Nooelec SMART and re-run if needed)"
fi

# Check dialout group
if id -nG "$SORCC_USER" | grep -qw dialout; then
    ok "User $SORCC_USER is in dialout group"
else
    warn "User $SORCC_USER is NOT in dialout group (needed for serial/modem access)"
    usermod -aG dialout "$SORCC_USER"
    NEED_RELOGIN=true
    ok "Added $SORCC_USER to dialout group (takes effect after logout/login)"
fi

if [ "$NEED_RELOGIN" = true ]; then
    echo ""
    warn "Group changes require logout/login to take effect."
    if ! ask "Continue anyway?" "Y"; then
        info "Re-run this script after logging out and back in."
        exit 0
    fi
fi

echo ""

# ── Step 2/11: System Update & Base Packages ─────────────────
info "Step 2/11: System update & base packages"
echo ""

apt-get update -y
apt-get upgrade -y
apt-get install -y \
    build-essential \
    cmake \
    libusb-1.0-0-dev \
    pkg-config \
    python3-pip \
    python3-serial \
    python3-venv \
    avahi-daemon \
    avahi-utils \
    sox \
    minicom \
    git \
    curl
ok "Base packages installed"
echo ""

# ── Step 3/11: SDR Tools ────────────────────────────────────
info "Step 3/11: SDR tools"
echo ""

apt-get install -y rtl-sdr librtlsdr0 rtl-433 2>/dev/null || {
    warn "Some SDR packages not available in default repos — installing from source may be needed"
}
ok "RTL-SDR and rtl_433 installed"

# Blacklist kernel DVB modules that conflict with SDR (idempotent)
BLACKLIST_FILE="/etc/modprobe.d/blacklist-rtlsdr.conf"
if [ ! -f "$BLACKLIST_FILE" ]; then
    cat > "$BLACKLIST_FILE" <<'MODCONF'
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
MODCONF
    update-initramfs -u 2>/dev/null || true
    ok "Kernel DVB modules blacklisted for SDR"
else
    ok "SDR kernel module blacklist already in place"
fi

# Udev rules for non-root SDR access (idempotent)
UDEV_FILE="/etc/udev/rules.d/20-rtlsdr.rules"
if [ ! -f "$UDEV_FILE" ]; then
    echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666"' \
        > "$UDEV_FILE"
    udevadm control --reload-rules && udevadm trigger
    ok "Udev rules installed for RTL-SDR"
else
    ok "SDR udev rules already present"
fi

echo ""

# ── Step 4/11: Kismet ────────────────────────────────────────
info "Step 4/11: Kismet wireless monitor"
echo ""

if command -v kismet >/dev/null 2>&1; then
    ok "Kismet already installed ($(kismet --version 2>&1 | head -1))"
else
    info "Adding Kismet repository..."

    # Determine distro codename for the Kismet repo
    CODENAME="$(lsb_release -cs 2>/dev/null || echo bookworm)"

    wget -O - https://www.kismetwireless.net/repos/kismet-release.gpg.key --quiet \
        | gpg --dearmor | tee /usr/share/keyrings/kismet-archive-keyring.gpg >/dev/null

    echo "deb [signed-by=/usr/share/keyrings/kismet-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://www.kismetwireless.net/repos/apt/release/${CODENAME} ${CODENAME} main" \
        > /etc/apt/sources.list.d/kismet.list

    apt-get update >/dev/null 2>&1
    info "Installing Kismet (this may take a few minutes)..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y kismet >/dev/null 2>&1
    ok "Kismet installed ($(kismet --version 2>&1 | head -1))"
fi

# Set Kismet credentials
mkdir -p /root/.kismet
echo -e "httpd_username=kismet\nhttpd_password=kismet" > /root/.kismet/kismet_httpd.conf
ok "Kismet credentials set (kismet/kismet)"

# Install site config
cp "$REPO_DIR/config/kismet_site.conf" /etc/kismet/kismet_site.conf
ok "Kismet site config installed"

# Add user to kismet group
if getent group kismet >/dev/null 2>&1; then
    if ! id -nG "$SORCC_USER" | grep -qw kismet; then
        usermod -aG kismet "$SORCC_USER"
        ok "Added $SORCC_USER to kismet group"
    else
        ok "User $SORCC_USER already in kismet group"
    fi
fi

echo ""

# ── Step 5/11: LTE Modem ────────────────────────────────────
info "Step 5/11: LTE modem configuration"
echo ""

apt-get install -y modemmanager network-manager >/dev/null 2>&1
ok "ModemManager and NetworkManager installed"

# Check if modem is visible
MODEM_NUM=""
if mmcli -L 2>/dev/null | grep -q "/"; then
    MODEM_NUM=$(mmcli -L 2>/dev/null | grep -oP '/Modem/\K[0-9]+' | head -1)
    ok "LTE modem detected (modem $MODEM_NUM)"
else
    warn "No LTE modem detected — skip modem config (plug in SixFab hat and re-run)"
fi

if [ -n "$MODEM_NUM" ]; then
    # Configure NetworkManager GSM connection with dynamic IP
    EXISTING_CON=$(nmcli -t -f NAME con show 2>/dev/null | grep -i "sorcc-lte" || true)
    if [ -n "$EXISTING_CON" ]; then
        ok "LTE connection 'sorcc-lte' already configured"
    else
        read -rp "Enter APN for your SIM card (leave blank for auto-detect): " APN_INPUT
        APN="${APN_INPUT:-}"

        if [ -n "$APN" ]; then
            nmcli c add type gsm ifname '*' con-name "sorcc-lte" apn "$APN"
        else
            nmcli c add type gsm ifname '*' con-name "sorcc-lte"
        fi
        # Use DHCP (dynamic IP)
        nmcli con mod "sorcc-lte" ipv4.method auto
        nmcli con mod "sorcc-lte" ipv4.dns "8.8.8.8,1.1.1.1"
        ok "LTE connection configured (dynamic IP via DHCP)"
    fi

    # Try to bring up the connection
    if nmcli con up "sorcc-lte" 2>/dev/null; then
        ok "LTE connection active"
        # Quick connectivity test
        if ping -c 2 -W 5 8.8.8.8 >/dev/null 2>&1; then
            ok "Internet connectivity verified"
        else
            warn "LTE connected but no internet — check SIM card and APN"
        fi
    else
        warn "Could not activate LTE connection — may need SIM card or correct APN"
    fi

    # Enable GPS on modem
    mmcli -m "$MODEM_NUM" --location-enable-gps-nmea 2>/dev/null || true
    mmcli -m "$MODEM_NUM" --location-enable-gps-raw 2>/dev/null || true
    ok "GPS enabled on LTE modem"
fi

echo ""

# ── Step 6/11: GPS ───────────────────────────────────────────
info "Step 6/11: GPS configuration"
echo ""

# Install the GPS script
mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/gps_lte.py" "$INSTALL_DIR/gps_lte.py"
chmod +x "$INSTALL_DIR/gps_lte.py"
ok "GPS script installed to $INSTALL_DIR/gps_lte.py"

# Try to enable GPS NMEA output
if python3 "$INSTALL_DIR/gps_lte.py" 2>/dev/null; then
    ok "GPS NMEA output enabled"
else
    warn "Could not enable GPS — modem may not be connected or GPS needs time to acquire"
fi

echo ""

# ── Step 7/11: Tailscale (Optional) ─────────────────────────
info "Step 7/11: Tailscale remote access"
echo ""

if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null || true)"
    if [ -n "$TS_IP" ]; then
        ok "Tailscale already running ($TS_IP)"
    else
        info "Tailscale is installed but not connected."
        if ask "Connect Tailscale now?" "Y"; then
            tailscale up
            TS_IP="$(tailscale ip -4 2>/dev/null || true)"
            tailscale set --ssh
            ok "Tailscale connected ($TS_IP) with SSH enabled"
        fi
    fi
else
    if ask "Set up Tailscale for remote SSH access?" "Y"; then
        info "Installing Tailscale..."
        curl -fsSL https://tailscale.com/install.sh | sh
        info "Starting Tailscale — follow the auth URL in your browser..."
        tailscale up
        tailscale set --ssh
        TS_IP="$(tailscale ip -4 2>/dev/null || true)"
        ok "Tailscale connected ($TS_IP) with SSH enabled"
        info "SSH from another machine: ssh $SORCC_USER@$TS_IP"
    else
        info "Skipping Tailscale."
    fi
fi

echo ""

# ── Step 8/11: PiSugar Battery ───────────────────────────────
info "Step 8/11: PiSugar battery manager"
echo ""

if systemctl is-active --quiet pisugar-server 2>/dev/null; then
    ok "PiSugar server already running"
else
    if ask "Install PiSugar power manager?" "Y"; then
        info "Downloading PiSugar installer..."
        curl -fsSL https://cdn.pisugar.com/release/pisugar-power-manager.sh -o /tmp/pisugar-install.sh
        bash /tmp/pisugar-install.sh -c release
        systemctl enable pisugar-server 2>/dev/null || true
        systemctl start pisugar-server 2>/dev/null || true
        rm -f /tmp/pisugar-install.sh
        ok "PiSugar power manager installed and running"
    else
        info "Skipping PiSugar setup."
    fi
fi

echo ""

# ── Step 9/11: Cellular Recon Tools ──────────────────────────
info "Step 9/11: Cellular recon tools (gr-gsm, kalibrate, IMSI-catcher)"
echo ""

# Install gr-gsm and kalibrate-rtl
apt-get install -y gr-gsm kalibrate-rtl 2>/dev/null || {
    warn "gr-gsm/kalibrate-rtl not in default repos — may need manual install on RPi OS"
    info "These tools are used for the cellular reconnaissance demo (instructor-led)"
}

# GQRX for radio recording
apt-get install -y gqrx-sdr 2>/dev/null || {
    warn "gqrx-sdr not available — install manually if needed for RF recording exercises"
}

# Clone IMSI-catcher (idempotent)
IMSI_DIR="$SORCC_HOME/IMSI-catcher"
if [ -d "$IMSI_DIR" ]; then
    ok "IMSI-catcher already cloned at $IMSI_DIR"
else
    git clone https://github.com/Oros42/IMSI-catcher.git "$IMSI_DIR"
    chown -R "$SORCC_USER:$SORCC_USER" "$IMSI_DIR"
    ok "IMSI-catcher cloned to $IMSI_DIR"
fi

echo ""

# ── Step 10/11: Boot Services ────────────────────────────────
info "Step 10/11: Systemd boot services"
echo ""

# Install service files
cp "$REPO_DIR/scripts/kismet.service" /etc/systemd/system/kismet.service
cp "$REPO_DIR/scripts/sorcc-boot.service" /etc/systemd/system/sorcc-boot.service
cp "$REPO_DIR/dashboard/sorcc-dashboard.service" /etc/systemd/system/sorcc-dashboard.service

# Update the user-specific paths in service files
sed -i "s|/opt/sorcc|$INSTALL_DIR|g" /etc/systemd/system/sorcc-boot.service
sed -i "s|/opt/sorcc|$INSTALL_DIR|g" /etc/systemd/system/sorcc-dashboard.service

systemctl daemon-reload
systemctl enable kismet.service sorcc-boot.service sorcc-dashboard.service
ok "Services installed and enabled (kismet, sorcc-boot, sorcc-dashboard)"
info "Boot order: sorcc-boot (GPS) → kismet → sorcc-dashboard"

echo ""

# ── Step 11/11: SORCC Dashboard ──────────────────────────────
info "Step 11/11: SORCC Dashboard"
echo ""

# Install dashboard files
mkdir -p "$INSTALL_DIR/dashboard"
cp -r "$REPO_DIR/dashboard/"* "$INSTALL_DIR/dashboard/"

# Install Python dependencies
pip3 install --break-system-packages -r "$INSTALL_DIR/dashboard/requirements.txt" 2>/dev/null \
    || pip3 install -r "$INSTALL_DIR/dashboard/requirements.txt"
ok "Dashboard dependencies installed"

# Start the dashboard
systemctl start sorcc-dashboard 2>/dev/null || true

# Determine access URLs
PI_IP="$(hostname -I | awk '{print $1}')"
TS_IP="${TS_IP:-$(tailscale ip -4 2>/dev/null || true)}"

ok "SORCC Dashboard installed"
echo ""

# ── Summary ──────────────────────────────────────────────────
echo "========================================"
echo "  Setup complete!"
echo "========================================"
echo ""
info "Dashboard:      http://${PI_IP}:8080"
if [ -n "${TS_IP:-}" ]; then
    info "Dashboard (TS):  http://${TS_IP}:8080"
    info "SSH (Tailscale): ssh $SORCC_USER@$TS_IP"
fi
info "Kismet UI:       http://${PI_IP}:2501  (kismet/kismet)"
echo ""
info "Validate install: bash $REPO_DIR/scripts/sorcc-preflight.sh"
info "View services:    systemctl status kismet sorcc-dashboard sorcc-boot"
echo ""
info "Reboot the Pi to verify everything starts automatically."
echo ""
