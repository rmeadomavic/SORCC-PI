#!/usr/bin/env bash
# SORCC-PI — Post-install validation
# Usage: bash scripts/sorcc-preflight.sh
set -euo pipefail

PASS=0
WARN=0
FAIL=0

ok()   { echo -e "\033[0;32m[PASS]\033[0m $1"; PASS=$((PASS+1)); }
warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; WARN=$((WARN+1)); }
fail() { echo -e "\033[0;31m[FAIL]\033[0m $1"; FAIL=$((FAIL+1)); }

check_cmd() {
    local cmd="$1" label="$2"
    if command -v "$cmd" >/dev/null 2>&1; then
        ok "$label"
    else
        fail "$label (command not found: $cmd)"
    fi
}

check_service() {
    local svc="$1" label="$2"
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        ok "$label"
    elif systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        warn "$label (enabled but not running — may need reboot)"
    else
        fail "$label (not installed or not enabled)"
    fi
}

echo "SORCC-PI Preflight Check"
echo "========================"
echo ""

# ── Tools ────────────────────────────────────────────────────
echo "-- Tools --"
check_cmd python3 "python3 is installed"
check_cmd kismet "Kismet is installed"
check_cmd rtl_test "rtl-sdr tools installed"
check_cmd mmcli "ModemManager CLI installed"
check_cmd nmcli "NetworkManager CLI installed"
check_cmd gqrx "GQRX SDR installed"

if python3 -m pip --version >/dev/null 2>&1; then
    ok "pip is installed"
else
    fail "pip is not installed"
fi

echo ""

# ── Hardware ─────────────────────────────────────────────────
echo "-- Hardware --"

# SDR
if lsusb 2>/dev/null | grep -q "0bda:2838"; then
    ok "RTL-SDR dongle detected"
elif lsusb 2>/dev/null | grep -qi "nooelec"; then
    ok "Nooelec SDR detected"
else
    warn "No SDR dongle detected (plug in the Nooelec SMART)"
fi

# Serial devices
SERIAL_FOUND=false
for dev in /dev/ttyUSB*; do
    if [ -e "$dev" ]; then
        SERIAL_FOUND=true
        break
    fi
done
if [ "$SERIAL_FOUND" = true ]; then
    ok "Serial devices present ($(ls /dev/ttyUSB* 2>/dev/null | tr '\n' ' '))"
else
    warn "No /dev/ttyUSB* devices found (LTE modem may not be connected)"
fi

# Bluetooth
if [ -e /sys/class/bluetooth/hci0 ]; then
    ok "Bluetooth adapter (hci0) present"
else
    warn "No Bluetooth adapter found"
fi

# User groups
SORCC_USER="${SUDO_USER:-$(whoami)}"
if id -nG "$SORCC_USER" | grep -qw dialout; then
    ok "User $SORCC_USER in dialout group"
else
    warn "User $SORCC_USER NOT in dialout group. Run: sudo usermod -aG dialout $SORCC_USER"
fi

echo ""

# ── Services ─────────────────────────────────────────────────
echo "-- Services --"
check_service kismet "Kismet service"
check_service sorcc-boot "SORCC boot service"
check_service sorcc-dashboard "SORCC dashboard service"
check_service avahi-daemon "Avahi mDNS"

if systemctl is-active --quiet pisugar-server 2>/dev/null; then
    ok "PiSugar server running"
else
    warn "PiSugar server not running (battery monitoring unavailable)"
fi

echo ""

# ── Network ──────────────────────────────────────────────────
echo "-- Network --"

# LTE modem
if mmcli -L 2>/dev/null | grep -q "/"; then
    ok "LTE modem detected by ModemManager"
else
    warn "LTE modem not detected"
fi

# Internet connectivity
if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
    ok "Internet connectivity (ping 8.8.8.8)"
else
    warn "No internet connectivity"
fi

# Tailscale
if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null || true)"
    if [ -n "$TS_IP" ]; then
        ok "Tailscale connected ($TS_IP)"
    else
        warn "Tailscale installed but not connected"
    fi
else
    warn "Tailscale not installed (remote access unavailable)"
fi

echo ""

# ── Kismet ───────────────────────────────────────────────────
echo "-- Kismet --"

if [ -f /etc/kismet/kismet_site.conf ]; then
    ok "Kismet site config exists"
else
    fail "Kismet site config missing (/etc/kismet/kismet_site.conf)"
fi

if [ -f /root/.kismet/kismet_httpd.conf ]; then
    ok "Kismet credentials configured"
else
    warn "Kismet credentials not set (/root/.kismet/kismet_httpd.conf)"
fi

# Check if Kismet web UI responds
if curl -s -o /dev/null -w "%{http_code}" http://localhost:2501/ 2>/dev/null | grep -q "200\|401"; then
    ok "Kismet web UI responding on port 2501"
else
    warn "Kismet web UI not responding (service may not be running)"
fi

echo ""

# ── Dashboard ────────────────────────────────────────────────
echo "-- Dashboard --"

if [ -f /opt/sorcc/dashboard/app.py ]; then
    ok "Dashboard app installed"
else
    fail "Dashboard app not found (/opt/sorcc/dashboard/app.py)"
fi

if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ 2>/dev/null | grep -q "200"; then
    ok "SORCC Dashboard responding on port 8080"
else
    warn "SORCC Dashboard not responding on port 8080"
fi

echo ""

# ── GPS ──────────────────────────────────────────────────────
echo "-- GPS --"

if [ -f /opt/sorcc/gps_lte.py ]; then
    ok "GPS script installed"
else
    fail "GPS script not found (/opt/sorcc/gps_lte.py)"
fi

echo ""

# ── Cellular Recon ───────────────────────────────────────────
echo "-- Cellular Recon Tools --"
check_cmd grgsm_livemon "gr-gsm (grgsm_livemon)"
check_cmd kal "kalibrate-rtl (kal)"

SORCC_HOME="$(eval echo ~"$SORCC_USER")"
if [ -d "$SORCC_HOME/IMSI-catcher" ]; then
    ok "IMSI-catcher cloned"
else
    warn "IMSI-catcher not found at $SORCC_HOME/IMSI-catcher"
fi

echo ""

# ── Summary ──────────────────────────────────────────────────
echo "========================"
echo "Summary: PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "Some checks FAILED. Review the output above and re-run sorcc-setup.sh."
    exit 1
elif [ "$WARN" -gt 0 ]; then
    echo "All critical checks passed. Some warnings — review above."
    exit 0
else
    echo "All checks passed. The payload is mission-ready."
    exit 0
fi
