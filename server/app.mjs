// server/app.mjs: the hosted Whyzr app.
//
//   node server/app.mjs
//
// Middleware order on every request: rate limit, then auth, then caps, then
// gitagent. An unauthenticated or capped request never reaches the model, so
// it can never spend money.
//
// Routes
//   GET  /                      kid app (code screen -> setup -> chat)
//   POST /api/code              exchange the access code for a device token
//   GET  /api/me                who am I, and am I set up yet
//   POST /api/setup             nickname + age + parent PIN, provisions repo
//   POST /api/say               a turn of conversation
//   POST /api/new  /api/bye     retire the session (journal is written)
//   GET  /parent                parent dashboard (PIN gated)
//   POST /api/parent/login      exchange PIN for a short-lived parent token
//   GET  /api/parent/data       journal cards, progress report, rules, history
//   POST /api/parent/rules      save edited rules (commits in kid repo only)
//   POST /api/parent/restore    restore original rules
//   GET  /admin                 Rohan's review page (ADMIN_KEY gated)
//   GET  /api/admin/*           transcripts + full repo history

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config, LOCAL_DEV, REPO_ROOT, ensureDataDirs, paths } from "./config.mjs";
import * as registry from "./registry.mjs";
import * as auth from "./auth.mjs";
import * as caps from "./caps.mjs";
import * as sessions from "./sessions.mjs";
import * as journal from "./journal.mjs";
import { provisionKidRepo, snapAge, changeAgeBranch, assertNoRemotes, git } from "./repos.mjs";
import { listTranscripts, readTranscript } from "./transcripts.mjs";

ensureDataDirs();

// Device tokens issued before any kid exists (very first visit). A token here
// may complete setup exactly once, after which it is bound to that kid.
const pendingTokens = new Set();

const page = (name) => readFileSync(join(REPO_ROOT, "ui", name));
// No admin page by design: review is a terminal job (npm run review), not a
// screen. The admin API endpoints below back that CLI.
const PAGES = {
  kid: page("index.html"),
  parent: page("parent.html"),
};

// ---------------------------------------------------------------- helpers
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const html = (res, body) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 200_000) { req.destroy(); resolve({}); return; }
      data += c;
    });
    req.on("error", () => resolve({}));
    req.on("aborted", () => resolve({}));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

// Accept same-origin requests (including the deployed domain), reject genuine
// cross-site origins. Compares the Origin host to the request Host.
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // same-origin non-CORS requests may omit it
  try {
    return new URL(origin).host !== String(req.headers.host || "");
  } catch {
    return true;
  }
}

// Simple in-memory token bucket per IP. One small instance, low concurrency.
const buckets = new Map();
function rateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, resetAt: now + config.rateWindowMs };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + config.rateWindowMs; }
  b.count += 1;
  buckets.set(ip, b);
  if (buckets.size > 5000) buckets.clear(); // crude ceiling, fine for M1
  return b.count > config.rateMaxRequests;
}

// Short-lived parent tokens, in memory: the dashboard is a single visit.
const parentTokens = new Map();
function issueParentToken(kidId) {
  const t = randomBytes(18).toString("base64url");
  parentTokens.set(t, { kidId, expires: Date.now() + 30 * 60_000 });
  return t;
}
function parentKid(req, url) {
  const t = url.searchParams.get("t") || req.headers["x-whyzr-parent"] || "";
  const rec = parentTokens.get(t);
  if (!rec || rec.expires < Date.now()) return null;
  return rec.kidId;
}

const adminOk = (url, req) =>
  auth.checkAdminKey(url.searchParams.get("key") || req.headers["x-admin-key"] || "");

// ------------------------------------------------------------------ routes
async function handle(req, res, url) {
  const { pathname } = url;

  // Pages
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) return html(res, PAGES.kid);
  if (req.method === "GET" && pathname === "/parent") return html(res, PAGES.parent);
  if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });

  // --- kid: access code -> device token
  if (req.method === "POST" && pathname === "/api/code") {
    const { code } = await body(req);
    const result = auth.checkCode(code);
    if (!result.ok) {
      console.warn(`[whyzr] rejected access code from ${req.socket.remoteAddress}`);
      return json(res, 401, { error: "That code did not work. Ask the grown-up who sent you the link." });
    }
    // Bind to an existing kid if there is one (M1: single tester). On a first
    // ever visit no kid exists yet, so the token is held as pending and binds
    // when setup completes.
    const token = auth.issueToken();
    const kids = Object.keys(registry.read().kids);
    if (kids.length === 1) await auth.bindToken(kids[0], token);
    else pendingTokens.add(token);
    return json(res, 200, { ok: true, setUp: kids.length === 1 }, { "set-cookie": auth.tokenCookie(token) });
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const kidId = auth.kidFromRequest(req);
    if (kidId) {
      const kid = registry.getKid(kidId);
      return json(res, 200, {
        authed: true, setUp: true, nickname: kid.nickname, age: kid.age,
        napping: caps.napping(), localDev: LOCAL_DEV,
      });
    }
    const token = auth.parseCookies(req).whyzr_token;
    const authed = LOCAL_DEV || (token && pendingTokens.has(token));
    return json(res, 200, { authed: Boolean(authed), setUp: false, napping: caps.napping(), localDev: LOCAL_DEV });
  }

  // --- kid: first-run setup
  if (req.method === "POST" && pathname === "/api/setup") {
    const token = auth.parseCookies(req).whyzr_token;
    const existing = auth.kidFromRequest(req);
    if (!LOCAL_DEV && !existing && !(token && pendingTokens.has(token))) {
      return json(res, 401, { error: "Enter the code first." });
    }
    const { nickname, age, pin, parentConfirmed } = await body(req);
    if (!nickname || String(nickname).trim().length < 1) return json(res, 400, { error: "Pick a nickname." });
    if (!parentConfirmed) return json(res, 400, { error: "A grown-up needs to confirm this setup." });
    if (!pin || !/^\d{4,8}$/.test(String(pin))) return json(res, 400, { error: "Choose a 4 to 8 digit parent PIN." });

    const snap = snapAge(age);

    if (existing) {
      // Age change on an existing kid: carry the journal across branches.
      const kid = registry.getKid(existing);
      const dir = paths.kidRepo(existing);
      if (kid.branch !== snap.branch) {
        changeAgeBranch(dir, kid.branch, snap.branch);
        await registry.update((reg) => {
          reg.kids[existing].branch = snap.branch;
          reg.kids[existing].age = snap.age;
        });
      }
      return json(res, 200, { ok: true, nickname: kid.nickname, age: snap.age, note: snap.note });
    }

    const kidId = await registry.createKid({
      nickname, age: snap.age, branch: snap.branch, pinHash: auth.hashPin(pin),
    });
    provisionKidRepo(kidId, snap.branch);
    const bind = token || auth.issueToken();
    await auth.bindToken(kidId, bind);
    pendingTokens.delete(token);
    return json(res, 200, { ok: true, nickname: String(nickname).trim(), age: snap.age, note: snap.note },
      { "set-cookie": auth.tokenCookie(bind) });
  }

  // --- kid: conversation
  if (req.method === "POST" && pathname === "/api/say") {
    const kidId = requireKid(req, res);
    if (!kidId) return;
    const { text } = await body(req);
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed || trimmed.length > 2000) return json(res, 400, { error: "bad text" });

    const live = sessions.getSession(kidId);
    if (!live) {
      const gate = caps.canStartSession(kidId);
      if (!gate.ok) return json(res, 200, { reply: gate.message, sessionEnded: true });
    } else {
      const gate = caps.canSendTurn(kidId, live);
      if (!gate.ok) {
        sessions.retire(kidId, `cap:${gate.reason}`);
        return json(res, 200, { reply: gate.message, sessionEnded: true });
      }
      if (Date.now() - live.startedAt > config.sessionMaxMs) {
        sessions.retire(kidId, "time cap");
        return json(res, 200, { reply: caps.messages.TURNS_DONE, sessionEnded: true });
      }
    }

    try {
      const out = await sessions.ask(kidId, trimmed, {
        onNewSession: () => caps.noteSessionStart(kidId),
      });
      await caps.addSpend(kidId, out.deltaUsd, out.deltaTokens);
      return json(res, 200, { reply: out.reply, turns: out.turns });
    } catch (err) {
      console.error(`[whyzr] /api/say failed: ${err?.stack || err}`);
      return json(res, 500, { error: "Something got tangled up in my thinking. Let's try again!" });
    }
  }

  if (req.method === "POST" && (pathname === "/api/new" || pathname === "/api/bye")) {
    const kidId = auth.kidFromRequest(req);
    if (kidId) sessions.retire(kidId, pathname === "/api/bye" ? "page closed" : "new adventure");
    if (pathname === "/api/bye") { res.writeHead(204); return res.end(); }
    return json(res, 200, { ok: true });
  }

  // --- parent
  if (req.method === "POST" && pathname === "/api/parent/login") {
    const { pin } = await body(req);
    const kidId = auth.kidFromRequest(req) || Object.keys(registry.read().kids)[0];
    const kid = kidId ? registry.getKid(kidId) : null;
    if (!kid || !auth.verifyPin(pin, kid.pinHash)) {
      return json(res, 401, { error: "That PIN did not match." });
    }
    return json(res, 200, { ok: true, token: issueParentToken(kidId), nickname: kid.nickname });
  }

  if (req.method === "GET" && pathname === "/api/parent/data") {
    const kidId = parentKid(req, url);
    if (!kidId) return json(res, 401, { error: "unauthorized" });
    const dir = paths.kidRepo(kidId);
    const kid = registry.getKid(kidId);
    return json(res, 200, {
      nickname: kid.nickname,
      age: kid.age,
      cards: journal.journalCards(dir),
      rules: journal.readRules(dir),
      history: journal.repoHistory(dir),
      report: journal.progressReport(dir),
      remotes: git(dir, ["remote"]).split("\n").filter(Boolean),
      // True while a just-finished session is still being written up. The
      // dashboard shows a live notice and refreshes instead of silently
      // displaying a stale journal.
      journaling: sessions.isJournaling(kidId),
      chatting: Boolean(sessions.getSession(kidId)),
    });
  }

  if (req.method === "GET" && pathname === "/api/parent/diff") {
    const kidId = parentKid(req, url);
    if (!kidId) return json(res, 401, { error: "unauthorized" });
    const diff = journal.commitDiff(paths.kidRepo(kidId), url.searchParams.get("hash") || "");
    return diff ? json(res, 200, { diff }) : json(res, 404, { error: "not found" });
  }

  if (req.method === "POST" && pathname === "/api/parent/rules") {
    const kidId = parentKid(req, url);
    if (!kidId) return json(res, 401, { error: "unauthorized" });
    const { rules } = await body(req);
    try {
      const hash = journal.saveRules(paths.kidRepo(kidId), rules);
      return json(res, 200, { ok: true, hash });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/parent/restore") {
    const kidId = parentKid(req, url);
    if (!kidId) return json(res, 401, { error: "unauthorized" });
    try {
      const hash = journal.restoreRules(paths.kidRepo(kidId));
      return json(res, 200, { ok: true, hash, rules: journal.readRules(paths.kidRepo(kidId)) });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // --- admin (Rohan's review surface)
  if (pathname.startsWith("/api/admin/")) {
    if (!adminOk(url, req)) return json(res, 401, { error: "unauthorized" });
    if (pathname === "/api/admin/overview") {
      const reg = registry.read();
      const kids = Object.entries(reg.kids).map(([id, k]) => ({
        id, nickname: k.nickname, age: k.age, branch: k.branch, usage: k.usage,
        history: journal.repoHistory(paths.kidRepo(id), 60),
      }));
      return json(res, 200, {
        kids, global: reg.global, transcripts: listTranscripts(),
        napping: caps.napping(), budget: config.dailyBudgetUsd,
        saveTranscripts: config.saveTranscripts,
      });
    }
    if (pathname === "/api/admin/transcript") {
      const t = readTranscript(url.searchParams.get("kid") || "", url.searchParams.get("session") || "");
      return t ? json(res, 200, t) : json(res, 404, { error: "not found" });
    }
    if (pathname === "/api/admin/diff") {
      const kidId = url.searchParams.get("kid") || "";
      const hash = url.searchParams.get("hash") || "";
      if (!registry.getKid(kidId)) return json(res, 404, { error: "unknown kid" });
      const diff = journal.commitDiff(paths.kidRepo(kidId), hash);
      return diff ? json(res, 200, { diff }) : json(res, 404, { error: "not found" });
    }
  }

  res.writeHead(404);
  res.end("not found");
}

function requireKid(req, res) {
  const kidId = auth.kidFromRequest(req);
  if (!kidId) { json(res, 401, { error: "Enter the code first." }); return null; }
  return kidId;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (rateLimited(req)) return json(res, 429, { error: "Too many requests. Take a breath and try again." });
    if (req.method === "POST" && foreignOrigin(req)) return json(res, 403, { error: "forbidden" });
    await handle(req, res, url);
  } catch (err) {
    console.error(`[whyzr] unhandled: ${err?.stack || err}`);
    if (!res.headersSent) json(res, 500, { error: "Something went wrong." });
  }
});

const shutdown = async (sig) => {
  console.log(`[whyzr] ${sig}: retiring live sessions so journals are written...`);
  try { await Promise.race([sessions.retireAll(sig), new Promise((r) => setTimeout(r, 30_000))]); } catch { /* best effort */ }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(config.port, () => {
  console.log(`Whyzr hosted app on :${config.port}`);
  console.log(`  data dir      : ${config.dataDir}`);
  console.log(`  access code   : ${LOCAL_DEV ? "NOT SET (local dev, gate open)" : "set"}`);
  console.log(`  admin         : ${config.adminKey ? "enabled" : "disabled (ADMIN_KEY unset)"}`);
  console.log(`  transcripts   : ${config.saveTranscripts ? "SAVING (testing mode)" : "not saved"}`);
  console.log(`  daily budget  : $${config.dailyBudgetUsd}`);
});
