#!/usr/bin/env bash
# SORCC-PI — Headless field-boot setup
# Configures the Pi for zero-touch operation: power on → dashboard available
#
# Usage: sudo bash scripts/sorcc-headless.sh --ssid "ClassroomWiFi" --password "s3cret"
set -euo pipefail

PASS=0; WARN=0; FAIL=0
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; WARN=$((WARN+1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

usage() {
    cat <<'EOF'
Usage: sorcc-headless.sh [OPTIONS]

Configure a SORCC Pi for headless field-boot mode. After running this script,
the Pi will boot to a running SORCC Dashboard with zero operator interaction —
just plug in power.

What this script does:
  1. Installs and configures Avahi (mDNS) for .local discovery
  2. Optionally persists a WiFi network via NetworkManager
  3. Enables systemd services (sorcc-boot → kismet → sorcc-dashboard)
  4. Verifies daemon auto-start configuration
  5. Runs a preflight self-test to verify the full boot chain

Options:
  --hostname NAME    mDNS hostname (default: sorcc-pi → reachable at sorcc-pi.local)
  --ssid SSID        WiFi network name to persist (optional)
  --password PASS    WiFi password (required if --ssid is given)
  --ethernet-only    Skip WiFi setup (Ethernet/LTE will be used)
  --no-enable        Do not enable boot services (just set up mDNS/WiFi)
  --noninteractive   Explicit non-interactive mode (no prompts, use defaults)
  -h, --help         Show this help message

Examples:
  # Full setup with WiFi
  sudo bash scripts/sorcc-headless.sh --ssid "ClassroomWiFi" --password "s3cret"

  # LTE-only (no WiFi needed — uses cellular for connectivity)
  sudo bash scripts/sorcc-headless.sh --ethernet-only

  # Custom hostname (reachable at sorcc-pi-03.local)
  sudo bash scripts/sorcc-headless.sh --hostname sorcc-pi-03 --ssid "FieldNet" --password "pw123"
EOF
    exit 0
}

# ── Defaults ──────────────────────────────────────────────────
MDNS_HOSTNAME="sorcc-pi"
WIFI_SSID=""
WIFI_PASSWORD=""
ETHERNET_ONLY=false
ENABLE_SERVICE=true
NONINTERACTIVE=false

# ── Parse arguments ──────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --hostname)      MDNS_HOSTNAME="$2"; shift 2 ;;
        --ssid)          WIFI_SSID="$2"; shift 2 ;;
        --password)      WIFI_PASSWORD="$2"; shift 2 ;;
        --ethernet-only) ETHERNET_ONLY=true; shift ;;
        --no-enable)     ENABLE_SERVICE=false; shift ;;
        --noninteractive) NONINTERACTIVE=true; shift ;;
        -h|--help)       usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

# ── Validate ──────────────────────────────────────────────────
if [ "$ETHERNET_ONLY" = false ] && [ -z "$WIFI_SSID" ]; then
    echo "Error: Provide --ssid and --password for WiFi, or use --ethernet-only."
    echo "Run with -h for usage."
    exit 1
fi

if [ -n "$WIFI_SSID" ] && [ -z "$WIFI_PASSWORD" ]; then
    echo "Error: --password is required when --ssid is given."
    exit 1
fi

if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root. Use: sudo bash scripts/sorcc-headless.sh"
    exit 1
fi

echo ""
echo "========================================"
echo "  SORCC-PI — Headless Field-Boot Setup"
echo "========================================"
echo ""

if [ "$NONINTERACTIVE" = true ]; then
    info "Running in non-interactive mode (--noninteractive)"
fi

# ── Step 1/5: mDNS (Avahi) ───────────────────────────────────
info "Step 1/5: Setting up mDNS (Avahi)..."
echo ""

if ! command -v avahi-daemon >/dev/null 2>&1; then
    info "Installing avahi-daemon..."
    apt-get update -qq && apt-get install -y -qq avahi-daemon avahi-utils
fi

if command -v avahi-daemon >/dev/null 2>&1; then
    ok "avahi-daemon is installed"
else
    fail "avahi-daemon installation failed"
    exit 1
fi

# Set hostname
hostnamectl set-hostname "$MDNS_HOSTNAME" 2>/dev/null || true

# Configure Avahi
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"
if [ -f "$AVAHI_CONF" ]; then
    if grep -q "^host-name=" "$AVAHI_CONF"; then
        sed -i "s/^host-name=.*/host-name=$MDNS_HOSTNAME/" "$AVAHI_CONF"
    elif grep -q "^\[server\]" "$AVAHI_CONF"; then
        sed -i "/^\[server\]/a host-name=$MDNS_HOSTNAME" "$AVAHI_CONF"
    fi
fi

# Publish the SORCC Dashboard as an mDNS service
mkdir -p /etc/avahi/services
cat > /etc/avahi/services/sorcc-dashboard.service <<AVAHI_SVC
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">SORCC Dashboard on %h</name>
  <service>
    <type>_http._tcp</type>
    <port>8080</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
AVAHI_SVC
ok "mDNS service file created for SORCC Dashboard"

systemctl enable --now avahi-daemon 2>/dev/null || true
systemctl restart avahi-daemon 2>/dev/null || true

if systemctl is-active --quiet avahi-daemon; then
    ok "avahi-daemon is running (hostname: $MDNS_HOSTNAME.local)"
else
    fail "avahi-daemon failed to start"
fi

echo ""

# ── Step 2/5: WiFi persistence ────────────────────────────────
info "Step 2/5: Network configuration..."
echo ""

if [ "$ETHERNET_ONLY" = true ]; then
    ok "Ethernet/LTE mode — skipping WiFi setup"
else
    if command -v nmcli >/dev/null 2>&1; then
        if nmcli connection show "$WIFI_SSID" >/dev/null 2>&1; then
            info "WiFi connection '$WIFI_SSID' already exists, updating..."
            nmcli connection modify "$WIFI_SSID" \
                wifi-sec.key-mgmt wpa-psk \
                wifi-sec.psk "$WIFI_PASSWORD" \
                connection.autoconnect yes \
                connection.autoconnect-priority 100
            ok "WiFi connection '$WIFI_SSID' updated"
        else
            info "Creating WiFi connection '$WIFI_SSID'..."
            nmcli connection add \
                type wifi \
                con-name "$WIFI_SSID" \
                ssid "$WIFI_SSID" \
                wifi-sec.key-mgmt wpa-psk \
                wifi-sec.psk "$WIFI_PASSWORD" \
                connection.autoconnect yes \
                connection.autoconnect-priority 100
            ok "WiFi connection '$WIFI_SSID' created"
        fi

        # Try to connect now
        nmcli connection up "$WIFI_SSID" 2>/dev/null && \
            ok "WiFi connected to '$WIFI_SSID'" || \
            warn "Could not connect to '$WIFI_SSID' now (will auto-connect on boot)"
    else
        fail "NetworkManager (nmcli) not found — cannot persist WiFi"
    fi
fi

echo ""

# ── Step 3/5: Enable SORCC services ──────────────────────────
info "Step 3/5: SORCC systemd services..."
echo ""

if [ "$ENABLE_SERVICE" = true ]; then
    SERVICES=(sorcc-boot kismet sorcc-dashboard)
    for svc in "${SERVICES[@]}"; do
        if [ -f "/etc/systemd/system/${svc}.service" ]; then
            systemctl enable "$svc" 2>/dev/null || true
            ok "$svc service enabled"
        else
            warn "$svc.service not found — run sorcc-setup.sh first"
        fi
    done
else
    ok "Skipping service enablement (--no-enable)"
fi

echo ""

# ── Step 4/5: Daemon auto-start ──────────────────────────────
info "Step 4/5: Daemon configuration..."
echo ""

# Ensure NetworkManager starts on boot (for LTE and WiFi)
systemctl enable NetworkManager 2>/dev/null || true
if systemctl is-enabled --quiet NetworkManager 2>/dev/null; then
    ok "NetworkManager enabled on boot"
else
    warn "NetworkManager not enabled"
fi

# Ensure ModemManager starts on boot (for LTE modem)
systemctl enable ModemManager 2>/dev/null || true
if systemctl is-enabled --quiet ModemManager 2>/dev/null; then
    ok "ModemManager enabled on boot"
else
    warn "ModemManager not enabled (LTE modem may not work on boot)"
fi

echo ""

# ── Step 5/5: Preflight self-test ────────────────────────────
info "Step 5/5: Preflight self-test (verifying headless boot chain)..."
echo ""

# Network connectivity
if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
    ok "Network connectivity verified"
else
    warn "No internet connectivity right now (may connect on next boot)"
fi

# mDNS self-resolution
if command -v avahi-resolve >/dev/null 2>&1; then
    SELF_IP="$(avahi-resolve -4 -n "$MDNS_HOSTNAME.local" 2>/dev/null | awk '{print $2}' || true)"
    if [ -n "$SELF_IP" ]; then
        ok "mDNS self-resolution works ($MDNS_HOSTNAME.local → $SELF_IP)"
    else
        warn "mDNS self-resolution failed (avahi may need a moment)"
    fi
else
    warn "avahi-resolve not available for self-test"
fi

# Service chain check
for svc in sorcc-boot kismet sorcc-dashboard; do
    if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        ok "$svc is enabled for boot"
    else
        warn "$svc is not enabled"
    fi
done

# Boot chain summary
echo ""
echo "  Boot chain:"
echo "    1. Power on → systemd starts"
echo "    2. NetworkManager → LTE modem connects"
if [ "$ETHERNET_ONLY" = false ]; then
    echo "    3. NetworkManager → WiFi connects to '$WIFI_SSID'"
else
    echo "    3. (WiFi skipped — using Ethernet/LTE only)"
fi
echo "    4. sorcc-boot.service → GPS init, Avahi startup"
echo "    5. kismet.service → wireless monitoring"
echo "    6. sorcc-dashboard.service → web UI on port 8080"
echo "    7. avahi-daemon → advertises $MDNS_HOSTNAME.local"
echo ""

# ── Summary ──────────────────────────────────────────────────
echo "========================================"
echo "Summary: PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
echo "========================================"
echo ""

if [ "$FAIL" -gt 0 ]; then
    fail "Some checks failed. Review the output above."
    exit 1
fi

echo "Headless mode is configured. On next power-on, open a browser to:"
echo ""
echo "    http://$MDNS_HOSTNAME.local:8080"
echo ""
