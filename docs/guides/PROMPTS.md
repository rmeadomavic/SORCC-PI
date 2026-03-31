# Session Prompts — Copy & Paste Ready

If your environment crashes or you're starting fresh, paste these into the right tab.

---

## SORCC-PI (Raspberry Pi)

**Setup:** `ssh kali@100.71.115.45` → `cd ~/SORCC-PI` → `cc` → `/remote-control`

### Tab 1 — Claude Code
```
Start a recursive dev session on SORCC-PI. Check memory for session context
and docs/NEXT-SESSION-TODO.md for the task list. Deploy path is /opt/sorcc/,
repo is /home/kali/SORCC-PI/. Work through the TODO priorities in order.
My browser instance is watching the UI live and will feed back visual issues.

Quality bar: Palantir/Anduril grade — military functionality, civilian UX.
No blank screens, always last-known-good state. Work through improvements
in chunks, commit after each chunk. Cook.
```

### Tab 2 — Claude Chrome
```
I have two tabs open:
- Tab 1: Claude Code remote terminal connected to my SORCC Pi
- Tab 2: SORCC-PI dashboard at http://100.71.115.45:8080

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

## Hydra (Jetson)

**Setup:** `ssh jetson` → `cd ~/Hydra` → `cc` → `/remote-control`

### Tab 1 — Claude Code
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

### Tab 2 — Claude Chrome
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
