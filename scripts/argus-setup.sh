#!/usr/bin/env bash
# Argus — One-script Raspberry Pi payload setup
# Installs everything needed for the Argus RF Survey payload.
#
# Usage: sudo bash scripts/argus-setup.sh [--skip-upgrade]
set -euo pipefail

# ── Parse command-line flags ────────────────────────────────
SKIP_UPGRADE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-upgrade) SKIP_UPGRADE=true; shift ;;
        *) echo "Unknown option: $1"; echo "Usage: argus-setup.sh [--skip-upgrade]"; exit 1 ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

ask() {
    local prompt="$1" default="${2:-Y}"
    local yn
    # Non-interactive mode: use the default answer
    if [ ! -t 0 ]; then
        [[ "$default" == "Y" ]]
        return
    fi
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
INSTALL_DIR="/opt/argus"
CONFIG_DIR="$INSTALL_DIR/config"

# Detect the real user (even when running under sudo)
if [ -n "${SUDO_USER:-}" ]; then
    ARGUS_USER="$SUDO_USER"
else
    ARGUS_USER="$(whoami)"
fi
ARGUS_HOME="$(eval echo ~"$ARGUS_USER")"

NEED_RELOGIN=false
SERIAL_DEVICES=()
SDR_FOUND=false

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  Argus — Raspberry Pi RF Survey Setup   ║"
echo "║                                        ║"
echo "╚════════════════════════════════════════╝"
echo ""
info "Repo:     $REPO_DIR"
info "Install:  $INSTALL_DIR"
info "User:     $ARGUS_USER ($ARGUS_HOME)"
echo ""

# ── Root check ───────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root. Use: sudo bash scripts/argus-setup.sh"
    exit 1
fi

# ── Initialize config ────────────────────────────────────────
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/argus.ini" ]; then
    if [ -f "$REPO_DIR/config/argus.ini.factory" ]; then
        cp "$REPO_DIR/config/argus.ini.factory" "$CONFIG_DIR/argus.ini"
        cp "$REPO_DIR/config/argus.ini.factory" "$CONFIG_DIR/argus.ini.factory"
        info "Config initialized from factory defaults"
    fi
fi

# Helper: read a config value from argus.ini (safe — no shell interpolation into Python)
cfg_get() {
    local section="$1" key="$2" default="${3:-}"
    local value
    value=$(ARGUS_CFG="$CONFIG_DIR/argus.ini" ARGUS_SEC="$section" ARGUS_KEY="$key" \
        python3 -c "
import configparser, os
c = configparser.ConfigParser()
c.read(os.environ['ARGUS_CFG'])
try:
    v = c.get(os.environ['ARGUS_SEC'], os.environ['ARGUS_KEY']).split(';')[0].strip()
    print(v)
except Exception:
    print('')
" 2>/dev/null || true)
    echo "${value:-$default}"
}

# Helper: write a config value to argus.ini (safe — no shell interpolation into Python)
cfg_set() {
    local section="$1" key="$2" value="$3"
    ARGUS_CFG="$CONFIG_DIR/argus.ini" ARGUS_SEC="$section" ARGUS_KEY="$key" ARGUS_VAL="$value" \
        python3 -c "
import configparser, os
c = configparser.ConfigParser()
c.read(os.environ['ARGUS_CFG'])
if not c.has_section(os.environ['ARGUS_SEC']):
    c.add_section(os.environ['ARGUS_SEC'])
c.set(os.environ['ARGUS_SEC'], os.environ['ARGUS_KEY'], os.environ['ARGUS_VAL'])
with open(os.environ['ARGUS_CFG'], 'w') as f:
    c.write(f)
" 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════
# Step 1/8: Preflight Checks
# ══════════════════════════════════════════════════════════════
info "Step 1/8: Preflight checks"
echo ""

# Detect OS — Kali Linux is the primary target
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [[ "${ID:-}" == "kali" ]]; then
        ok "Kali Linux detected ($PRETTY_NAME)"
    elif [[ "${ID:-}" == "raspbian" || "${ID:-}" == "debian" ]]; then
        warn "Raspberry Pi OS / Debian detected. Kali Linux ARM64 is recommended."
        warn "Some tools (gr-gsm, kalibrate, Kismet) may need manual installation."
        if ! ask "Continue with $PRETTY_NAME?" "Y"; then
            info "Flash Kali Linux ARM64 using RPi Imager, then re-run this script."
            exit 0
        fi
    else
        warn "Unknown OS: ${PRETTY_NAME:-unknown}. This script is designed for Kali Linux ARM64."
    fi
else
    warn "Cannot detect OS (no /etc/os-release)"
fi

# Check required tools
for cmd in python3 git curl; do
    if command -v "$cmd" >/dev/null 2>&1; then
        ok "$cmd is installed"
    else
        fail "$cmd is not installed — cannot continue"
        exit 1
    fi
done

# Check pip
if python3 -m pip --version >/dev/null 2>&1; then
    ok "pip is installed"
else
    warn "pip not found — will install"
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

# Check/add dialout group
if id -nG "$ARGUS_USER" | grep -qw dialout; then
    ok "User $ARGUS_USER is in dialout group"
else
    warn "Adding $ARGUS_USER to dialout group (takes effect after logout/login)"
    usermod -aG dialout "$ARGUS_USER"
    NEED_RELOGIN=true
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

# ══════════════════════════════════════════════════════════════
# Step 2/8: System Update & Base Packages
# ══════════════════════════════════════════════════════════════
info "Step 2/8: System update & base packages"
echo ""

apt-get update -y
if [ "$SKIP_UPGRADE" = true ]; then
    info "Skipping apt-get upgrade (--skip-upgrade flag set)"
else
    apt-get upgrade -y
fi
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
    curl \
    network-manager \
    modemmanager
ok "Base packages installed"

systemctl enable --now avahi-daemon 2>/dev/null || true
ok "Avahi mDNS daemon enabled and started"

# Set WiFi regulatory domain and ensure NM manages wlan0
WIFI_COUNTRY=$(cfg_get wifi country_code "US")
iw reg set "$WIFI_COUNTRY" 2>/dev/null || true
echo "REGDOMAIN=$WIFI_COUNTRY" > /etc/default/crda 2>/dev/null || true
echo "options cfg80211 ieee80211_regdom=$WIFI_COUNTRY" > /etc/modprobe.d/wifi-regdom.conf 2>/dev/null || true
mkdir -p /etc/NetworkManager/conf.d
printf '[device-wifi]\nmatch-device=interface-name:wlan0\nmanaged=1\n' > /etc/NetworkManager/conf.d/argus-wifi.conf
ok "WiFi regulatory domain set to $WIFI_COUNTRY, wlan0 managed by NetworkManager"
echo ""

# ══════════════════════════════════════════════════════════════
# Step 3/8: SDR Tools
# ══════════════════════════════════════════════════════════════
info "Step 3/8: SDR tools"
echo ""

apt-get install -y rtl-sdr librtlsdr0 rtl-433 2>/dev/null || {
    warn "Some SDR packages not available — may need manual install"
}
ok "RTL-SDR and rtl_433 installed"

# Blacklist kernel DVB modules (idempotent)
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

# ══════════════════════════════════════════════════════════════
# Step 4/8: Kismet Wireless Monitor
# ══════════════════════════════════════════════════════════════
info "Step 4/8: Kismet wireless monitor"
echo ""

if command -v kismet >/dev/null 2>&1; then
    ok "Kismet already installed ($(kismet --version 2>&1 | head -1))"
else
    # On Kali, Kismet is available in the default repos
    if [[ "${ID:-}" == "kali" ]]; then
        info "Installing Kismet from Kali repos..."
        DEBIAN_FRONTEND=noninteractive apt-get install -y kismet >/dev/null 2>&1
    else
        info "Adding Kismet repository..."
        CODENAME="$(lsb_release -cs 2>/dev/null || echo bookworm)"
        wget -O - https://www.kismetwireless.net/repos/kismet-release.gpg.key --quiet \
            | gpg --dearmor | tee /usr/share/keyrings/kismet-archive-keyring.gpg >/dev/null
        echo "deb [signed-by=/usr/share/keyrings/kismet-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://www.kismetwireless.net/repos/apt/release/${CODENAME} ${CODENAME} main" \
            > /etc/apt/sources.list.d/kismet.list
        apt-get update >/dev/null 2>&1
        info "Installing Kismet (this may take a few minutes)..."
        DEBIAN_FRONTEND=noninteractive apt-get install -y kismet >/dev/null 2>&1
    fi
    ok "Kismet installed"
fi

# Set Kismet credentials from config
KISMET_USER=$(cfg_get kismet user "kismet")
KISMET_PASS=$(cfg_get kismet pass "kismet")
mkdir -p /root/.kismet && chmod 700 /root/.kismet
echo -e "httpd_username=$KISMET_USER\nhttpd_password=$KISMET_PASS" > /root/.kismet/kismet_httpd.conf
chmod 600 /root/.kismet/kismet_httpd.conf
ok "Kismet credentials set ($KISMET_USER/***)"

# Generate kismet_site.conf dynamically from config
info "Generating Kismet site config from argus.ini..."
{
    echo "# Argus — Kismet site configuration"
    echo "# Generated by argus-setup.sh — edits will be overwritten on re-run"
    echo ""

    GPS_PORT=$(cfg_get gps serial_port "/dev/ttyUSB1")
    GPS_BAUD=$(cfg_get gps serial_baud "9600")
    echo "gps=serial:device=${GPS_PORT},name=gps,baud=${GPS_BAUD}"
    echo ""

    BT_SOURCE=$(cfg_get kismet source_bluetooth "hci0")
    WIFI_SOURCE=$(cfg_get kismet source_wifi "")
    RTL433_SOURCE=$(cfg_get kismet source_rtl433 "")
    ADSB_SOURCE=$(cfg_get kismet source_adsb "")

    if [ -n "$BT_SOURCE" ]; then
        echo "source=$BT_SOURCE"
    fi
    if [ -n "$WIFI_SOURCE" ]; then
        # WARNING: Using the onboard WiFi (wlan0) for Kismet monitor mode
        # disables all WiFi connectivity. Only set source_wifi if using an
        # external USB WiFi adapter dedicated to monitoring.
        echo "source=$WIFI_SOURCE"
    fi
    if [ -n "$RTL433_SOURCE" ]; then
        echo "source=$RTL433_SOURCE"
    fi
    if [ -n "$ADSB_SOURCE" ]; then
        echo "source=$ADSB_SOURCE"
    fi
} > /etc/kismet/kismet_site.conf
ok "Kismet site config generated"

# Add user to kismet group
if getent group kismet >/dev/null 2>&1; then
    if ! id -nG "$ARGUS_USER" | grep -qw kismet; then
        usermod -aG kismet "$ARGUS_USER"
        ok "Added $ARGUS_USER to kismet group"
    else
        ok "User $ARGUS_USER already in kismet group"
    fi
fi

echo ""

# ══════════════════════════════════════════════════════════════
# Step 5/8: LTE Modem & GPS
# ══════════════════════════════════════════════════════════════
info "Step 5/8: LTE modem & GPS configuration"
echo ""

# Check if modem is visible
MODEM_NUM=""
if mmcli -L 2>/dev/null | grep -q "/"; then
    MODEM_NUM=$(mmcli -L 2>/dev/null | grep -oP '/Modem/\K[0-9]+' | head -1)
    ok "LTE modem detected (modem $MODEM_NUM)"
else
    warn "No LTE modem detected — skip modem config (plug in SixFab hat and re-run)"
fi

if [ -n "$MODEM_NUM" ]; then
    # Check for existing connection
    EXISTING_CON=$(nmcli -t -f NAME con show 2>/dev/null | grep -i "argus-lte" || true)
    if [ -n "$EXISTING_CON" ]; then
        ok "LTE connection 'argus-lte' already configured"
    else
        # Read APN from config, prompt if blank
        APN=$(cfg_get lte apn "")

        if [ -z "$APN" ]; then
            if [ -t 0 ]; then
                # Interactive — prompt user
                echo ""
                echo "  Common APNs by carrier:"
                echo "    T-Mobile:  b2b.static"
                echo "    AT&T:      broadband"
                echo "    Verizon:   vzwinternet"
                echo "    FirstNet:  firstnet"
                echo ""
                read -rp "  Enter APN for your SIM card (or leave blank for auto-detect): " APN_INPUT
                APN="${APN_INPUT:-}"

                # Save APN to config for future reference
                if [ -n "$APN" ]; then
                    cfg_set lte apn "$APN"
                    info "APN '$APN' saved to config"
                fi
            else
                # Non-interactive — use auto-detect
                info "Non-interactive mode: using APN auto-detect"
                APN=""
            fi
        else
            info "Using APN from config: $APN"
        fi

        if [ -n "$APN" ]; then
            nmcli c add type gsm ifname '*' con-name "argus-lte" apn "$APN"
        else
            nmcli c add type gsm ifname '*' con-name "argus-lte"
        fi

        DNS=$(cfg_get lte dns "8.8.8.8,1.1.1.1")
        nmcli con mod "argus-lte" ipv4.method auto
        nmcli con mod "argus-lte" ipv4.dns "$DNS"
        ok "LTE connection configured (dynamic IP via DHCP)"
    fi

    # Try to bring up the connection
    if nmcli con up "argus-lte" 2>/dev/null; then
        ok "LTE connection active"
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

# Install GPS script
mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/gps_lte.py" "$INSTALL_DIR/gps_lte.py"
chmod +x "$INSTALL_DIR/gps_lte.py"
ok "GPS script installed to $INSTALL_DIR/gps_lte.py"

echo ""

# ══════════════════════════════════════════════════════════════
# Step 6/8: Tailscale & PiSugar
# ══════════════════════════════════════════════════════════════
info "Step 6/8: Tailscale & PiSugar"
echo ""

TS_IP=""

# Tailscale
TAILSCALE_ENABLED=$(cfg_get tailscale enabled "true")
if [ "$TAILSCALE_ENABLED" = "true" ]; then
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
        else
            info "Skipping Tailscale."
        fi
    fi
else
    info "Tailscale disabled in config — skipping"
fi

# PiSugar (optional — wrapped in subshell so failure doesn't kill the install)
PISUGAR_ENABLED=$(cfg_get pisugar enabled "true")
if [ "$PISUGAR_ENABLED" = "true" ]; then
    if systemctl is-active --quiet pisugar-server 2>/dev/null; then
        ok "PiSugar server already running"
    else
        if ask "Install PiSugar power manager?" "Y"; then
            (
                # Create raspi-config stub if missing (Kali doesn't ship it;
                # pisugar-poweroff postinst expects it)
                if ! command -v raspi-config >/dev/null 2>&1; then
                    info "Creating raspi-config stub for PiSugar compatibility"
                    cat > /usr/local/bin/raspi-config << 'STUB'
#!/bin/bash
# Stub for Kali Linux — PiSugar postinst expects this
exit 0
STUB
                    chmod +x /usr/local/bin/raspi-config
                fi

                # Pre-seed PiSugar model selection to avoid whiptail dialog
                echo "pisugar-server pisugar-server/model select PiSugar 2 (2-LEDs)" | debconf-set-selections 2>/dev/null || true
                export DEBIAN_FRONTEND=noninteractive

                info "Downloading PiSugar installer..."
                curl -fsSL https://cdn.pisugar.com/release/pisugar-power-manager.sh -o /tmp/pisugar-install.sh
                bash /tmp/pisugar-install.sh -c release

                unset DEBIAN_FRONTEND

                systemctl enable pisugar-server 2>/dev/null || true
                systemctl start pisugar-server 2>/dev/null || true
                rm -f /tmp/pisugar-install.sh
                ok "PiSugar power manager installed and running"
            ) || warn "PiSugar install failed — skipping (not critical)"
        else
            info "Skipping PiSugar setup."
        fi
    fi
else
    info "PiSugar disabled in config — skipping"
fi

echo ""

# ══════════════════════════════════════════════════════════════
# Step 7/8: Boot Services & Headless Setup
# ══════════════════════════════════════════════════════════════
info "Step 7/8: Boot services & headless setup"
echo ""

# Cellular recon tools (optional — wrapped so failure doesn't kill the install)
RECON_ENABLED=$(cfg_get recon_tools enabled "true")
if [ "$RECON_ENABLED" = "true" ]; then
    if ask "Install cellular recon tools (gr-gsm, kalibrate, GQRX, IMSI-catcher)?" "Y"; then
        (
            apt-get install -y gr-gsm kalibrate-rtl 2>/dev/null || {
                warn "gr-gsm/kalibrate-rtl not available — may need manual install"
            }
            apt-get install -y gqrx-sdr 2>/dev/null || {
                warn "gqrx-sdr not available"
            }

            IMSI_DIR="$ARGUS_HOME/IMSI-catcher"
            if [ -d "$IMSI_DIR" ]; then
                ok "IMSI-catcher already cloned at $IMSI_DIR"
            else
                git clone https://github.com/Oros42/IMSI-catcher.git "$IMSI_DIR"
                chown -R "$ARGUS_USER:$ARGUS_USER" "$IMSI_DIR"
                ok "IMSI-catcher cloned to $IMSI_DIR"
            fi
        ) || warn "Recon tools install failed — skipping (not critical)"
    fi
fi

# Install systemd service files
cp "$REPO_DIR/scripts/kismet.service" /etc/systemd/system/kismet.service
cp "$REPO_DIR/scripts/argus-boot.service" /etc/systemd/system/argus-boot.service

# Create updated dashboard service pointing to new argus package
cat > /etc/systemd/system/argus-dashboard.service <<SVCFILE
[Unit]
Description=Argus RF Survey Dashboard
After=kismet.service
Wants=kismet.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 -m argus
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCFILE

# Update paths in service files
sed -i "s|/opt/argus|$INSTALL_DIR|g" /etc/systemd/system/argus-boot.service

systemctl daemon-reload
systemctl enable kismet.service argus-boot.service argus-dashboard.service
ok "Services installed and enabled"
info "Boot order: argus-boot (GPS) → kismet → argus-dashboard"

echo ""

# ══════════════════════════════════════════════════════════════
# Step 8/8: Argus Dashboard
# ══════════════════════════════════════════════════════════════
info "Step 8/8: Argus Dashboard"
echo ""

# Install the argus Python package
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"
rsync -a --exclude='__pycache__' "$REPO_DIR/argus/" "$INSTALL_DIR/argus/"
cp "$REPO_DIR/profiles.json" "$INSTALL_DIR/profiles.json"
cp "$REPO_DIR/config/argus.ini.factory" "$CONFIG_DIR/argus.ini.factory"
ok "Dashboard files synced to $INSTALL_DIR"

# Verify all expected modules exist
EXPECTED_MODULES="server.py kismet.py oui.py logging_config.py"
MISSING=""
for mod in $EXPECTED_MODULES; do
    if [ ! -f "$INSTALL_DIR/argus/web/$mod" ]; then
        MISSING="$MISSING $mod"
    fi
done
if [ -n "$MISSING" ]; then
    warn "Missing modules in argus/web/:$MISSING"
else
    ok "All expected modules present"
fi

# Install Python dependencies from requirements.txt
if [ -f "$REPO_DIR/requirements.txt" ]; then
    pip3 install --break-system-packages -r "$REPO_DIR/requirements.txt" 2>/dev/null \
        || pip3 install -r "$REPO_DIR/requirements.txt"
else
    REQUIREMENTS="fastapi uvicorn requests jinja2"
    pip3 install --break-system-packages $REQUIREMENTS 2>/dev/null \
        || pip3 install $REQUIREMENTS
fi
ok "Dashboard dependencies installed"

# Verify critical imports
if python3 -c "import fastapi, uvicorn, requests, jinja2" 2>/dev/null; then
    ok "All Python dependencies verified"
else
    warn "Some Python dependencies failed to import — run: pip3 install -r requirements.txt"
fi

# Start the dashboard
systemctl restart argus-dashboard 2>/dev/null || true

# Determine access URLs
PI_IP="$(hostname -I | awk '{print $1}')"
TS_IP="${TS_IP:-$(tailscale ip -4 2>/dev/null || true)}"

ok "Argus Dashboard installed"
echo ""

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
echo "╔════════════════════════════════════════╗"
echo "║  Setup complete!                       ║"
echo "╚════════════════════════════════════════╝"
echo ""
info "Dashboard:      http://${PI_IP}:8080"
if [ -n "${TS_IP:-}" ]; then
    info "Dashboard (TS): http://${TS_IP}:8080"
    info "SSH (Tailscale): ssh $ARGUS_USER@$TS_IP"
fi
info "Kismet UI:      http://${PI_IP}:2501  ($KISMET_USER/***)"
echo ""
info "Config file:    $CONFIG_DIR/argus.ini"
info "Edit config:    http://${PI_IP}:8080 → Settings tab"
echo ""
info "Validate:       bash $REPO_DIR/scripts/argus-preflight.sh"
info "Headless setup: sudo bash $REPO_DIR/scripts/argus-headless.sh --help"
info "Services:       systemctl status kismet argus-dashboard argus-boot"
echo ""
info "Reboot the Pi to verify everything starts automatically."
echo ""
