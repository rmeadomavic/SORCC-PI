# SORCC-PI — Next Recursive Session TODO

**Setup:** Two browser tabs — Tab 1: Claude Code CLI on Pi, Tab 2: Dashboard UI at `100.71.115.45:8080`

**Pi is on LTE/Tailscale** — WiFi capture toggle can be tested safely without losing connectivity.

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
- [x] **CoT self-position endpoint** — /api/cot/self broadcasts Pi's own GPS position to ATAK
- [ ] **TAK Server feed** — Test with an actual ATAK instance (or TAK Server simulator)
- [ ] **CoT streaming** — WebSocket or SSE feed for real-time CoT updates to ATAK
- [ ] **CoT type refinement** — Better type codes based on WiFi vs BT vs SDR device types

## Priority 3: WiFi Capture Testing — DONE (2026-03-31, Chunk 12)

- [x] **Test WiFi toggle** — Toggle mechanics work correctly via UI
- [x] **Finding: onboard brcmfmac enters monitor mode but captures 0 packets**
- [x] **Recommendation: External USB adapter (Alpha cards) needed for actual WiFi capture**
- [ ] **WiFi + BT simultaneous** — Verify both adapters feed Kismet (needs external adapter)

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

- [x] **Harden sorcc-setup.sh** — Uses requirements.txt, rsync, module verification, log dir
- [x] **Boot service** — GPS auto-enables on boot via mmcli + AT command fallback
- [ ] **Fresh install test** — Wipe SD card, flash Kali, run installer, verify everything works

## Priority 6: MAVLink / Autonomous Hunt

- [x] **MAVLink waypoint export** — /api/waypoints endpoint (QGC WPL 110 format)
- [ ] **Convergence algorithm** — Design the logic for autonomous signal convergence
- [ ] **FC connection** — Test MAVLink serial connection to Matek H743 / Pixhawk 6C

## Priority 7: Documentation

- [ ] **Update README** — Reflect new endpoints, modules, CoT capability
- [ ] **API docs** — Auto-generate from FastAPI OpenAPI schema
- [ ] **CLAUDE.md** — Update with new module structure and endpoints

## Completed Since Last Session (Chunks 9-12, 2026-03-31)

- **Chunk 9:** QA audit — 12 browser issues fixed (stat counts, activity feed, detail panel, etc.)
- **Chunk 10:** Event logger with SHA-256 hash chain (chain-of-custody integrity)
- **Chunk 11:** TLS support, token auth, config validation, QA fixes 9-18
- **Chunk 12:** WiFi capture toggle fix (Kismet restart instead of hot-add), export status bar, logs auto-retry

## Completed This Session

- **Dynamic modem index** — Fixed hardcoded `mmcli -m 0` to auto-detect modem index (was at index 1)
- **GPS enabled** — NMEA data flowing, no fix indoors (expected)
- **CoT self-position** — New /api/cot/self endpoint for sensor platform SA in ATAK
- **BT classification boost** — 52% "other" → 1% with 30+ name patterns
- **KML export fix** — Proper coordinates, clear error without GPS
- **Async status endpoint** — 5x faster (2000ms → 400ms via asyncio.gather)
- **Async preflight** — Thread pool execution, no longer blocks event loop
- **Device count:** 850+ (up from 577)

---

## Session Workflow Reminder

1. CLI session: edit code, test endpoints, sync to /opt/sorcc/, restart service
2. Browser session: visual QA, multi-persona audit, report issues
3. Sync: `rsync -av --exclude='__pycache__' ~/SORCC-PI/sorcc/ /opt/sorcc/sorcc/`
4. Restart: `sudo systemctl restart sorcc-dashboard`
5. Commit + push after each chunk
