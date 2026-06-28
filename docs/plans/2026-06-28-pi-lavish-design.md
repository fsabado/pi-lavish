# pi-lavish Extension — Design Doc

**Date:** 2026-06-28  
**Status:** Approved  
**Repo:** `git@git-personal:fsabado/pi-lavish`

---

## Problem

`lavish-axi poll` is a blocking long-poll. The bash tool has a hard timeout ceiling,
so the agent can't hold an open poll in-band. The result: the Lavish chrome shows
"Your agent is not listening" and user feedback gets lost.

Pi-dashboard already solved the equivalent problem for its web chat view — it uses
`pi.sendUserMessage()` from inside a pi extension to inject browser messages directly
into the live pi session. Same session, no subprocess, no blocking.

---

## Goal

A pi extension (`pi-lavish`) that bridges the Lavish chrome conversation panel into
the running pi session. The user types in the Lavish browser, the message arrives in
pi as a real user turn. Pi replies, the reply appears in the chrome. The pi TUI
remains fully usable throughout — same session, display mode switch only.

---

## Architecture

### Repo structure

```
~/src/pi-lavish/
  index.ts        ← single extension file, no build step (jiti loads TS directly)
  package.json    ← { "name": "pi-lavish", "type": "module" }
  README.md
  docs/plans/
    2026-06-28-pi-lavish-design.md
```

### Installation

Added to `~/.pi/agent/settings.json` packages:

```json
{
  "source": "git:git@git-personal:fsabado/pi-lavish",
  "extensions": ["./index.ts"]
}
```

### No lavish-axi changes required

All existing public API endpoints used as-is:
- `GET /api/poll?file=<path>&timeoutMs=0` — immediate feedback check
- `POST /api/:key/agent-reply` — post pi's reply to chrome
- `~/.lavish-axi/state.json` — session discovery

---

## Activation

Extension registers at load time but does **zero work** until activated.
No timers, no polling, no widgets on startup.

### `/lavish [file]` command

- With `file`: canonicalize path, attach to that session
- Without `file`: read `~/.lavish-axi/state.json`, pick session with most-recent
  `updated_at` where `status === "open"`. Error if none found.
- On attach: start poll loop, show TUI widget

### `/lavish stop` command

- Stop poll loop, clear widget, post a final agent-reply if mid-conversation
- Does NOT end the lavish session in the browser — user can still read it

### Browser "ended" event

- Detected via `status: "ended"` response from poll endpoint
- Same deactivation as `/lavish stop` — stop loop, clear widget, notify user

---

## Core Loop

Single active session (v1). State:

```typescript
let activeSession: {
  file: string;       // canonical absolute path
  key: string;        // sha256 prefix session key
  timer: NodeJS.Timeout;
  cachedCtx: any;     // last known ExtensionCommandContext
} | null = null;
```

### Poll loop (3s interval, `timeoutMs=0`)

```
setInterval(3s):
  fetch GET /api/poll?file=<path>&timeoutMs=0
  
  {status:"waiting"}   → no-op
  {status:"feedback"}  → extract prompts[].text, annotations, layout_warnings
                       → pi.sendUserMessage(combined text, { triggerTurn: true })
  {status:"ended"}     → deactivate(), ctx.ui.notify("Lavish session ended", "info")
  fetch error          → log to stderr, keep looping (server may have restarted)
```

`timeoutMs=0` means: if feedback is queued → return it immediately; if nothing →
return `{status:"waiting"}` immediately. Never hangs. Non-blocking.

### Agent reply (`agent_end` hook)

```
agent_end fires (only if activeSession !== null):
  extract last assistant message text from event.messages
  fire-and-forget: fetch POST /api/<key>/agent-reply { text }
  (no await in handler — never blocks pi)
```

Posts on every `agent_end` while active — full text, no truncation, no filtering.
If the turn wasn't lavish-triggered, the reply still posts (mirrors what the agent
said in TUI to the chrome). Acceptable for v1.

---

## TUI Widget

Footer status via `ctx.ui.setStatus("lavish", ...)`:

| State | Display |
|-------|---------|
| Inactive | (nothing) |
| Waiting for user | `🎨 lavish · waiting` |
| Feedback received, pi working | `🎨 lavish · working` |
| Deactivated | cleared |

Updated in: `agent_end` (→ waiting), `sendUserMessage` call (→ working),
deactivate (→ clear).

---

## Data Flow

```
user types in chrome
  → POST /api/:key/prompts  (lavish chrome-client.js)
  → extension polls GET /api/poll?timeoutMs=0 every 3s
  → {status:"feedback"} → pi.sendUserMessage(text, { triggerTurn: true })
  → pi processes turn, agent_end fires
  → extension POST /api/:key/agent-reply with full assistant text
  → chrome conversation panel shows reply via SSE /events/:key
  → extension status → "waiting", loop resumes
```

---

## Decisions Log

| # | Question | Decision |
|---|----------|----------|
| 1 | Auto-detect via tool_result hook? | No — explicit `/lavish [file]` only |
| 2 | No file given → which session? | Most-recent `updated_at` with `status:"open"` |
| 3 | Agent reply content | Full last assistant message text |
| 4 | Multiple sessions v1? | Single active session only |
| 5 | When to post agent-reply? | Every `agent_end` while active |
| 6 | Deactivation | `/lavish stop` or browser `ended` — both stop loop |
| 7 | Blocking concern? | No — `timeoutMs=0` returns fast; `setInterval`+`fetch` is async |
| 8 | Lavish-axi changes? | None required |

---

## Out of Scope (v1)

- Multiple simultaneous lavish sessions
- Auto-activate when agent runs `lavish-axi open`
- Filtered/truncated agent replies
- `lavish_reply` tool for explicit LLM control
- Reconnect on lavish server restart (loop just logs error and continues)
