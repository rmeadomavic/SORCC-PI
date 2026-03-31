# Jetson Hydra — Claude Code Environment Setup

Copy this guide to the Jetson and run it there. Or push from the Pi once the Jetson is on Tailscale.

---

## Quick Copy from Pi (when Jetson is online)

From the Pi, once you know the Jetson's Tailscale IP and username:
```bash
# Copy the guides
scp -r ~/SORCC-PI/docs/guides/ <user>@<jetson-tailscale-ip>:~/guides/

# Copy the home-level CLAUDE.md template
scp ~/CLAUDE.md <user>@<jetson-tailscale-ip>:~/CLAUDE.md.template

# Or just SSH in and run everything from here
ssh <user>@<jetson-tailscale-ip>
```

---

## Step-by-Step Setup on Jetson

### 1. Install Claude Code

```bash
# Node.js (JetPack is Ubuntu-based)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# Claude Code
npm install -g @anthropic-ai/claude-code
claude --version
```

### 2. Authenticate

```bash
claude auth login
gh auth login
```

### 3. Tailscale (if not already)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
tailscale ip -4  # Note this IP
```

### 4. Clone Hydra Repo

```bash
cd ~
gh repo clone <your-hydra-repo>
cd hydra
```

### 5. Create CLAUDE.md for Hydra

Create `~/hydra/CLAUDE.md` with your Hydra project context. Model it after the SORCC-PI CLAUDE.md — include:
- Project context and architecture
- Deployment workflow (where the live code runs vs the repo)
- API endpoints
- Hardware state
- Service commands
- The recursive session prompts (update the URLs/IPs for Hydra)

### 6. Create Home-Level CLAUDE.md

```bash
cat > ~/CLAUDE.md << 'HEREDOC'
# Jetson Hydra — Development Environment

This is a Jetson Orin Nano running the Hydra tactical dashboard.

## Quick Start

```bash
cd ~/hydra
# Dashboard URL: http://<TAILSCALE_IP>:8080
```

## Passwords
[fill in]

## Tailscale IP
[fill in after setup]
HEREDOC
```

### 7. Set Up Shell Aliases

Add to `~/.bashrc` or `~/.zshrc`:
```bash
# Claude Code shortcuts
cc() {
    claude \
        --dangerously-skip-permissions \
        --model claude-opus-4-6 \
        --effort high
}

ccs() {
    claude \
        --dangerously-skip-permissions \
        --model claude-sonnet-4-6 \
        --effort high
}
```

### 8. Verify

```bash
# Check Hydra services are running
systemctl status hydra  # or whatever the service name is

# Check Claude Code
cd ~/hydra && cc
# Type: "check memory, read CLAUDE.md, tell me what you see"
```

---

## Starting a Recursive Session on Hydra

```bash
# On the Jetson (SSH from laptop: ssh jetson):
cd ~/Hydra
cc
# Then inside Claude Code:
/remote-control
```

**Laptop browser — open two tabs:**

| Tab | URL |
|-----|-----|
| Tab 1 | `claude.ai/code` → connect to Jetson remote session |
| Tab 2 | `http://100.109.160.122:8080` (Jetson Tailscale IP) |

**Tab 1 — Claude Code prompt:**
```
Start a recursive dev session on Hydra. Read CLAUDE.md for project context.
Deploy path and repo structure should be in CLAUDE.md — if not, explore and
document it. My browser instance is watching the UI live and will feed back
visual issues as you work.

Reference the SORCC-PI project at github.com/rmeadomavic/SORCC-PI branch
claude/setup-sorcc-pi-qxVWN for patterns to adopt: structured logging with
ring buffer, OUI manufacturer lookup, response caching, activity feed,
CoT/TAK export, device classification, packet-based activity metrics.

Quality bar: Palantir/Anduril grade — military functionality, civilian UX.
No blank screens, always last-known-good state. Work through improvements
in chunks, commit after each chunk. Cook.
```

**Tab 2 — Claude Chrome prompt (across both tabs):**
```
I have two tabs open:
- Tab 1: Claude Code remote terminal connected to my Jetson Hydra
- Tab 2: Hydra dashboard UI

Your workflow:
1. Go to Tab 2 and screenshot the UI
2. Identify visual issues, broken elements, UX problems, missing polish
3. Switch to Tab 1 and describe what you found — the CLI session will fix it
4. After the CLI session says it deployed, switch to Tab 2, wait 5 seconds,
   refresh, and verify the fix
5. Repeat until clean

Audit from three personas:
- A Green Beret using this on a mission from a phone
- An instructor demoing to a classroom of soldiers
- A general at Oak Grove deciding whether to fund this

Be ruthless. Report everything.
```

---

## Cross-Pollination: SORCC-PI ↔ Hydra

Both projects share design patterns. Learnings transfer:
- OUI manufacturer lookup → could be shared module
- Kismet client with caching → same pattern for any REST API
- Response caching for reliability → use in Hydra too
- CoT/TAK export → Hydra should have this too
- Dark theme CSS variables → already aligned

When working on one project, check if the improvement applies to both.
