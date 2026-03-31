# SORCC-PI — One-Time Environment Setup

Run these steps once per device (Pi or Jetson). After this, use `SESSION-START.md` for each dev session.

---

## 1. Install Claude Code

```bash
# Install Node.js (required for Claude Code)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
```

## 2. Authenticate Claude Code

```bash
# Interactive login — opens browser or gives auth code
claude auth login

# Verify
claude auth status
```

## 3. Install & Authenticate GitHub CLI

```bash
# Install gh
sudo apt-get install -y gh

# Authenticate (follow prompts — use browser or token)
gh auth login

# Verify
gh auth status
```

## 4. Install Tailscale

```bash
# Install
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate
sudo tailscale up --ssh

# Note your Tailscale IP
tailscale ip -4
```

## 5. Clone the Repo

```bash
cd ~
gh repo clone rmeadomavic/SORCC-PI
cd SORCC-PI
git checkout claude/setup-sorcc-pi-qxVWN
```

## 6. Run the SORCC Installer (Pi only)

```bash
sudo bash scripts/sorcc-setup.sh
```

## 7. Set Up Claude Code Project Settings

```bash
# Create project settings directory
mkdir -p ~/SORCC-PI/.claude

# The CLAUDE.md in the repo root provides all project context automatically.
# Memory files in ~/.claude/projects/-home-kali/memory/ persist across sessions.
```

## 8. Set Up Cloud Remote (Optional — for parallel tasks)

```bash
# This syncs your GitHub credentials to Claude's cloud environment
# Run this from an interactive Claude Code session:
#   1. Start claude: claude
#   2. Type: /web-setup
#   3. Follow the prompts
#
# If /web-setup isn't available in your version, connect GitHub
# directly at claude.ai/code → Settings → GitHub
```

## 9. Verify Everything Works

```bash
# Check services
systemctl status kismet sorcc-dashboard sorcc-boot

# Check dashboard
curl -s http://localhost:8080/api/status | python3 -m json.tool

# Check Tailscale access from laptop
# Open browser to http://<TAILSCALE_IP>:8080

# Check Claude Code
cd ~/SORCC-PI
claude --version
```

---

## Device-Specific Notes

### Raspberry Pi 4
- OS: Kali Linux ARM64
- Dashboard port: 8080
- Kismet port: 2501
- Passwords: `kismet` or `sorcc`
- GPS: needs `mmcli --location-enable-gps-nmea --location-enable-gps-raw` (done by boot service)

### Jetson Orin Nano
- OS: JetPack (Ubuntu-based)
- Hydra dashboard: typically port 8080
- Different service names — check Hydra docs
- More compute available — can run heavier ML models

---

## What This Sets Up

After completing these steps, your device has:
- Claude Code CLI with your Anthropic account
- GitHub access for commits/PRs
- Tailscale for remote access from anywhere
- SORCC-PI repo with full project context in CLAUDE.md
- Memory system with learnings from previous sessions
- Ready for remote-control sessions from browser/phone
