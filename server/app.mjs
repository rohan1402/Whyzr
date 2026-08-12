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
import { config, LOCAL_DEV, REPO_ROOT, ensureDataDirs, paths, assertServerConfig } from "./config.mjs";
import * as registry from "./registry.mjs";
import * as auth from "./auth.mjs";
import * as caps from "./caps.mjs";
import * as sessions from "./sessions.mjs";
import * as journal from "./journal.mjs";
import { provisionChild, deleteChild, childBranch, ensureAgentRepo, syncTemplate, rebuildMissingWorktrees, withChildLock, git } from "./worktrees.mjs";
import { ageProfile } from "./age.mjs";
import { listTranscripts, readTranscript } from "./transcripts.mjs";

assertServerConfig();
ensureDataDirs();

// Device tokens issued before any kid exists (very first visit). A token here
// may complete setup EXACTLY ONCE, then it is bound to that kid. Entries
// expire: an unbounded, never-expiring set was both a slow leak and a way to
// keep minting setup rights forever.
const PENDING_TTL_MS = 30 * 60_000;
const pendingTokens = new Map(); // token -> expiry

function addPending(token) {
  const now = Date.now();
  for (const [t, exp] of pendingTokens) if (exp < now) pendingTokens.delete(t);
  if (pendingTokens.size > 50) return false; // crude flood ceiling
  pendingTokens.set(token, now + PENDING_TTL_MS);
  return true;
}

/** Atomically consume a pending token: it works once or not at all. */
function takePending(token) {
  const exp = pendingTokens.get(token);
  if (!exp) return false;
  pendingTokens.delete(token);
  return exp >= Date.now();
}

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
    // Collect Buffers and decode once at the end: concatenating chunks as
    // strings corrupts any multi-byte character split across a chunk
    // boundary (a real risk for names and kid questions in any language).
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 200_000) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on("error", () => resolve({}));
    req.on("aborted", () => resolve({}));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        // JSON.parse succeeds on null, numbers, strings and arrays; every
        // caller destructures, so normalise to an object.
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch { resolve({}); }
    });
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

/**
 * The client IP. X-Forwarded-For is attacker-controlled, so the leftmost
 * entry is worthless for rate limiting: a random header per request bought a
 * fresh bucket every time. Only consult XFF when the number of proxies in
 * front is configured, and then take the hop the nearest trusted proxy wrote.
 */
function clientIp(req) {
  const hops = config.trustProxyHops;
  if (hops > 0) {
    const chain = String(req.headers["x-forwarded-for"] || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress || "unknown";
}

// Simple in-memory token bucket per IP. One small instance, low concurrency.
const buckets = new Map();
function rateLimited(req) {
  const ip = clientIp(req);
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
    // Bind straight to the existing kid when the deployment holds exactly one
    // (M1's shape). Otherwise hand out a short-lived setup token.
    if (kids.length >= 1 && kids.length >= config.maxKids) {
      await auth.bindToken(kids[0], token);
      return json(res, 200, { ok: true, setUp: true }, { "set-cookie": auth.tokenCookie(token) });
    }
    if (!addPending(token)) return json(res, 429, { error: "Too many setups in progress. Try again shortly." });
    return json(res, 200, { ok: true, setUp: false }, { "set-cookie": auth.tokenCookie(token) });
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
    const pendingOk = Boolean(token) && (pendingTokens.get(token) ?? 0) >= Date.now();
    return json(res, 200, {
      authed: LOCAL_DEV || pendingOk, setUp: false,
      napping: caps.napping(), localDev: LOCAL_DEV,
    });
  }

  // --- kid: first-run setup
  if (req.method === "POST" && pathname === "/api/setup") {
    const token = auth.parseCookies(req).whyzr_token;
    const existing = auth.kidFromRequest(req);
    // Check the token WITHOUT consuming it: a failed validation below must
    // not burn the tester's one setup attempt (it did, and the retry then
    // said "enter the code first" with no way forward).
    const pendingOk = Boolean(token) && (pendingTokens.get(token) ?? 0) >= Date.now();
    if (!LOCAL_DEV && !existing && !pendingOk) {
      return json(res, 401, { error: "Enter the code first." });
    }
    if (!existing && Object.keys(registry.read().kids).length >= config.maxKids) {
      return json(res, 403, { error: "This Whyzr is already set up for a child." });
    }
    const { nickname, age, pin, parentConfirmed } = await body(req);
    if (!nickname || String(nickname).trim().length < 1) return json(res, 400, { error: "Pick a nickname." });
    if (!parentConfirmed) return json(res, 400, { error: "A grown-up needs to confirm this setup." });
    if (!pin || !/^\d{4,8}$/.test(String(pin))) return json(res, 400, { error: "Choose a 4 to 8 digit parent PIN." });
    // Without this a blank age became 0, silently putting a child on the
    // youngest persona with no confirmation shown.
    const ageNum = Number(age);
    if (!Number.isFinite(ageNum) || ageNum < 1 || ageNum > 18) {
      return json(res, 400, { error: "How old are you? Pick a number between 1 and 18." });
    }

    const profile = ageProfile(age);

    if (existing) {
      // Age change on an existing child. Age is a PARAMETER now, not a
      // branch: nothing is checked out, nothing is migrated, and the child
      // keeps their branch with every journal entry and every skill stat on
      // it. The next session simply speaks in the new voice.
      const kid = registry.getKid(existing);
      if (kid.age !== profile.age) {
        await registry.update((reg) => {
          reg.kids[existing].age = profile.age;
          reg.kids[existing].band = profile.band;
        });
      }
      return json(res, 200, { ok: true, nickname: kid.nickname, age: profile.age, note: profile.note });
    }

    // All validation passed: NOW consume the setup token, atomically, so it
    // can create exactly one kid.
    if (!LOCAL_DEV && !existing && !takePending(token)) {
      return json(res, 401, { error: "Enter the code first." });
    }

    // Provision the worktree BEFORE trusting the registry entry: registering
    // first and provisioning second meant a git failure left a kid with no
    // repo, permanently bricking the app while every retry minted another
    // orphan.
    const kidId = await registry.createKid({
      nickname, age: profile.age, band: profile.band, pinHash: auth.hashPin(pin),
    });
    try {
      provisionChild(kidId);
    } catch (err) {
      console.error(`[whyzr] provisioning failed for ${kidId}: ${err.message}`);
      await registry.update((reg) => { delete reg.kids[kidId]; });
      try { deleteChild(kidId); } catch { /* nothing to clean */ }
      addPending(token); // let the tester try again with the same token
      return json(res, 500, { error: "Could not get things ready. Please try again." });
    }
    const bind = token || auth.issueToken();
    await auth.bindToken(kidId, bind);
    return json(res, 200, { ok: true, nickname: String(nickname).trim(), age: profile.age, note: profile.note },
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
        profile: ageProfile(registry.getKid(kidId)?.age),
      });
      await caps.addSpend(kidId, out.deltaUsd, out.deltaTokens);
      return json(res, 200, { reply: out.reply, turns: out.turns });
    } catch (err) {
      console.error(`[whyzr] /api/say failed: ${err?.stack || err}`);
      return json(res, 500, { error: "Something got tangled up in my thinking. Let's try again!" });
    }
  }

  // --- kid: the give-up control. A button, so it is unambiguous and
  // instantly loggable. Logs failure immediately with no judge call.
  if (req.method === "POST" && pathname === "/api/giveup") {
    const kidId = requireKid(req, res);
    if (!kidId) return;
    const had = sessions.giveUp(kidId);
    return json(res, 200, {
      ok: true,
      had,
      reply: "That's okay. Wanting the answer is not giving up, it's being honest. " +
        "Ask me a brand new why question whenever you like.",
      sessionEnded: true,
    });
  }

  if (req.method === "POST" && (pathname === "/api/new" || pathname === "/api/bye")) {
    const kidId = auth.kidFromRequest(req);
    if (kidId) sessions.retire(kidId, pathname === "/api/bye" ? "page closed" : "new adventure");
    if (pathname === "/api/bye") { res.writeHead(204); return res.end(); }
    return json(res, 200, { ok: true });
  }

  // --- parent
  if (req.method === "POST" && pathname === "/api/parent/login") {
    // The parent surface sits BEHIND the access code, exactly like the kid
    // surface: the kid is resolved strictly from this device's bound token.
    // (An earlier version fell back to "the first kid in the registry", which
    // let anyone with no cookie and no code reach a child's data behind a
    // 4-digit PIN. Found in audit; regression-tested.)
    const kidId = auth.kidFromRequest(req);
    if (!kidId) return json(res, 401, { error: "Open Whyzr on this device first." });

    const lock = auth.pinLockState(kidId);
    if (lock.locked) {
      return json(res, 429, { error: `Too many tries. Wait ${lock.waitSeconds} seconds and try again.` });
    }
    const { pin } = await body(req);
    const kid = registry.getKid(kidId);
    if (!kid || !auth.verifyPin(pin, kid.pinHash)) {
      await auth.notePinFailure(kidId);
      console.warn(`[whyzr] failed parent PIN for ${kidId}`);
      return json(res, 401, { error: "That PIN did not match." });
    }
    await auth.clearPinFailures(kidId);
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
      // null means "we could not check", which the dashboard must NOT render
      // as a safety guarantee. An unguarded call here also 500'd the whole
      // dashboard whenever the repo was mid-operation.
      remotes: safeRemotes(dir),
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
    // Refuse to commit an empty rules file: a failed dashboard load used to
    // blank the textarea, and the next Save wiped the constitution.
    if (typeof rules !== "string" || rules.trim().length < 200) {
      return json(res, 400, { error: "That does not look like a complete rules file. Reload and try again." });
    }
    try {
      // Under the same per-child lock as a session commit: a parent saving
      // rules while their child's session is wrapping up is two writers on
      // one worktree, and this route does not sit on the session queue.
      const hash = await withChildLock(kidId, () => journal.saveRules(paths.kidRepo(kidId), rules));
      return json(res, 200, { ok: true, hash });
    } catch (err) {
      console.error(`[whyzr] saveRules failed: ${err.stack || err}`);
      return json(res, 500, { error: "Could not save those rules. Nothing was changed." });
    }
  }

  if (req.method === "POST" && pathname === "/api/parent/restore") {
    const kidId = parentKid(req, url);
    if (!kidId) return json(res, 401, { error: "unauthorized" });
    try {
      const hash = await withChildLock(kidId, () => journal.restoreRules(paths.kidRepo(kidId)));
      return json(res, 200, { ok: true, hash, rules: journal.readRules(paths.kidRepo(kidId)) });
    } catch (err) {
      console.error(`[whyzr] restoreRules failed: ${err.stack || err}`);
      return json(res, 500, { error: "Could not restore the rules. Nothing was changed." });
    }
  }

  // --- admin (Rohan's review surface)
  if (pathname.startsWith("/api/admin/")) {
    if (!adminOk(url, req)) return json(res, 401, { error: "unauthorized" });
    if (pathname === "/api/admin/overview") {
      const reg = registry.read();
      const kids = Object.entries(reg.kids).map(([id, k]) => ({
        id, nickname: k.nickname, age: k.age, branch: childBranch(id), usage: k.usage,
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

function safeRemotes(dir) {
  try { return git(dir, ["remote"]).split("\n").filter(Boolean); } catch { return null; }
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
  // Must outlast a wrap-up, or every deploy kills the journal entry of any
  // session in flight. Derived from the wrap-up deadline, never a guess.
  const grace = sessions.WRAPUP_TIMEOUT_MS + 15_000;
  try {
    await Promise.race([sessions.retireAll(sig), new Promise((r) => setTimeout(r, grace))]);
  } catch { /* best effort */ }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Sessions report spend through the caps module without importing it.
sessions.setSpendReporter((kidId, usd, tokens) => caps.addSpend(kidId, usd, tokens));

// Boot the agent repo BEFORE accepting a request. ensureAgentRepo clones the
// source and strips every remote (invariants 1 and 2); syncTemplate brings
// this deploy's moves and rules to main without ever naming a remote;
// rebuildMissingWorktrees restores a returning child whose worktree directory
// did not survive the container but whose branch did (invariant 4).
ensureAgentRepo();
syncTemplate();
rebuildMissingWorktrees();

server.listen(config.port, () => {
  console.log(`Whyzr hosted app on :${config.port}`);
  console.log(`  data dir      : ${config.dataDir}`);
  console.log(`  agent repo    : ${paths.agentRepo()} (no remotes)`);
  console.log(`  access code   : ${LOCAL_DEV ? "NOT SET (local dev, gate open)" : "set"}`);
  console.log(`  admin         : ${config.adminKey ? "enabled" : "disabled (ADMIN_KEY unset)"}`);
  console.log(`  transcripts   : ${config.saveTranscripts ? "SAVING (testing mode)" : "not saved"}`);
  console.log(`  daily budget  : $${config.dailyBudgetUsd}`);
});
