#!/usr/bin/env bash
# SORCC-PI — Capture reference configs from an existing SORCC Pi setup
# Run this on the old Pi (or mount its SD card) before wiping.
#
# Usage: sudo bash scripts/sorcc-capture-old.sh [OUTPUT_DIR]
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[DONE]${NC} $1"; }
warn() { echo -e "${YELLOW}[SKIP]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

OUTPUT_DIR="${1:-reference/old-setup}"
mkdir -p "$OUTPUT_DIR"

echo ""
echo "========================================"
echo "  SORCC-PI — Old Setup Capture"
echo "========================================"
echo ""
info "Saving reference configs to: $OUTPUT_DIR"
echo ""

info "Capturing NetworkManager profiles..."
if [ -d /etc/NetworkManager/system-connections ]; then
    mkdir -p "$OUTPUT_DIR/nm-connections"
    for f in /etc/NetworkManager/system-connections/*; do
        [ -f "$f" ] || continue
        base="$(basename "$f")"
        cp "$f" "$OUTPUT_DIR/nm-connections/$base"
        sed -i 's/^psk=.*/psk=<REDACTED>/' "$OUTPUT_DIR/nm-connections/$base" 2>/dev/null || true
    done
    ok "NetworkManager profiles captured (passwords redacted)"
else
    warn "No NetworkManager profiles found"
fi

info "Capturing modem info..."
if command -v mmcli >/dev/null 2>&1; then
    mmcli -L > "$OUTPUT_DIR/modem-list.txt" 2>&1 || true
    mmcli -m 0 > "$OUTPUT_DIR/modem-info.txt" 2>&1 || true
    mmcli -m 0 --location-get > "$OUTPUT_DIR/gps-status.txt" 2>&1 || true
    ok "Modem info captured"
else
    warn "mmcli not available"
fi

info "Capturing Kismet config..."
for f in /etc/kismet/kismet_site.conf /etc/kismet/kismet.conf; do
    [ -f "$f" ] && cp "$f" "$OUTPUT_DIR/" && ok "Captured $(basename "$f")"
done
if [ -f /root/.kismet/kismet_httpd.conf ]; then
    cp /root/.kismet/kismet_httpd.conf "$OUTPUT_DIR/kismet_httpd.conf"
    sed -i 's/httpd_password=.*/httpd_password=<REDACTED>/' "$OUTPUT_DIR/kismet_httpd.conf" 2>/dev/null || true
    ok "Kismet credentials captured (password redacted)"
fi

info "Capturing systemd services..."
mkdir -p "$OUTPUT_DIR/services"
for svc in sorcc-boot kismet sorcc-dashboard pisugar-server; do
    [ -f "/etc/systemd/system/${svc}.service" ] && cp "/etc/systemd/system/${svc}.service" "$OUTPUT_DIR/services/" && ok "Captured ${svc}.service"
done

info "Capturing installed packages..."
dpkg -l > "$OUTPUT_DIR/dpkg-packages.txt" 2>/dev/null || true
pip3 list > "$OUTPUT_DIR/pip-packages.txt" 2>/dev/null || true
ok "Package lists captured"

info "Capturing network state..."
ip addr > "$OUTPUT_DIR/ip-addr.txt" 2>/dev/null || true
ip route > "$OUTPUT_DIR/ip-route.txt" 2>/dev/null || true
nmcli con show > "$OUTPUT_DIR/nm-connections-list.txt" 2>/dev/null || true
ok "Network state captured"

info "Capturing system info..."
{ hostname; echo ""; cat /etc/os-release 2>/dev/null; echo ""; uname -a; echo ""; free -h; echo ""; df -h; echo ""; lsusb 2>/dev/null; } > "$OUTPUT_DIR/system-info.txt" 2>/dev/null
ok "System info captured"

echo ""
echo "========================================"
echo "  Capture complete: $OUTPUT_DIR"
echo "========================================"
echo ""
ls -la "$OUTPUT_DIR/"
