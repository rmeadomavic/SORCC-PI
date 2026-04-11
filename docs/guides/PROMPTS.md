# Session Prompts — Copy & Paste Ready

If your environment crashes or you're starting fresh, paste these into the right tab.

---

## Argus (Raspberry Pi)

**Setup:** `ssh kali@argus` → `cd ~/Argus` → `cc` → `/remote-control`

### Tab 1 — Claude Code
```
Start a recursive dev session on Argus. Check memory for session context
and docs/NEXT-SESSION-TODO.md for the task list. Deploy path is /opt/argus/,
repo is /home/kali/Argus/. Work through the TODO priorities in order.
My browser instance is watching the UI live and will feed back visual issues.

Quality bar: Palantir/Anduril grade — military functionality, civilian UX.
No blank screens, always last-known-good state. Work through improvements
in chunks, commit after each chunk. Cook.
```

### Tab 2 — Claude Chrome
```
I have two tabs open:
- Tab 1: Claude Code remote terminal connected to my Argus Pi
- Tab 2: Argus dashboard at http://100.71.115.45:8080

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
- A VIP deciding whether to fund this

Be ruthless. Report everything.
```

