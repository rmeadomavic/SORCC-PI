# SORCC-PI — Starting a Dev Session

Quick reference for each development session. Assumes INIT-SETUP.md is complete.

---

## Option A: Solo CLI Session (SSH or local terminal)

```bash
cd ~/SORCC-PI
claude
```

Then type:
```
Check memory and docs/NEXT-SESSION-TODO.md. Pick up where we left off.
```

---

## Option B: Recursive Browser Loop (Recommended)

### Step 1: Start Remote Control on the device

SSH into the Pi/Jetson (or use local terminal):
```bash
cd ~/SORCC-PI
claude --dangerously-skip-permissions
```

Then inside Claude Code:
```
/remote-control
```

Note the session URL or find it at `claude.ai/code`.

### Step 2: Open two browser tabs on your laptop

| Tab | URL | Purpose |
|-----|-----|---------|
| **Tab 1** | `claude.ai/code` → connect to remote session | Claude Code CLI |
| **Tab 2** | `http://<TAILSCALE_IP>:8080` | Live dashboard UI |

### Step 3: Activate Claude in Chrome

With both tabs open and the Claude Chrome extension active, prompt Claude in Chrome:

```
I have two tabs open:
- Tab 1: Claude Code remote terminal connected to my SORCC Pi at <TAILSCALE_IP>
- Tab 2: SORCC-PI dashboard at http://<TAILSCALE_IP>:8080

Your workflow:
1. Go to Tab 2 and screenshot the UI
2. Identify visual issues, broken elements, or UX problems
3. Switch to Tab 1 and make code changes to fix them
4. Run in Tab 1: rsync -av --exclude='__pycache__' ~/SORCC-PI/sorcc/ /opt/sorcc/sorcc/ && sudo systemctl restart sorcc-dashboard
5. Switch back to Tab 2, wait 5 seconds, refresh, and verify
6. Repeat until clean

Focus areas: check docs/NEXT-SESSION-TODO.md for current priorities
Do NOT change: config files, installer scripts (unless specifically tasked)
```

### Step 4: (Optional) Launch parallel cloud tasks

While the recursive loop runs, fire off code-only work in the cloud:
```bash
# In another terminal on the Pi, or from Tab 1:
claude --remote --model sonnet "Write pytest tests for sorcc/web/kismet.py"
claude --remote --model sonnet "Improve inline documentation in server.py"
claude --remote --model sonnet "Audit sorcc-setup.sh for edge cases"
```

Check progress: `/tasks` in Claude Code, or at `claude.ai/code`.

---

## Model Selection Guide

| Task | Model | Flag |
|------|-------|------|
| Main dev session (hardware, architecture, debugging) | **Opus** | default |
| Parallel cloud tasks (docs, tests, simple refactoring) | **Sonnet** | `--model sonnet` |
| Background agents (single-focused tasks) | **Sonnet** | set in Agent tool |
| Visual QA browser tab (Claude Chrome) | **Sonnet** | Claude Chrome settings |

**Rule of thumb:** Opus for the driver's seat, Sonnet for the crew.

---

## Verify Session Is Working

After starting, verify these in Tab 1:
```bash
# Services running?
systemctl is-active kismet sorcc-dashboard sorcc-boot

# Dashboard responding?
curl -s http://localhost:8080/api/status | python3 -c "import json,sys; s=json.load(sys.stdin); print(f'Kismet: {s[\"kismet\"]} | Devices: {s[\"device_count\"]} | GPS: {s[\"gps\"]}')"

# Logs flowing?
curl -s http://localhost:8080/api/logs?n=3
```

---

## End-of-Session Checklist

Before closing out:
- [ ] Commit and push all changes: `git add -A && git commit -m "..." && git push`
- [ ] Sync to deployment: `rsync -av --exclude='__pycache__' ~/SORCC-PI/sorcc/ /opt/sorcc/sorcc/`
- [ ] Restart service: `sudo systemctl restart sorcc-dashboard`
- [ ] Tell Claude Code: "wrap up, commit to memory, update NEXT-SESSION-TODO.md"
- [ ] Review any cloud `--remote` task results at claude.ai/code

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Remote control disconnected | Re-run `/remote-control` in Claude Code |
| Dashboard not loading | `sudo systemctl restart sorcc-dashboard` |
| Kismet down | `sudo systemctl restart kismet` |
| GPS not working | `sudo mmcli -m 0 --location-enable-gps-nmea --location-enable-gps-raw` |
| 503 errors | Kismet slow — wait 30s (response cache will serve stale data) |
| Cloud --remote can't find repo | Ensure you've pushed to GitHub first |
| Permission denied on deploy | Use `sudo` for systemctl, files are owned by kali |
