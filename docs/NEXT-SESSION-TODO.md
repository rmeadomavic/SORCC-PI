# SORCC-PI — Next Recursive Session TODO

**Setup:** Two browser tabs — Tab 1: Claude Code CLI on Pi, Tab 2: Dashboard UI at `100.71.115.45:8080`

**Pi is on ethernet now** — WiFi capture toggle can be tested safely without losing connectivity.

---

## Priority 1: Visual Polish (Palantir/Anduril Grade) — DONE (2026-03-31)

- [x] **Stat card animations** — Count-up with easeOutCubic, pulse glow on change
- [x] **Device type donut chart** — Category breakdown (phones/IoT/network/laptop) in Spectrum tab
- [x] **Top-N activity leaderboard** — Top 8 by packets, live re-ranking, bar charts
- [x] **Dashboard log viewer tab** — Logs sub-tab with level filter, pause/resume, auto-scroll
- [x] **Map bubble markers** — Packet-count-based sizing (log scale), translucent fill, rich popups
- [ ] **Map heatmap overlay** — Signal/activity heatmap layer (needs GPS data to be useful)
- [ ] **GPS breadcrumb trail polish** — Already works, needs styling refinement with outdoor test

## Priority 2: TAK/ATAK Integration — NEEDS OUTDOOR GPS

- [ ] **Test CoT outdoors** — Take Pi outside, get GPS fix, verify /api/cot produces valid XML
- [ ] **TAK Server feed** — Test with an actual ATAK instance (or TAK Server simulator)
- [ ] **CoT streaming** — WebSocket or SSE feed for real-time CoT updates to ATAK
- [ ] **CoT type refinement** — Better type codes based on WiFi vs BT vs SDR device types

## Priority 3: WiFi Capture Testing

- [ ] **Test WiFi toggle** — Enable monitor mode via UI, verify:
  - Dashboard stays accessible via ethernet/LTE/Tailscale
  - WiFi devices appear in Kismet
  - Hunt mode works with WiFi SSIDs
  - Toggle back to managed mode reconnects WiFi
- [ ] **WiFi + BT simultaneous** — Verify both adapters feed Kismet in Full Spectrum mode

## Priority 4: FPV Frequency Detection — NEEDS SDR

- [ ] **Research RTL-SDR profiles for FPV** — If SDR dongle available:
  - 915 MHz: LoRa/Meshtastic/CRSF (TBS Crossfire)
  - 868 MHz: CRSF EU variant
  - 433 MHz: TPMS (already supported)
- [ ] **Add FPV profile** — New mission profile: "FPV Detection"
  - Sources: hci0 + rtl433 on 915MHz
  - Dashboard shows detected FPV control links
- [ ] **2.4 GHz ELRS detection** — Research if BT adapter can detect ELRS presence
- [ ] **5.8 GHz video** — Needs 5.8 GHz SDR (not current hardware)

## Priority 5: Installer & Fresh Test — PARTIALLY DONE

- [x] **Harden sorcc-setup.sh** — Added:
  - Uses requirements.txt for pip deps
  - rsync instead of cp for module sync
  - Log directory creation (/opt/sorcc/logs/)
  - Module file verification check
  - Python import verification post-install
- [x] **Boot service** — GPS auto-enables on boot via mmcli + AT command fallback
- [ ] **Fresh install test** — Wipe SD card, flash Kali, run installer, verify everything works

## Priority 6: MAVLink / Autonomous Hunt

- [ ] **MAVLink waypoint export** — /api/waypoints endpoint generating Mission Planner compatible waypoints
- [ ] **Convergence algorithm** — Design the logic for autonomous signal convergence
- [ ] **FC connection** — Test MAVLink serial connection to Matek H743 / Pixhawk 6C

## Priority 7: Documentation

- [ ] **Update README** — Reflect new endpoints, modules, CoT capability
- [ ] **API docs** — Auto-generate from FastAPI OpenAPI schema
- [ ] **CLAUDE.md** — Update with new module structure and endpoints

---

## Session Workflow Reminder

1. CLI session: edit code, test endpoints, sync to /opt/sorcc/, restart service
2. Browser session: visual QA, multi-persona audit, report issues
3. Sync: `rsync -av --exclude='__pycache__' ~/SORCC-PI/sorcc/ /opt/sorcc/sorcc/`
4. Restart: `sudo systemctl restart sorcc-dashboard`
5. Commit + push after each chunk
