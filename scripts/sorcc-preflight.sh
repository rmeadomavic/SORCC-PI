#!/usr/bin/env bash
# SORCC-PI — Post-install validation
# Usage: bash scripts/sorcc-preflight.sh [--json]
set -euo pipefail

PASS=0
WARN=0
FAIL=0
JSON_MODE=false
JSON_CHECKS="[]"

# Parse args
if [[ "${1:-}" == "--json" ]]; then
    JSON_MODE=true
fi

ok()   {
    if [ "$JSON_MODE" = true ]; then
        json_add "$1" "$2" "pass" "$3"
    else
        echo -e "\033[0;32m[PASS]\033[0m $3"
    fi
    PASS=$((PASS+1))
}
warn() {
    if [ "$JSON_MODE" = true ]; then
        json_add "$1" "$2" "warn" "$3"
    else
        echo -e "\033[1;33m[WARN]\033[0m $3"
    fi
    WARN=$((WARN+1))
}
fail() {
    if [ "$JSON_MODE" = true ]; then
        json_add "$1" "$2" "fail" "$3"
    else
        echo -e "\033[0;31m[FAIL]\033[0m $3"
    fi
    FAIL=$((FAIL+1))
}

json_add() {
    local name="$1" category="$2" status="$3" detail="$4"
    # Escape quotes in detail
    detail="${detail//\"/\\\"}"
    JSON_CHECKS=$(echo "$JSON_CHECKS" | python3 -c "
import sys, json
checks = json.load(sys.stdin)
checks.append({'name': '$name', 'category': '$category', 'status': '$status', 'detail': '$detail'})
json.dump(checks, sys.stdout)
" 2>/dev/null || echo "$JSON_CHECKS")
}

check_cmd() {
    local cmd="$1" label="$2" category="${3:-tools}"
    if command -v "$cmd" >/dev/null 2>&1; then
        ok "$label" "$category" "$label is installed"
    else
        fail "$label" "$category" "$label not found (command: $cmd)"
    fi
}

check_service() {
    local svc="$1" label="$2"
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        ok "$label" "services" "$label is running"
    elif systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        warn "$label" "services" "$label enabled but not running — may need reboot"
    else
        fail "$label" "services" "$label not installed or not enabled"
    fi
}

if [ "$JSON_MODE" = false ]; then
    echo "SORCC-PI Preflight Check"
    echo "========================"
    echo ""
fi

# ── Hardware ─────────────────────────────────────────────────
if [ "$JSON_MODE" = false ]; then echo "-- Hardware --"; fi

# SDR
if lsusb 2>/dev/null | grep -q "0bda:2838"; then
    ok "RTL-SDR" "hardware" "RTL-SDR dongle detected (RTL2832U)"
elif lsusb 2>/dev/null | grep -qi "nooelec"; then
    ok "RTL-SDR" "hardware" "Nooelec SDR detected"
else
    warn "RTL-SDR" "hardware" "No SDR dongle detected"
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
    ok "Serial Devices" "hardware" "Serial devices present ($(ls /dev/ttyUSB* 2>/dev/null | tr '\n' ' '))"
else
    warn "Serial Devices" "hardware" "No /dev/ttyUSB* devices found (LTE modem not connected)"
fi

# Bluetooth
if [ -e /sys/class/bluetooth/hci0 ]; then
    ok "Bluetooth" "hardware" "Bluetooth adapter (hci0) present"
else
    warn "Bluetooth" "hardware" "No Bluetooth adapter found"
fi

# PiSugar
if systemctl is-active --quiet pisugar-server 2>/dev/null; then
    ok "PiSugar" "hardware" "PiSugar battery manager running"
else
    warn "PiSugar" "hardware" "PiSugar not running (battery monitoring unavailable)"
fi

# User groups
SORCC_USER="${SUDO_USER:-$(whoami)}"
if id -nG "$SORCC_USER" | grep -qw dialout; then
    ok "Dialout Group" "hardware" "User $SORCC_USER in dialout group"
else
    warn "Dialout Group" "hardware" "User $SORCC_USER NOT in dialout group"
fi

if [ "$JSON_MODE" = false ]; then echo ""; echo "-- Services --"; fi

# ── Services ─────────────────────────────────────────────────
check_service kismet "Kismet Service"
check_service sorcc-boot "SORCC Boot Service"
check_service sorcc-dashboard "SORCC Dashboard"
check_service avahi-daemon "Avahi mDNS"

if [ "$JSON_MODE" = false ]; then echo ""; echo "-- Network --"; fi

# ── Network ──────────────────────────────────────────────────
if mmcli -L 2>/dev/null | grep -q "/"; then
    ok "LTE Modem" "network" "LTE modem detected by ModemManager"
else
    warn "LTE Modem" "network" "LTE modem not detected"
fi

if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
    ok "Internet" "network" "Internet connectivity OK"
else
    warn "Internet" "network" "No internet connectivity"
fi

if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null || true)"
    if [ -n "$TS_IP" ]; then
        ok "Tailscale" "network" "Tailscale connected ($TS_IP)"
    else
        warn "Tailscale" "network" "Tailscale installed but not connected"
    fi
else
    warn "Tailscale" "network" "Tailscale not installed"
fi

if [ "$JSON_MODE" = false ]; then echo ""; echo "-- Config --"; fi

# ── Config ───────────────────────────────────────────────────
if [ -f /etc/kismet/kismet_site.conf ]; then
    ok "Kismet Config" "config" "Kismet site config exists"
else
    fail "Kismet Config" "config" "Kismet site config missing (/etc/kismet/kismet_site.conf)"
fi

if [ -f /root/.kismet/kismet_httpd.conf ]; then
    ok "Kismet Credentials" "config" "Kismet credentials configured"
else
    warn "Kismet Credentials" "config" "Kismet credentials not set"
fi

if curl -s -o /dev/null -w "%{http_code}" http://localhost:2501/ 2>/dev/null | grep -q "200\|401"; then
    ok "Kismet Web UI" "config" "Kismet responding on port 2501"
else
    warn "Kismet Web UI" "config" "Kismet not responding on port 2501"
fi

if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ 2>/dev/null | grep -q "200"; then
    ok "SORCC Dashboard" "config" "Dashboard responding on port 8080"
else
    warn "SORCC Dashboard" "config" "Dashboard not responding on port 8080"
fi

if [ -f /opt/sorcc/config/sorcc.ini ]; then
    ok "SORCC Config" "config" "sorcc.ini exists"
else
    warn "SORCC Config" "config" "sorcc.ini not found — run sorcc-setup.sh"
fi

if [ -f /opt/sorcc/gps_lte.py ]; then
    ok "GPS Script" "config" "GPS script installed"
else
    warn "GPS Script" "config" "GPS script not found"
fi

# Dashboard modules
for mod in server.py kismet.py oui.py logging_config.py; do
    if [ -f /opt/sorcc/sorcc/web/"$mod" ]; then
        ok "Module $mod" "config" "Dashboard module $mod present"
    else
        fail "Module $mod" "config" "Dashboard module $mod missing from /opt/sorcc/sorcc/web/"
    fi
done

# Log directory
if [ -d /opt/sorcc/logs ]; then
    ok "Log Dir" "config" "Log directory exists (/opt/sorcc/logs/)"
else
    warn "Log Dir" "config" "Log directory missing — create with: mkdir -p /opt/sorcc/logs"
fi

# Python dependencies
if python3 -c "import fastapi, uvicorn, requests, jinja2" 2>/dev/null; then
    ok "Python Deps" "config" "All Python dependencies importable"
else
    fail "Python Deps" "config" "Some Python dependencies missing — run: pip3 install -r requirements.txt"
fi

# ── Output ───────────────────────────────────────────────────
if [ "$JSON_MODE" = true ]; then
    # Determine overall status
    if [ "$FAIL" -gt 0 ]; then
        STATUS="fail"
    elif [ "$WARN" -gt 0 ]; then
        STATUS="warn"
    else
        STATUS="pass"
    fi

    echo "{\"status\": \"$STATUS\", \"pass\": $PASS, \"warn\": $WARN, \"fail\": $FAIL, \"checks\": $JSON_CHECKS}"
else
    echo ""
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
fi
