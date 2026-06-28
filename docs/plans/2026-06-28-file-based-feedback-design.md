# File-Based Feedback Design

**Date:** 2026-06-28  
**Status:** Approved

## Problem

`GET /api/poll` holds an open HTTP connection until the user sends feedback. Agent harnesses
(including pi) kill foreground processes on timeout. The agent never receives the response.
The current workaround — "re-run if killed, feedback is never lost" — papers over the
breakage but doesn't fix it.

## Solution

Remove polling entirely. The server writes feedback to a well-known file after every user
action. The agent reads it on its next turn. No blocking process. No open connection.

The user reviews the artifact in Lavish, clicks **Send**, then switches back to pi and prompts
the agent. The agent reads the feedback file at the start of that turn, applies it, edits the
HTML in place, and the browser reloads automatically via the existing chokidar watcher.

---

## Data Flow

```
User acts in Lavish browser (Send button)
        │
        ▼
POST /api/:key/prompts  (unchanged)
        │
        ├─► state.json          (unchanged — source of truth)
        └─► ~/.lavish-axi/feedback/<key>.json   (NEW — atomic write)

User switches back to pi TUI, sends a prompt

Agent next turn:
  reads ~/.lavish-axi/feedback/<key>.json
  deletes it  (marks consumed)
  applies feedback, edits artifact HTML in place
  browser auto-reloads via chokidar SSE  (no lavish-axi open needed)
  responds to user with summary + same URL
```

---

## Feedback File

**Path:** `~/.lavish-axi/feedback/<key>.json`  
(`LAVISH_AXI_STATE_DIR` override applies: `$LAVISH_AXI_STATE_DIR/feedback/<key>.json`)

**Key:** same `sessionKey()` sha256 prefix already used everywhere.

**Written by server:** atomically (write to `.tmp`, rename) after:

- `POST /api/:key/prompts` — user sends feedback
- `POST /api/:key/layout-warnings` — browser reports layout issues (changed, non-empty)
- `POST /api/:key/end` — session ended

**Content:** snapshot of current pending state — same shape `takeFeedback()` returns today:

```json
{
  "status": "feedback",
  "prompts": [...],
  "dom_snapshot": "...",
  "layout_warnings": [...]
}
```

Or on end:

```json
{ "status": "ended" }
```

**Overwrite semantics:** each write replaces the previous file. Multiple Sends between agent
turns accumulate in `state.json` normally; the file written on each Send reflects the full
current pending state. Agent always sees the complete picture regardless of how many times
the user hit Send.

**Agent contract:**

- Read the file at the start of the turn
- Delete it after reading (signals consumed; prevents re-reading stale feedback)
- If the file doesn't exist, tell the user feedback hasn't arrived yet

**No cleanup by server.** Stale files from abandoned sessions are inert — they get
overwritten on the next Send to that session.

---

## `lavish-axi open` Output Changes

`feedback_file` added as a first-class field:

```json
{
  "session": {
    "file": "/path/to/artifact.html",
    "url": "http://127.0.0.1:4387/session/abc123",
    "status": "opened"
  },
  "feedback_file": "/Users/you/.lavish-axi/feedback/abc123.json",
  "next_step": "..."
}
```

`next_step` rewritten (see Skill section below).

---

## Iterative Loop

`lavish-axi open` is called **once per session** — not after every iteration.

After the first open, the chokidar watcher is running on the artifact file. The agent edits
the HTML in place; the browser reloads automatically via the existing `event: reload` SSE.
No CLI call needed to push updates.

```
lavish-axi open artifact.html   ← once

Turn N:
  agent reads feedback_file, deletes it
  agent edits artifact.html in place
  browser reloads automatically
  agent responds: summary of changes + same URL

  [user reviews updated artifact, sends more feedback]
  server overwrites feedback_file

  user prompts agent again → Turn N+1
```

If the agent creates a **new artifact** (different file), it calls `lavish-axi open` on the
new file. The old session coexists — sessions are independent, `state.json` handles both.

---

## Browser UI Changes

**Send button:** collapse split-button ("Send to Agent" / "Send & end session") to a single
**Send** button. After a successful POST, show inline confirmation: **"Sent."**

The user may send multiple times before returning to pi. Each Send appends to the
conversation history and overwrites the feedback file with the full current state. It is the
user's responsibility to switch back to pi and prompt the agent when ready.

No presence banner. No "listening" / "working" / "waiting" states. These are removed.

---

## What Is Deleted

| Deleted                                    | Location                                     |
| ------------------------------------------ | -------------------------------------------- |
| `GET /api/poll` route                      | `server.js`                                  |
| `pollHeartbeatMs` option                   | `server.js`                                  |
| `activePolls` Map                          | `server.js`                                  |
| `deliveredFeedback` Set                    | `server.js`                                  |
| `setPollActive()`                          | `server.js`                                  |
| `markFeedbackDelivered()`                  | `server.js`                                  |
| `clearFeedbackDelivery()`                  | `server.js`                                  |
| `computePresence()`                        | `server.js`                                  |
| `agent-presence` SSE event                 | `server.js`                                  |
| `pollCommand()` + all helpers              | `cli.js`                                     |
| `pollWaitBannerText()`                     | `cli.js`                                     |
| `pollWaitTickText()`                       | `cli.js`                                     |
| `pollInterruptedText()`                    | `cli.js`                                     |
| `startPollWaitReporter()`                  | `cli.js`                                     |
| `createPollOutput()`                       | `cli.js`                                     |
| `poll` entry in `COMMANDS` set             | `cli.js`                                     |
| `--agent-reply` flag                       | `cli.js`                                     |
| `POST /api/:key/agent-reply` route         | `server.js`                                  |
| Presence banner `#presenceBanner`          | `server.js` chrome HTML                      |
| Split send button + `#sendAndEnd`          | `server.js` chrome HTML + `chrome-client.js` |
| Agent-presence logic in `chrome-client.js` | `chrome-client.js`                           |
| All long-poll, heartbeat, presence tests   | `test/server.test.js`                        |

## What Is Kept

| Kept                                                               | Notes                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `POST /api/:key/prompts`                                           | unchanged                                                |
| `POST /api/:key/layout-warnings`                                   | unchanged                                                |
| `POST /api/:key/end`                                               | unchanged (server still tracks ended state)              |
| `state.json` schema                                                | unchanged                                                |
| SSE `/events/:key`                                                 | kept for live reload + `chrome-reload` on server restart |
| `event: reload` SSE                                                | chokidar → browser iframe reload, unchanged              |
| Layout audit + gate curtain                                        | unchanged                                                |
| `lavish-axi open`, `stop`, `server`, `playbook`, `design`, `setup` | unchanged                                                |
| `--no-open`, `--no-gate` flags                                     | unchanged                                                |
| Session identity via `sessionKey()`                                | unchanged                                                |

---

## New Additions

| Addition                                                                 | Location           |
| ------------------------------------------------------------------------ | ------------------ |
| `feedbackDir()`                                                          | `paths.js`         |
| `feedbackFile(key)`                                                      | `paths.js`         |
| Atomic feedback write after `queuePrompts`                               | `session-store.js` |
| Atomic feedback write after `recordLayoutWarnings` (changed + non-empty) | `session-store.js` |
| Atomic feedback write (`{status:"ended"}`) after `endSession`            | `session-store.js` |
| `feedback_file` field in `createOpenOutput`                              | `cli.js`           |
| Rewritten `next_step` in `createOpenOutput`                              | `cli.js`           |
| "Sent." confirmation in Send button                                      | `chrome-client.js` |

---

## New Paths (paths.js)

```js
export function feedbackDir() {
  return path.join(stateDir(), "feedback");
}

export function feedbackFile(key) {
  return path.join(feedbackDir(), `${key}.json`);
}
```

---

## Updated Skill Workflow

```markdown
## Workflow

1. Create the HTML artifact (default: `.lavish/<name>.html` in the working directory).
2. Run `npx -y lavish-axi <html-file>` — only once per review session.
   The response includes `session.url` and `feedback_file`.
3. Respond to the user immediately:
   - 2-3 sentence summary of what the artifact shows
   - Full URL: "Review it here: <session.url>"
   - "Click Send in Lavish when you have feedback, then come back here."
4. On your next turn, check whether `feedback_file` exists.
   - Exists: read it, delete it, apply feedback.
     If `layout_warnings` are present, fix overflow/clipping/overlap first.
   - Does not exist: tell the user feedback hasn't arrived and ask them to send it.
5. Edit the artifact HTML in place — the browser reloads automatically.
   No need to re-run `lavish-axi open`.
6. Respond with a short summary of the changes and the same URL link.
   Repeat from step 4.

For a new artifact (different file): run `lavish-axi open` on the new file.
The previous session continues to run alongside it.
```

---

## `next_step` Rewrite (createOpenOutput)

```
Artifact is open at <url>. Respond to the user now with: (1) a 2-3 sentence
summary of what the artifact shows, (2) the full URL "<url>", (3) "Click Send in
Lavish when you have feedback, then come back here." On your next turn, read
`<feedback_file>` — it contains their prompts and any layout warnings. Delete
the file after reading. Edit the artifact HTML in place to apply feedback; the
browser reloads automatically. No need to run lavish-axi open again.
```

---

## Test Changes

**Delete (~15 tests):**

- Long-poll blocks until feedback
- Long-poll heartbeat bytes
- `GET /api/poll` timeout / disconnect / storage failure
- SSE agent-presence transitions (waiting → listening → working)
- `--agent-reply` / `POST /api/:key/agent-reply`

**Add (~4 tests):**

- Server writes `feedback_file` after `queuePrompts`
- Server writes `feedback_file` after `recordLayoutWarnings` (changed + non-empty)
- Server writes `feedback_file` with `{status:"ended"}` after `endSession`
- `feedbackFile(key)` returns correct path under `stateDir()`
