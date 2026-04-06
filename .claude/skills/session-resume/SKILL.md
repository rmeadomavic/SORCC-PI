---
name: session-resume
description: >
  Use at the start of every conversation to get caught up on project state.
  Runs system checks, reads memory, checks git status, service health, and
  TODO backlog to produce a concise "here's where we are" briefing.
  Trigger when: session starts, user says "catch me up", "where were we",
  "what's the status", "session resume", or opens a new conversation.
user-invocable: true
argument-hint: "[project name or 'all']"
---

# Session Resume — Get Caught Up Fast

You are producing a concise operational briefing for a returning developer.
Do NOT ask questions — just gather state and report. Be terse, factual, and
action-oriented. Format as a briefing, not a conversation.

## Step 1: Read Memory

Read the memory index and any relevant memory files:
- `~/.claude/projects/-home-kali/memory/MEMORY.md`
- Skim the top 5-6 most relevant memory files for current project context

## Step 2: System Health Check

Run these checks in parallel (use Bash tool):

```bash
# Git status for all repos
cd ~/Argus && echo "=== ARGUS ===" && git branch --show-current && git log --oneline -3 && git status -s
cd ~/hydra && echo "=== HYDRA ===" && git branch --show-current && git log --oneline -3 && git status -s

# Services
systemctl is-active kismet argus-dashboard argus-boot 2>/dev/null
systemctl is-failed kismet argus-dashboard argus-boot 2>/dev/null

# Network
tailscale ip -4 2>/dev/null
hostname

# Hardware
ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
hciconfig 2>/dev/null | head -5
lsusb 2>/dev/null | grep -iE "rtl|realtek|nooelec|sdr" 
ip link show wlan0 2>/dev/null | head -2

# Dashboard health
curl -s --max-time 3 http://localhost:8080/api/status 2>/dev/null
```

## Step 3: Read TODO Backlog

Read the current task list:
- `~/Argus/docs/NEXT-SESSION-TODO.md`

## Step 4: Produce the Briefing

Format your output as a compact briefing:

```
## Session Briefing — [date]

**Repos:**
- Argus: [branch] — [last commit summary] — [clean/dirty]
- Hydra: [branch] — [last commit summary] — [clean/dirty]

**Services:** [kismet: up/down] [dashboard: up/down] [boot: up/down]
**Network:** [tailscale IP] | [hostname] | [wifi status]
**Hardware:** [BT: yes/no] [SDR: yes/no] [GPS: yes/no] [LTE: yes/no]
**Dashboard:** [device count] devices | profile: [active] | [url]

**Last Session Summary:**
[2-3 bullet points from memory about what was accomplished]

**Next Up (from TODO):**
[Top 3 priority items that aren't marked done]

**Blockers/Notes:**
[Any failed services, missing hardware, dirty working trees, etc.]
```

## Rules

- Run all checks in parallel where possible
- Do NOT fix anything — just report
- Do NOT ask the user what to do — just present the briefing
- If a check fails or times out, report "unknown" — don't retry
- Keep the entire briefing under 40 lines
- If the user passed a project name argument, focus on that project only
