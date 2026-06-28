/**
 * pi-lavish
 *
 * Pi extension that bridges the Lavish Editor chrome conversation panel
 * into the live pi session. User types in the Lavish browser → message
 * arrives as a real pi turn. Pi replies → reply appears in chrome.
 *
 * Commands:
 *   /lavish [file.html]  — attach to lavish session (latest if no file given)
 *   /lavish stop         — stop listening
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LavishSession {
  key: string;
  file: string;
  status: "open" | "ended";
  updated_at: string;
}

interface LavishState {
  sessions: Record<string, LavishSession>;
}

interface PollFeedback {
  status: "waiting" | "feedback" | "ended";
  prompts?: Array<{ text: string; tag?: string }>;
  layout_warnings?: unknown[];
}

interface ActiveSession {
  file: string;
  key: string;
  timer: ReturnType<typeof setInterval>;
  cachedCtx: any;
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

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
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    return open[0] ?? null;
  } catch {
    return null;
  }
}

async function findSessionByFile(
  file: string
): Promise<LavishSession | null> {
  try {
    const state = await readState();
    return (
      Object.values(state.sessions).find(
        (s) => s.status === "open" && s.file === file
      ) ?? null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Active session state
// ---------------------------------------------------------------------------

let active: ActiveSession | null = null;

function deactivate(ctx?: any) {
  if (!active) return;
  clearInterval(active.timer);
  const c = ctx ?? active.cachedCtx;
  try {
    c?.ui?.setStatus("lavish", undefined);
  } catch {
    // ignore if ctx is stale
  }
  active = null;
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

const LAVISH_PORT = process.env.LAVISH_AXI_PORT ?? "4387";
const BASE_URL = `http://127.0.0.1:${LAVISH_PORT}`;

function startLoop(
  session: LavishSession,
  ctx: any,
  sendUserMessage: (text: string) => void
) {
  const timer = setInterval(async () => {
    if (!active) return;

    try {
      const url = `${BASE_URL}/api/poll?file=${encodeURIComponent(
        session.file
      )}&timeoutMs=0`;
      const res = await fetch(url);
      if (!res.ok) return;

      const data = (await res.json()) as PollFeedback;

      if (data.status === "feedback") {
        const parts: string[] = [];

        if (data.prompts?.length) {
          parts.push(...data.prompts.map((p) => p.text).filter(Boolean));
        }
        if (data.layout_warnings?.length) {
          parts.push(
            `[layout warnings detected: ${JSON.stringify(data.layout_warnings)}]`
          );
        }

        const text = parts.join("\n\n").trim();
        if (text) {
          active.cachedCtx = ctx;
          try {
            active.cachedCtx.ui.setStatus("lavish", "🎨 lavish · working");
          } catch {
            // ignore
          }
          sendUserMessage(text);
        }
      } else if (data.status === "ended") {
        const c = active.cachedCtx ?? ctx;
        deactivate(c);
        try {
          c?.ui?.notify("Lavish session ended", "info");
        } catch {
          // ignore
        }
      }
    } catch {
      // server may be down or restarting — keep looping silently
    }
  }, 3000);

  active = { file: session.file, key: session.key, timer, cachedCtx: ctx };
  try {
    ctx.ui.setStatus("lavish", "🎨 lavish · waiting");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // /lavish [file] | /lavish stop
  pi.registerCommand("pi-lavish", {
    description:
      "Attach to a Lavish Editor session. Usage: /pi-lavish [file.html] | /pi-lavish stop",
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim();

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
        const abs = resolve(ctx.cwd, arg);
        session = await findSessionByFile(abs);
        if (!session) {
          ctx.ui.notify(`Lavish: no open session for ${abs}`, "error");
          return;
        }
      } else {
        session = await findLatestSession();
        if (!session) {
          ctx.ui.notify(
            "Lavish: no open sessions found in ~/.lavish-axi/state.json",
            "error"
          );
          return;
        }
      }

      startLoop(session, ctx, (text: string) => {
        (pi as any).sendUserMessage(text, { triggerTurn: true });
      });

      ctx.ui.notify(`Lavish: attached → ${session.file}`, "success");
    },
  });

  // agent_end → post last assistant text back to chrome
  pi.on("agent_end", async (event: any, ctx: any) => {
    if (!active) return;

    // extract last assistant message text
    const messages: any[] = event?.messages ?? [];
    const lastAssistant = [...messages]
      .reverse()
      .find((m: any) => m.role === "assistant");

    const content = lastAssistant?.content;
    let text = "";

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text as string)
        .join("\n");
    }

    if (!text.trim()) return;

    // fire-and-forget — never await in agent_end
    const key = active.key;
    fetch(`${BASE_URL}/api/${key}/agent-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {
      /* ignore */
    });

    // reset status back to waiting
    try {
      active.cachedCtx = ctx;
      ctx.ui.setStatus("lavish", "🎨 lavish · waiting");
    } catch {
      // ignore
    }
  });
}
