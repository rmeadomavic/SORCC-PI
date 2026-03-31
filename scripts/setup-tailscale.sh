#!/usr/bin/env bash
# SORCC-PI — Tailscale SSH remote access setup
# Usage: sudo bash scripts/setup-tailscale.sh [OPTIONS]
set -euo pipefail

PASS=0
WARN=0
FAIL=0

ok()   { echo -e "\033[0;32m[PASS]\033[0m $1"; PASS=$((PASS+1)); }
warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; WARN=$((WARN+1)); }
fail() { echo -e "\033[0;31m[FAIL]\033[0m $1"; FAIL=$((FAIL+1)); }
info() { echo -e "\033[0;36m[INFO]\033[0m $1"; }

usage() {
    cat <<'EOF'
Usage: setup-tailscale.sh [OPTIONS]

Install and configure Tailscale for SSH remote access on a SORCC Pi.

Options:
  --authkey KEY    Use a Tailscale auth key (skips interactive login)
  --hostname NAME  Set the Tailscale hostname (default: sorcc-pi)
  --ssh            Enable Tailscale SSH (default: enabled)
  --no-ssh         Disable Tailscale SSH
  -h, --help       Show this help message

Examples:
  # Interactive login (opens a URL to authenticate)
  sudo bash scripts/setup-tailscale.sh

  # Auth key (for batch provisioning multiple Pis)
  sudo bash scripts/setup-tailscale.sh --authkey tskey-auth-xxxxx

  # Custom hostname (for multi-Pi setups)
  sudo bash scripts/setup-tailscale.sh --hostname sorcc-pi-03
EOF
    exit 0
}

# ── Defaults ─────────────────────────────────────────────────
AUTHKEY=""
HOSTNAME="sorcc-pi"
SSH_ENABLED=true
SORCC_USER="${SUDO_USER:-$(whoami)}"
SORCC_HOME="$(eval echo ~"$SORCC_USER")"

# ── Parse arguments ──────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --authkey)  AUTHKEY="$2"; shift 2 ;;
        --hostname) HOSTNAME="$2"; shift 2 ;;
        --ssh)      SSH_ENABLED=true; shift ;;
        --no-ssh)   SSH_ENABLED=false; shift ;;
        -h|--help)  usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

# ── Root check ───────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (sudo)."
    exit 1
fi

echo "SORCC-PI — Tailscale SSH Setup"
echo "=============================="

# ── Step 1: Install Tailscale ────────────────────────────────
echo ""
echo "Step 1: Installing Tailscale..."

if command -v tailscale >/dev/null 2>&1; then
    ok "Tailscale is already installed ($(tailscale version | head -1))"
else
    info "Downloading Tailscale install script..."
    curl -fsSL https://tailscale.com/install.sh | sh
    if command -v tailscale >/dev/null 2>&1; then
        ok "Tailscale installed ($(tailscale version | head -1))"
    else
        fail "Tailscale installation failed"
        echo "Summary: PASS=$PASS WARN=$WARN FAIL=$FAIL"
        exit 1
    fi
fi

# ── Step 2: Enable tailscaled ────────────────────────────────
echo ""
echo "Step 2: Enabling tailscaled service..."

systemctl enable --now tailscaled 2>/dev/null || true
if systemctl is-active --quiet tailscaled; then
    ok "tailscaled service is running"
else
    fail "tailscaled service failed to start"
    echo "Summary: PASS=$PASS WARN=$WARN FAIL=$FAIL"
    exit 1
fi

# ── Step 3: Configure SSH ────────────────────────────────────
echo ""
echo "Step 3: Configuring SSH..."

# Ensure OpenSSH server is installed and running
if ! command -v sshd >/dev/null 2>&1; then
    info "Installing OpenSSH server..."
    apt-get update -qq && apt-get install -y -qq openssh-server
fi

systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true

if systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; then
    ok "OpenSSH server is running"
else
    warn "OpenSSH server may not be running — Tailscale SSH can still work"
fi

# Ensure the user has an .ssh directory
mkdir -p "$SORCC_HOME/.ssh"
chmod 700 "$SORCC_HOME/.ssh"
touch "$SORCC_HOME/.ssh/authorized_keys"
chmod 600 "$SORCC_HOME/.ssh/authorized_keys"
chown -R "$SORCC_USER:$SORCC_USER" "$SORCC_HOME/.ssh"
ok "SSH directory configured for $SORCC_USER"

# Enable password authentication as a fallback
if [ -f /etc/ssh/sshd_config ]; then
    if ! grep -q "^PasswordAuthentication yes" /etc/ssh/sshd_config; then
        sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
        systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    fi
    ok "SSH password authentication enabled (fallback)"
fi

# ── Step 4: Connect Tailscale ────────────────────────────────
echo ""
echo "Step 4: Connecting to Tailscale network..."

UP_ARGS=("--hostname=$HOSTNAME")

if [ "$SSH_ENABLED" = true ]; then
    UP_ARGS+=("--ssh")
fi

if [ -n "$AUTHKEY" ]; then
    UP_ARGS+=("--authkey=$AUTHKEY")
    info "Using auth key for non-interactive login..."
else
    echo "  Interactive login — a URL will appear below."
    echo "  Open it in a browser to authenticate this Pi."
    echo ""
fi

tailscale up "${UP_ARGS[@]}"
sleep 2

# ── Step 5: Verify ───────────────────────────────────────────
echo ""
echo "Step 5: Verifying Tailscale connection..."

TS_IP="$(tailscale ip -4 2>/dev/null || true)"

if [ -n "$TS_IP" ]; then
    ok "Tailscale is connected"
    echo ""
    echo "  ┌──────────────────────────────────────────────┐"
    echo "  │  Tailscale IP:  $TS_IP"
    echo "  │  Hostname:      $HOSTNAME"
    echo "  │  SSH command:   ssh $SORCC_USER@$TS_IP"
    if [ "$SSH_ENABLED" = true ]; then
    echo "  │  Tailscale SSH: ssh $SORCC_USER@$HOSTNAME"
    fi
    echo "  │  Dashboard:     http://$TS_IP:8080"
    echo "  │  Kismet:        http://$TS_IP:2501"
    echo "  └──────────────────────────────────────────────┘"
    echo ""
    echo "  To connect with just 'ssh sorcc-pi', add this to your"
    echo "  laptop's SSH config file:"
    echo ""
    echo "    Windows:  C:\\Users\\<YOU>\\.ssh\\config"
    echo "    Mac/Linux: ~/.ssh/config"
    echo ""
    echo "  ── Copy below this line ──────────────────────"
    echo "  Host $HOSTNAME"
    echo "      HostName $TS_IP"
    echo "      User $SORCC_USER"
    echo "      ServerAliveInterval 30"
    echo "      ServerAliveCountMax 3"
    echo "  ── Copy above this line ──────────────────────"
else
    fail "Tailscale did not get an IP address"
fi

if [ "$SSH_ENABLED" = true ]; then
    ok "Tailscale SSH enabled (no key management needed)"
else
    warn "Tailscale SSH is disabled — use regular SSH with keys"
fi

# ── Step 6: Persistence ──────────────────────────────────────
echo ""
echo "Step 6: Checking persistence..."

if systemctl is-enabled --quiet tailscaled 2>/dev/null; then
    ok "tailscaled will start on boot"
else
    warn "tailscaled is not enabled on boot — run: sudo systemctl enable tailscaled"
fi

echo ""
echo "Summary: PASS=$PASS WARN=$WARN FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
