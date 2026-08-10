// ui/server.mjs: the whyAI kid interface server.
//
//   node ui/server.mjs    (serves http://localhost:3456)
//
// A deliberately tiny bridge: the browser page does voice in (browser
// speech recognition) and voice out (speechSynthesis); this server keeps ONE
// live gitagent SDK session so the conversation has real multi-turn memory,
// the safety hooks stay active, and the growth journal works. Claude is the
// only model anywhere in the loop.
//
// Session lifecycle (this is where the growth journal is guaranteed):
//   - every retirement path (new adventure, page close, the session-length
//     cap) first asks the old session to write its journal entry, in the
//     background, before the session object is dropped
//   - the session-length cap (default 20 minutes, WHYAI_SESSION_MINUTES to
//     override) is enforced HERE in code; RULES.md asks the model to land
//     softly, the interface guarantees the landing happens
//
// Uses the same SDK workaround as evals/run-evals.mjs: the public message
// stream closes after turn one (gitagent 2.0.2 quirk), so replies are read
// by polling q.messages().

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3456;
const SESSION_MAX_MS = Number(process.env.WHYAI_SESSION_MINUTES || 20) * 60_000;
const WRAPUP_PROMPT =
  "We are done for today. Please do your session wrap-up now: write the " +
  "growth journal entry for this session and save it with the memory tool.";

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PAGE = readFileSync(join(ROOT, "ui/index.html"));
const { query, deleteHistory } = await import("@open-gitagent/gitagent");
const { execSync } = await import("node:child_process");

// One kid session at a time, fully encapsulated so "new adventure" really
// starts from zero: nothing survives retirement except the growth journal
// (by design; the journal is the product).
let session = null;

const completedTurns = (msgs) =>
  msgs.filter((m) => m.type === "assistant" && ["stop", "error", "aborted"].includes(m.stopReason)).length;

function ensureSession() {
  if (session) return session;
  const s = { queue: [], wake: null, q: null, startedAt: Date.now(), userTurns: 0, retired: false };
  async function* feed() {
    while (true) {
      if (s.queue.length) {
        const msg = s.queue.shift();
        if (msg === null) return;
        yield { type: "user", content: msg };
      } else {
        await new Promise((r) => (s.wake = r));
      }
    }
  }
  s.q = query({ prompt: feed(), dir: ROOT, maxTurns: 400 });
  (async () => {
    try {
      for await (const _ of s.q) { /* drain; channel closes after turn one */ }
    } catch (err) {
      console.error(`[whyAI] session stream ended with error: ${err?.message || err}`);
      if (session === s) session = null; // self-heal: next message starts fresh
    }
  })();
  session = s;
  return s;
}

function push(s, msg) {
  s.queue.push(msg);
  if (s.wake) { const w = s.wake; s.wake = null; w(); }
}

// Retire a session. If it saw real conversation, ask it to journal first,
// then close the feed; runs in the background so the caller (a kid pressing
// "new adventure", a closing tab) never waits on it.
function retire(s, why) {
  if (!s || s.retired) return;
  s.retired = true;
  if (session === s) session = null;
  const wantsJournal = s.userTurns >= 2;
  (async () => {
    try {
      if (wantsJournal) {
        const before = completedTurns(s.q.messages());
        push(s, WRAPUP_PROMPT);
        push(s, null);
        const deadline = Date.now() + 90_000;
        while (completedTurns(s.q.messages()) <= before && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        console.log(`[whyAI] session retired (${why}): wrap-up ${completedTurns(s.q.messages()) > before ? "completed" : "timed out"} after ${s.userTurns} kid turns`);
      } else {
        push(s, null);
        console.log(`[whyAI] session retired (${why}): too short for a journal entry (${s.userTurns} turns)`);
      }
    } catch (err) {
      console.error(`[whyAI] retire error: ${err?.message || err}`);
    } finally {
      try { s.q.abort?.(); } catch { /* already gone */ }
    }
  })();
  // Defensive: wipe any per-branch chat history gitagent persisted, so no
  // cross-session context can leak outside the journal.
  try {
    const branch = execSync("git branch --show-current", { cwd: ROOT, encoding: "utf8" }).trim();
    deleteHistory?.(ROOT, branch);
  } catch { /* best effort */ }
}

// Serialize asks: overlapping requests (double-send, two tabs) process in
// order against the single session instead of cross-delivering replies.
let chain = Promise.resolve();
function ask(text) {
  const run = chain.then(() => askNow(text));
  chain = run.catch(() => { /* keep the chain alive after failures */ });
  return run;
}

async function askNow(text) {
  if (session && Date.now() - session.startedAt > SESSION_MAX_MS) {
    retire(session, "session length cap");
    return {
      reply:
        "What a lot of good thinking we did! My thinking time is up for now, " +
        "and I saved today's discoveries in your journal. Press new adventure " +
        "when you want to explore again!",
      sessionEnded: true,
    };
  }
  const s = ensureSession();
  s.userTurns += 1;
  const before = completedTurns(s.q.messages());
  push(s, text);

  const deadline = Date.now() + 90_000;
  while (completedTurns(s.q.messages()) <= before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 300));

  const msgs = s.q.messages();
  const lastUserIdx = msgs.map((m) => m.type).lastIndexOf("user");
  let reply = "";
  for (const m of msgs.slice(lastUserIdx + 1)) {
    if (m.type === "assistant" && m.content) reply += (reply ? "\n" : "") + m.content;
  }
  return { reply: reply || "Hmm, my thinking got tangled. Can you say that again?" };
}

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("error", () => resolve({}));
    req.on("aborted", () => resolve({}));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

// The only legitimate callers are pages served by this server. A cross-site
// form or fetch carries a foreign Origin: reject it. (Server binds to
// 127.0.0.1, but localhost is reachable from any site in the same browser.)
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // same-origin non-CORS requests may omit it
  return !new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${PORT}$`).test(origin);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.method === "POST") {
    if (foreignOrigin(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "forbidden" }));
    }
    if (req.url === "/api/say") {
      const { text } = await body(req);
      if (!text || typeof text !== "string" || text.length > 2000) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad text" }));
      }
      try {
        const out = await ask(text.trim());
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      } catch (err) {
        console.error(`[whyAI] /api/say failed: ${err?.stack || err}`);
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Something got tangled up in my thinking. Let's try again!" }));
      }
    }
    if (req.url === "/api/new" || req.url === "/api/bye") {
      retire(session, req.url === "/api/bye" ? "page closed" : "new adventure");
      res.writeHead(req.url === "/api/bye" ? 204 : 200, { "content-type": "application/json" });
      return res.end(req.url === "/api/bye" ? undefined : JSON.stringify({ ok: true }));
    }
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`whyAI kid interface: http://localhost:${PORT} (agent dir: ${ROOT}, session cap: ${SESSION_MAX_MS / 60000} min)`)
);
