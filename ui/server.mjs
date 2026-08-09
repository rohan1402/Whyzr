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
// Uses the same SDK workaround as evals/run-evals.mjs: the public message
// stream closes after turn one (gitagent 2.0.2 quirk), so replies are read
// by polling q.messages().

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3456;

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { query, deleteHistory } = await import("@open-gitagent/gitagent");
const { execSync } = await import("node:child_process");

// One kid session at a time, fully encapsulated so "new adventure" really
// starts from zero: page load and the new button both retire the old session
// object; nothing survives except the growth journal (by design).
let session = null;

function newSession() {
  const old = session;
  session = null;
  if (old) {
    try { old.queue.push(null); old.wake?.(); } catch { /* draining */ }
    try { old.q.abort?.(); } catch { /* already gone */ }
  }
  // Defensive: also wipe any per-branch chat history gitagent persisted, so
  // no cross-session context can leak outside the journal.
  try {
    const branch = execSync("git branch --show-current", { cwd: ROOT, encoding: "utf8" }).trim();
    deleteHistory?.(ROOT, branch);
  } catch { /* best effort */ }
}

function ensureSession() {
  if (session) return session;
  const s = { queue: [], wake: null, q: null };
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
  (async () => { try { for await (const _ of s.q) { /* drain */ } } catch { /* session ended */ } })();
  session = s;
  return s;
}

const completedTurns = (msgs) =>
  msgs.filter((m) => m.type === "assistant" && ["stop", "error", "aborted"].includes(m.stopReason)).length;

async function ask(text) {
  const s = ensureSession();
  const before = completedTurns(s.q.messages());
  s.queue.push(text);
  if (s.wake) { const w = s.wake; s.wake = null; w(); }

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
  return reply || "Hmm, my thinking got tangled. Can you say that again?";
}

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(ROOT, "ui/index.html")));
  }
  if (req.method === "POST" && req.url === "/api/say") {
    const { text } = await body(req);
    if (!text || typeof text !== "string" || text.length > 2000) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad text" }));
    }
    try {
      const reply = await ask(text.trim());
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ reply }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }
  if (req.method === "POST" && req.url === "/api/new") {
    newSession();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`whyAI kid interface: http://localhost:${PORT} (agent dir: ${ROOT})`)
);
