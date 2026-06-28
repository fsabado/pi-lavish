# File-Based Feedback Implementation Plan

> **For Claude:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Remove the long-poll mechanism entirely; server writes a `feedback_file` on every user Send; agent reads it on next turn.

**Architecture:** Server writes `~/.lavish-axi/feedback/<key>.json` atomically after `queuePrompts`, `recordLayoutWarnings`, and `endSession`. `lavish-axi open` returns `feedback_file` path in its JSON output. `next_step` tells the agent to respond with summary + URL, then read the file next turn. Poll command, presence machinery, agent-reply, split send button all deleted.

**Tech Stack:** Node.js ESM, node:fs/promises (atomic rename), existing `paths.js` / `session-store.js` / `cli.js` / `server.js` / `chrome-client.js`.

**Design doc:** `docs/plans/2026-06-28-file-based-feedback-design.md`

---

### Task 1: Add `feedbackDir()` and `feedbackFile(key)` to paths.js

**Files:**

- Modify: `src/paths.js`
- Test: `test/server.test.js` (new test at bottom)

**Step 1: Write the failing test**

Add to `test/server.test.js`:

```js
import { feedbackDir, feedbackFile, stateDir } from "../src/paths.js";
import path from "node:path";

test("feedbackFile returns path under stateDir/feedback", () => {
  const key = "abc12345";
  assert.equal(feedbackFile(key), path.join(stateDir(), "feedback", `${key}.json`));
  assert.equal(feedbackDir(), path.join(stateDir(), "feedback"));
});
```

**Step 2: Run to verify it fails**

```bash
node --test --test-name-pattern "feedbackFile returns" test/server.test.js
```

Expected: FAIL — `feedbackDir is not exported`

**Step 3: Implement**

Add to end of `src/paths.js`:

```js
export function feedbackDir() {
  return path.join(stateDir(), "feedback");
}

export function feedbackFile(key) {
  return path.join(feedbackDir(), `${key}.json`);
}
```

**Step 4: Run to verify it passes**

```bash
node --test --test-name-pattern "feedbackFile returns" test/server.test.js
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/paths.js test/server.test.js
git commit -m "feat(paths): add feedbackDir and feedbackFile helpers"
```

---

### Task 2: Write feedback file from SessionStore

**Files:**

- Modify: `src/session-store.js`
- Test: `test/server.test.js`

**Step 1: Write the failing tests**

Add to `test/server.test.js` (spin up a real server, check file appears):

```js
test("server writes feedback_file after queuePrompts", async () => {
  const { base, artifact } = await openArtifact();
  const key = sessionKey(await canonicalFile(artifact));
  const ffile = feedbackFile(key);
  // ensure not present before
  await fs.rm(ffile, { force: true });
  await fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: [{ tag: "message", prompt: "hello" }] }),
  });
  const content = JSON.parse(await fs.readFile(ffile, "utf8"));
  assert.equal(content.status, "feedback");
  assert.ok(Array.isArray(content.prompts));
  assert.equal(content.prompts[0].prompt, "hello");
});

test("server writes feedback_file with status ended after endSession", async () => {
  const { base, artifact } = await openArtifact();
  const key = sessionKey(await canonicalFile(artifact));
  const ffile = feedbackFile(key);
  await fs.rm(ffile, { force: true });
  await fetch(`${base}/api/${key}/end`, { method: "POST" });
  const content = JSON.parse(await fs.readFile(ffile, "utf8"));
  assert.equal(content.status, "ended");
});

test("server writes feedback_file after recordLayoutWarnings when changed and non-empty", async () => {
  const { base, artifact } = await openArtifact();
  const key = sessionKey(await canonicalFile(artifact));
  const ffile = feedbackFile(key);
  await fs.rm(ffile, { force: true });
  await fetch(`${base}/api/${key}/layout-warnings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      layout_warnings: [{ selector: "body", kind: "overflow", severity: "error", overflowPx: 10, viewportWidth: 1280 }],
    }),
  });
  const content = JSON.parse(await fs.readFile(ffile, "utf8"));
  assert.equal(content.status, "feedback");
  assert.ok(content.layout_warnings.length > 0);
});
```

**Step 2: Run to verify they fail**

```bash
node --test --test-name-pattern "feedback_file" test/server.test.js
```

Expected: FAIL — file not found

**Step 3: Implement atomic write helper in session-store.js**

Add imports at top of `src/session-store.js`:

```js
import { mkdir, rename, writeFile as fsWriteFile } from "node:fs/promises";
import { feedbackDir, feedbackFile } from "./paths.js";
```

Add helper function (before the class):

```js
async function writeFeedbackFile(key, payload) {
  const dir = feedbackDir();
  await mkdir(dir, { recursive: true });
  const target = feedbackFile(key);
  const tmp = `${target}.tmp`;
  await fsWriteFile(tmp, JSON.stringify(payload));
  await rename(tmp, target);
}
```

In `queuePrompts`, after `await this.writeState(state)`:

```js
await writeFeedbackFile(key, {
  status: "feedback",
  prompts: session.prompts,
  dom_snapshot: session.dom_snapshot || "",
  ...(session.layout_warnings?.length ? { layout_warnings: session.layout_warnings } : {}),
});
```

In `recordLayoutWarnings`, after `await this.writeState(state)` (only when `changed && hasWarnings`):

```js
if (changed && hasWarnings) {
  await writeFeedbackFile(key, {
    status: "feedback",
    prompts: session.prompts || [],
    dom_snapshot: session.dom_snapshot || "",
    layout_warnings: session.layout_warnings,
  });
}
```

In `endSession`, after `await this.writeState(state)`:

```js
await writeFeedbackFile(key, { status: "ended" });
```

**Step 4: Run to verify they pass**

```bash
node --test --test-name-pattern "feedback_file" test/server.test.js
```

Expected: all 3 PASS

**Step 5: Run full test suite**

```bash
pnpm test
```

Expected: all pass

**Step 6: Commit**

```bash
git add src/session-store.js test/server.test.js
git commit -m "feat(session-store): write feedback_file atomically on queue/layout/end"
```

---

### Task 3: Add `feedback_file` to `lavish-axi open` output + rewrite `next_step`

**Files:**

- Modify: `src/cli.js`
- Test: `test/cli-output.test.js`

**Step 1: Write failing test**

In `test/cli-output.test.js`, find `createOpenOutput` tests and add:

```js
test("createOpenOutput includes feedback_file field", () => {
  const out = createOpenOutput({
    file: "/tmp/foo.html",
    url: "http://localhost:4387/session/abc",
    feedbackFile: "/home/user/.lavish-axi/feedback/abc.json",
    status: "opened",
  });
  assert.equal(out.feedback_file, "/home/user/.lavish-axi/feedback/abc.json");
  assert.ok(out.next_step.includes("/home/user/.lavish-axi/feedback/abc.json"));
  assert.ok(out.next_step.includes("http://localhost:4387/session/abc"));
  assert.ok(!out.next_step.includes("poll"));
});
```

**Step 2: Run to verify it fails**

```bash
node --test --test-name-pattern "feedback_file field" test/cli-output.test.js
```

Expected: FAIL

**Step 3: Implement**

In `src/cli.js`, add import at top:

```js
import { feedbackFile } from "./paths.js";
```

Replace `createOpenOutput`:

```js
export function createOpenOutput({ file, url, feedbackFile: ffile, status }) {
  return {
    session: { file, url, status },
    feedback_file: ffile,
    next_step:
      `Artifact is open at ${url}. Respond to the user now with: (1) a 2-3 sentence summary of what the artifact shows, (2) the full URL "${url}", (3) "Click Send in Lavish when you have feedback, then come back here." ` +
      `On your next turn, check whether \`${ffile}\` exists. If it does: read it, delete it, apply the feedback (fix layout_warnings before addressing human prompts). Edit the artifact HTML in place — the browser reloads automatically, no need to run lavish-axi open again. If it does not exist yet, tell the user feedback has not arrived and ask them to send it.`,
  };
}
```

In `openCommand`, update the return call:

```js
const key = sessionKey(absolute);
return createOpenOutput({
  file: absolute,
  url: response.url,
  feedbackFile: feedbackFile(key),
  status: response.status || "opened",
});
```

**Step 4: Run to verify it passes**

```bash
node --test --test-name-pattern "feedback_file field" test/cli-output.test.js
```

Expected: PASS

**Step 5: Run full suite**

```bash
pnpm test
```

Expected: all pass

**Step 6: Commit**

```bash
git add src/cli.js test/cli-output.test.js
git commit -m "feat(cli): include feedback_file in open output, rewrite next_step"
```

---

### Task 4: Delete poll command and all helpers from cli.js

**Files:**

- Modify: `src/cli.js`
- Test: `test/cli-output.test.js`

**Step 1: Write test confirming `poll` is not a known command**

```js
test("poll is not a registered command", async () => {
  // normalizeArgv should not treat 'poll' as a reserved command bypass
  // and COMMANDS set should not contain it
  const { COMMANDS } = await import("../src/cli.js");
  assert.ok(!COMMANDS.has("poll"));
});
```

**Step 2: Run to verify it fails**

```bash
node --test --test-name-pattern "poll is not" test/cli-output.test.js
```

Expected: FAIL — `poll` is still in COMMANDS

**Step 3: Delete from cli.js**

- Remove `"poll"` from `COMMANDS` set (line 17)
- Remove `poll: pollCommand,` from commands object (line 55)
- Delete `async function pollCommand(args) { ... }` (lines 189–229)
- Delete `export function pollWaitBannerText(...)` (lines 232–237)
- Delete `export function pollWaitTickText(...)` (lines 239–242)
- Delete `export function pollInterruptedText(...)` (lines 244–248)
- Delete `function startPollWaitReporter(...)` (lines 250–267)
- Delete `export function createPollOutput(...)` (lines 268–291)
- Delete `function createFeedbackNextStep(...)` (lines 293–309)
- Remove `--agent-reply` handling from what remains
- Update `DESCRIPTION` string — remove `lavish-axi poll` mention
- Update `visual_guidance` array entry referencing poll (line 128)

**Step 4: Run to verify test passes**

```bash
node --test --test-name-pattern "poll is not" test/cli-output.test.js
```

Expected: PASS

**Step 5: Run full suite — fix any broken imports/references**

```bash
pnpm test
```

**Step 6: Commit**

```bash
git add src/cli.js test/cli-output.test.js
git commit -m "feat(cli): remove poll command, agent-reply, poll helpers"
```

---

### Task 5: Delete poll route and presence machinery from server.js

**Files:**

- Modify: `src/server.js`
- Test: `test/server.test.js`

**Step 1: Delete the following from server.js**

- `GET /api/poll` route handler (lines 109–184)
- `POST /api/:key/agent-reply` route handler
- `pollHeartbeatMs` parameter from `serve()` signature and default
- `activePolls` Map declaration
- `deliveredFeedback` Set declaration
- `setPollActive()` function
- `markFeedbackDelivered()` function
- `clearFeedbackDelivery()` function
- `computePresence()` function (export)
- `agent-presence` SSE event emission (all 3 call sites)
- `agent-presence` SSE event listener registration in `/events/:key`
- `activePolls.size` checks in idle timer logic — replace with `sseClients.size > 0` only
- `pollHeartbeatMs` from `serve()` test helper calls

**Step 2: Delete the corresponding tests from server.test.js**

Delete tests matching these names:

- `"layout warnings wake the same long-poll feedback channel"`
- `"long-poll sends heartbeat bytes before feedback arrives"`
- `"SSE agent-presence reflects waiting, listening, and working"`
- `"SSE handshake reports waiting on a fresh session that never had a poll"`
- `"SSE agent-presence returns to waiting when a poll times out"`
- `"SSE agent-presence returns to waiting when a poll disconnects"`
- `"SSE agent-presence returns to waiting when poll feedback storage fails"`
- `"long-poll response cleanup is guarded against storage failures"`
- `"heartbeat long-poll errors close the stream without Express error handling"`
- `"SSE agent-presence switches to working when poll immediately takes queued feedback"`
- `"SSE agent-presence resets to waiting after ending and reopening"`
- `"SSE agent-presence stays working when resuming an open session"`
- `"chrome shows agent working state when a previous poll has released"`

**Step 3: Run full suite**

```bash
pnpm test
```

Expected: all pass, fewer tests than before

**Step 4: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat(server): remove poll route, agent-reply, presence machinery"
```

---

### Task 6: Update chrome UI — collapse Send button, remove presence banner

**Files:**

- Modify: `src/server.js` (chrome HTML template string)
- Modify: `src/chrome-client.js`

**Step 1: chrome HTML (server.js)**

In the chrome HTML template:

- Remove `<div class="presence-banner" id="presenceBanner" hidden>...</div>`
- Replace the split-button structure:
  ```html
  <div class="split"><button ...>Send to Agent</button><button id="sendCaret" ...></button></div>
  <div class="menu send-menu" id="sendMenu" hidden>...</div>
  ```
  with a single button:
  ```html
  <button class="button send-main" id="send" type="button">Send</button>
  ```
- Remove `#sendAndEnd`, `#sendFromMenu`, `#sendCaret`, `#sendMenu` elements

**Step 2: chrome-client.js**

- Remove all `presenceBanner` show/hide logic
- Remove `sendAndEnd`, `sendFromMenu`, `sendCaret`, `sendMenu` references
- Remove agent-presence SSE event handler (`events.addEventListener("agent-presence", ...)`)
- After successful `POST /api/:key/prompts`, show inline "Sent." confirmation on the send button:
  ```js
  send.textContent = "Sent.";
  send.disabled = true;
  setTimeout(() => {
    send.textContent = "Send";
    send.disabled = false;
  }, 1500);
  ```
- Remove `Enter` → send-from-menu path; keep `Enter` → `send.click()` only

**Step 3: Run full suite + visual check**

```bash
pnpm test
npx -y lavish-axi test/fixtures/some.html  # or any fixture
```

Verify: single Send button, no presence banner, "Sent." flash on click.

**Step 4: Commit**

```bash
git add src/server.js src/chrome-client.js
git commit -m "feat(chrome): collapse send button, remove presence banner"
```

---

### Task 7: Update skill.js and SKILL.md

**Files:**

- Modify: `src/skill.js`
- Rebuild: `skills/lavish/SKILL.md` via `pnpm run build:skill`

**Step 1: Update workflow in `createHomeOutput` / `cli.js`**

In `src/cli.js`, find the `visual_guidance` / workflow array in `createHomeOutput`. Replace the poll references with:

```js
"Run `lavish-axi <html-file>` once to open or resume a review session.",
"Respond immediately with a 2-3 sentence summary and the full session URL.",
"Tell the user: \"Click Send in Lavish when you have feedback, then come back here.\"",
"On your next turn, read and delete `feedback_file` (path returned by the open command).",
"If layout_warnings are present, fix them before addressing human prompts.",
"Edit the artifact HTML in place — the browser reloads automatically.",
"For a new artifact, run `lavish-axi open` again; sessions coexist.",
```

Also update `DESCRIPTION` in `cli.js` — remove `lavish-axi poll` reference.

**Step 2: Rebuild SKILL.md**

```bash
pnpm run build:skill
```

**Step 3: Run freshness check**

```bash
pnpm run check
```

Expected: skill freshness check passes

**Step 4: Commit**

```bash
git add src/cli.js skills/lavish/SKILL.md
git commit -m "docs(skill): rewrite workflow — file-based feedback, no poll"
```

---

### Task 8: Final check

**Step 1: Full suite**

```bash
pnpm run check
```

Expected: build, lint, format, typecheck, tests, skill freshness — all pass

**Step 2: Smoke test**

```bash
npx -y lavish-axi <any-html-file>
# Verify: JSON output has feedback_file field, next_step mentions the path not "poll"
# Open the browser URL — verify single Send button, no presence banner
# Click Send — verify "Sent." flash
# Check ~/.lavish-axi/feedback/<key>.json exists with prompts
```

**Step 3: Commit if any fixups needed, then tag**

```bash
git add -A && git commit -m "chore: post-cleanup fixups" # only if needed
```
