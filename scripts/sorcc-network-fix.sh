#!/usr/bin/env bash
# SORCC-PI — Network Recovery Script
# Fixes common WiFi + LTE connection issues in the field.
# Safe to re-run at any time.
#
# Usage: sudo bash scripts/sorcc-network-fix.sh
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
    fail "Run as root: sudo bash scripts/sorcc-network-fix.sh"
    exit 1
fi

echo ""
echo "========================================"
echo "  SORCC-PI — Network Recovery"
echo "========================================"
echo ""

# ── Step 1: Ensure NetworkManager is running ─────────────────
info "Step 1/6: Checking NetworkManager..."
if ! systemctl is-active --quiet NetworkManager; then
    systemctl start NetworkManager
    sleep 2
fi
if systemctl is-active --quiet NetworkManager; then
    ok "NetworkManager is running"
else
    fail "NetworkManager won't start — run: journalctl -u NetworkManager"
    exit 1
fi

# ── Step 2: Enable radios ────────────────────────────────────
info "Step 2/6: Enabling WiFi and WWAN radios..."
nmcli radio wifi on 2>/dev/null || true
nmcli radio wwan on 2>/dev/null || true
sleep 1

WIFI_RADIO=$(nmcli radio wifi 2>/dev/null || echo "unknown")
WWAN_RADIO=$(nmcli radio wwan 2>/dev/null || echo "unknown")

if [ "$WIFI_RADIO" = "enabled" ]; then
    ok "WiFi radio enabled"
else
    warn "WiFi radio status: $WIFI_RADIO"
fi

if [ "$WWAN_RADIO" = "enabled" ]; then
    ok "WWAN radio enabled"
else
    warn "WWAN radio status: $WWAN_RADIO"
fi

# ── Step 3: Restore wlan0 to managed mode ────────────────────
info "Step 3/6: Restoring wlan0..."

if ip link show wlan0 >/dev/null 2>&1; then
    # Check if interface is in monitor mode
    MODE=$(iw dev wlan0 info 2>/dev/null | grep -oP 'type \K\w+' || echo "unknown")

    if [ "$MODE" = "monitor" ]; then
        info "wlan0 is in monitor mode — switching back to managed..."
        # Stop Kismet first so it doesn't fight for the interface
        systemctl stop kismet 2>/dev/null || true
        ip link set wlan0 down
        iw dev wlan0 set type managed
        ip link set wlan0 up
        sleep 2
        ok "wlan0 restored to managed mode"
    else
        info "wlan0 mode: $MODE"
    fi

    # Ensure wlan0 is managed by NetworkManager (not unmanaged)
    WLAN_STATE=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep "^wlan0:" | cut -d: -f2 || echo "missing")

    if [ "$WLAN_STATE" = "unmanaged" ]; then
        info "wlan0 is unmanaged — setting to managed..."
        nmcli device set wlan0 managed yes 2>/dev/null || true
        sleep 2
        ok "wlan0 set to managed"
    elif [ "$WLAN_STATE" = "connected" ]; then
        ok "wlan0 is already connected"
    elif [ "$WLAN_STATE" = "disconnected" ]; then
        ok "wlan0 is managed and ready to connect"
    else
        warn "wlan0 state: $WLAN_STATE"
    fi
else
    warn "wlan0 interface not found — no onboard WiFi?"
fi
echo ""

# ── Step 4: Reconnect WiFi ──────────────────────────────────
info "Step 4/6: Reconnecting WiFi..."

WIFI_CON=$(nmcli -t -f NAME,TYPE connection show 2>/dev/null | grep ":802-11-wireless$" | head -1 | cut -d: -f1 || true)

if [ -n "$WIFI_CON" ]; then
    info "Found WiFi profile: '$WIFI_CON'"
    if nmcli connection up "$WIFI_CON" 2>/dev/null; then
        ok "WiFi connected to '$WIFI_CON'"
    else
        warn "Could not connect to '$WIFI_CON' — check SSID/password or range"
        info "  To rescan: nmcli device wifi rescan && nmcli device wifi list"
    fi
else
    warn "No saved WiFi connection profiles found"
    info "  Create one: sudo nmcli device wifi connect 'SSID' password 'PASS'"
fi
echo ""

# ── Step 5: Reconnect LTE ───────────────────────────────────
info "Step 5/6: Reconnecting LTE..."

# Make sure ModemManager is running
if ! systemctl is-active --quiet ModemManager; then
    systemctl start ModemManager
    info "Waiting for ModemManager to detect modem..."
    sleep 5
fi

# Check if modem is visible
if mmcli -L 2>/dev/null | grep -q "/"; then
    ok "LTE modem detected"

    LTE_CON=$(nmcli -t -f NAME,TYPE connection show 2>/dev/null | grep ":gsm$" | head -1 | cut -d: -f1 || true)

    if [ -n "$LTE_CON" ]; then
        info "Found LTE profile: '$LTE_CON'"
        for attempt in 1 2 3; do
            if nmcli connection up "$LTE_CON" 2>/dev/null; then
                ok "LTE connected via '$LTE_CON'"
                break
            else
                if [ "$attempt" -lt 3 ]; then
                    warn "LTE attempt $attempt/3 failed — retrying in 5s..."
                    sleep 5
                else
                    warn "LTE connection failed after 3 attempts"
                    info "  Try: sudo nmcli connection delete '$LTE_CON'"
                    info "  Then: sudo nmcli connection add type gsm ifname '*' con-name sorcc-lte apn YOUR_APN"
                fi
            fi
        done
    else
        warn "No GSM/LTE connection profile found"
        info "  Create one: sudo nmcli c add type gsm ifname '*' con-name sorcc-lte apn YOUR_APN"
    fi
else
    warn "No LTE modem detected — check SixFab hat connection"
fi
echo ""

# ── Step 6: Verify connectivity ─────────────────────────────
info "Step 6/6: Connectivity check..."

if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
    ok "Internet connectivity verified"
else
    warn "No internet — but local network may still work"
fi

# Show final state
echo ""
echo "Current network state:"
nmcli device status 2>/dev/null || true
echo ""

# Offer to restart Kismet if it was stopped
if ! systemctl is-active --quiet kismet 2>/dev/null; then
    info "Kismet was stopped during recovery. Start it with:"
    echo "    sudo systemctl start kismet"
fi

echo "========================================"
echo "  Network recovery complete."
echo "========================================"
echo ""
