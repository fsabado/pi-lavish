# pi-lavish Implementation Plan

> **For Claude:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Build a pi extension that bridges the Lavish chrome conversation panel into the live pi session — user types in browser, message arrives as a real pi turn; pi replies, reply appears in chrome.

**Architecture:** Single TypeScript file loaded by pi via jiti (no build step). Registers `/lavish [file]` and `/lavish stop` commands. On activate: starts a 3s `setInterval` that hits `GET /api/poll?timeoutMs=0` and injects feedback via `pi.sendUserMessage()`. On `agent_end`: fire-and-forget `POST /api/:key/agent-reply` with last assistant text.

**Tech Stack:** TypeScript, pi ExtensionAPI, Node.js `fetch`, `fs/promises`

---

### Task 1: Repo scaffold

**Files:**
- Create: `~/src/pi-lavish/package.json`
- Create: `~/src/pi-lavish/index.ts`
- Create: `~/src/pi-lavish/README.md`

**Step 1: Create `package.json`**

```json
{
  "name": "pi-lavish",
  "version": "0.1.0",
  "type": "module",
  "description": "Pi extension — bridges Lavish chrome conversation into the live pi session"
}
```

**Step 2: Create stub `index.ts`**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // pi-lavish: stub
}
```

**Step 3: Create `README.md`**

```markdown
# pi-lavish

Pi extension that bridges [Lavish Editor](https://github.com/kunchenguid/lavish-axi)
chrome conversations into the live pi session.

## Install

Add to `~/.pi/agent/settings.json` packages:

```json
{
  "source": "git:git@git-personal:fsabado/pi-lavish",
  "extensions": ["./index.ts"]
}
```

## Usage

- `/lavish` — attach to most-recently opened lavish session
- `/lavish <file.html>` — attach to specific artifact
- `/lavish stop` — stop listening
```

**Step 4: Commit**

```bash
cd ~/src/pi-lavish
git add package.json index.ts README.md
git commit -m "chore: scaffold repo"
```

---

### Task 2: Session discovery helpers

**Files:**
- Modify: `~/src/pi-lavish/index.ts`

These are pure functions — easy to verify manually.

**Step 1: Add state.json types and `findLatestSession()`**

```typescript
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface LavishSession {
  key: string;
  file: string;
  status: "open" | "ended";
  updated_at: string;
}

interface LavishState {
  sessions: Record<string, LavishSession>;
}

async function readState(): Promise<LavishState> {
  const path = join(homedir(), ".lavish-axi", "state.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as LavishState;
}

async function findLatestSession(): Promise<LavishSession | null> {
  try {
    const state = await readState();
    const open = Object.values(state.sessions)
      .filter((s) => s.status === "open")
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return open[0] ?? null;
  } catch {
    return null;
  }
}

function sessionKey(file: string): string {
  // mirrors lavish-axi: sha256 of canonical path, first 16 hex chars
  // but we already have the key from state.json — no need to recompute
  throw new Error("use key from state.json directly");
}
```

**Step 2: Add `findSessionByFile(file: string)`**

```typescript
async function findSessionByFile(file: string): Promise<LavishSession | null> {
  try {
    const state = await readState();
    return Object.values(state.sessions).find(
      (s) => s.status === "open" && s.file === file
    ) ?? null;
  } catch {
    return null;
  }
}
```

**Step 3: Commit**

```bash
git add index.ts
git commit -m "feat: session discovery helpers"
```

---

### Task 3: Poll loop + feedback injection

**Files:**
- Modify: `~/src/pi-lavish/index.ts`

**Step 1: Add active session state and `deactivate()`**

```typescript
interface ActiveSession {
  file: string;
  key: string;
  timer: ReturnType<typeof setInterval>;
  cachedCtx: any;
}

let active: ActiveSession | null = null;

function deactivate(ctx?: any) {
  if (!active) return;
  clearInterval(active.timer);
  active = null;
  const c = ctx ?? active?.cachedCtx;
  c?.ui?.setStatus("lavish", undefined);
}
```

**Step 2: Add `startLoop(session, ctx)` with `timeoutMs=0` poll**

```typescript
const LAVISH_PORT = process.env.LAVISH_AXI_PORT ?? "4387";
const BASE_URL = `http://127.0.0.1:${LAVISH_PORT}`;

function startLoop(session: LavishSession, ctx: any, sendUserMessage: (text: string) => void) {
  const timer = setInterval(async () => {
    if (!active) return;
    try {
      const url = `${BASE_URL}/api/poll?file=${encodeURIComponent(session.file)}&timeoutMs=0`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as { status: string; prompts?: Array<{ text: string }>; layout_warnings?: any[] };

      if (data.status === "feedback") {
        const parts: string[] = [];
        if (data.prompts?.length) {
          parts.push(...data.prompts.map((p) => p.text));
        }
        if (data.layout_warnings?.length) {
          parts.push(`[layout warnings: ${JSON.stringify(data.layout_warnings)}]`);
        }
        const text = parts.join("\n\n");
        if (text.trim()) {
          active.cachedCtx = ctx;
          ctx.ui.setStatus("lavish", "🎨 lavish · working");
          sendUserMessage(text);
        }
      } else if (data.status === "ended") {
        ctx.ui.notify("Lavish session ended", "info");
        deactivate(ctx);
      }
    } catch {
      // server may be down — keep looping silently
    }
  }, 3000);

  active = { file: session.file, key: session.key, timer, cachedCtx: ctx };
  ctx.ui.setStatus("lavish", "🎨 lavish · waiting");
}
```

**Step 3: Commit**

```bash
git add index.ts
git commit -m "feat: poll loop and feedback injection"
```

---

### Task 4: `/lavish` and `/lavish stop` commands

**Files:**
- Modify: `~/src/pi-lavish/index.ts`

**Step 1: Wire up commands in the default export**

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("lavish", {
    description: "Attach to a Lavish session. Usage: /lavish [file.html] | /lavish stop",
    handler: async (args, ctx) => {
      const arg = args.trim();

      // /lavish stop
      if (arg === "stop") {
        if (!active) {
          ctx.ui.notify("Lavish: not active", "info");
          return;
        }
        deactivate(ctx);
        ctx.ui.notify("Lavish: stopped", "info");
        return;
      }

      // already active
      if (active) {
        ctx.ui.notify(`Lavish: already active on ${active.file}`, "info");
        return;
      }

      // resolve session
      let session: LavishSession | null = null;
      if (arg) {
        // canonicalize: resolve relative to cwd
        const { resolve } = await import("node:path");
        const abs = resolve(ctx.cwd, arg);
        session = await findSessionByFile(abs);
        if (!session) {
          ctx.ui.notify(`Lavish: no open session for ${abs}`, "error");
          return;
        }
      } else {
        session = await findLatestSession();
        if (!session) {
          ctx.ui.notify("Lavish: no open sessions found in ~/.lavish-axi/state.json", "error");
          return;
        }
      }

      startLoop(session, ctx, (text) => {
        (pi as any).sendUserMessage(text, { triggerTurn: true });
      });
      ctx.ui.notify(`Lavish: attached to ${session.file}`, "success");
    },
  });
}
```

**Step 2: Commit**

```bash
git add index.ts
git commit -m "feat: /lavish and /lavish stop commands"
```

---

### Task 5: `agent_end` → post reply to chrome

**Files:**
- Modify: `~/src/pi-lavish/index.ts`

**Step 1: Add `agent_end` handler inside default export**

```typescript
pi.on("agent_end", async (event: any, ctx: any) => {
  if (!active) return;

  // extract last assistant message text
  const messages: any[] = event?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  const content = lastAssistant?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  if (!text.trim()) return;

  // fire-and-forget — never await in agent_end
  const key = active.key;
  fetch(`${BASE_URL}/api/${key}/agent-reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {/* ignore */});

  // reset status to waiting
  ctx.ui.setStatus("lavish", "🎨 lavish · waiting");
  active.cachedCtx = ctx;
});
```

**Step 2: Commit**

```bash
git add index.ts
git commit -m "feat: agent_end posts reply to lavish chrome"
```

---

### Task 6: Push to remote + install in pi

**Step 1: Add remote and push**

```bash
cd ~/src/pi-lavish
git remote add origin git@git-personal:fsabado/pi-lavish.git
git push -u origin master
```

**Step 2: Add to `~/.pi/agent/settings.json` packages array**

Add entry:
```json
{
  "source": "git:git@git-personal:fsabado/pi-lavish",
  "extensions": ["./index.ts"]
}
```

**Step 3: Reload pi**

```
/reload
```

**Step 4: Smoke test**

```
lavish-axi /tmp/demo-artifact.html   # ensure server running + session open
/lavish                               # should attach, widget appears
# type in chrome → should arrive as pi turn
/lavish stop                          # widget clears
```

---

### Task 7: Fix and iterate

After smoke test, likely issues to fix:

- `pi.sendUserMessage` may need `(pi as any)` cast — verify at runtime
- `agent_end` event shape — log `event` keys first turn to confirm `messages` field name  
- `ctx.ui.setStatus(key, undefined)` to clear — verify that's the right clear call vs `setStatus(key, "")`
- LAVISH_AXI_PORT env var — confirm it's respected by the running server

**Commit any fixes:**
```bash
git add index.ts
git commit -m "fix: runtime adjustments from smoke test"
git push
```
