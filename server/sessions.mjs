// server/sessions.mjs: one live gitagent session per kid.
//
// This is the hosted evolution of the single-session logic proved in
// ui/server.mjs. What carries over unchanged:
//   - ALL session operations run on ONE serialized queue per kid, so a
//     wrap-up can never steal an in-flight turn's completion signal
//   - every retirement path journals first (new adventure, page close,
//     time cap, turn cap), because the journal IS the product
//   - replies are read by polling q.messages(): gitagent 2.0.2 closes the
//     public stream after turn one (FEEDBACK item 6)
//
// What is new: sessions are keyed by kid, each bound to that kid's own
// WORKTREE on the volume; the child's age is a system-prompt parameter rather
// than a branch; whatever the session learned is committed to that child's
// branch when it retires; and transcripts can be captured for testing.

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config, paths } from "./config.mjs";
import { git, commitSession, withChildLock } from "./worktrees.mjs";
import { voiceSuffix } from "./age.mjs";
import { commitToMove } from "./moves.mjs";
import { deriveTarget, grade, gaveUp, judgeConfigured, judgeCostUsd } from "./judge.mjs";
import { applyVerdict, logVerdict } from "./outcomes.mjs";
import { saveTranscript } from "./transcripts.mjs";
import { newSessionId } from "./auth.mjs";

const WRAPUP_PROMPT =
  "We are done for today. Please do your session wrap-up now: write the " +
  "growth journal entry for this session and save it with the memory tool. " +
  `Date the entry ${todayISO()}.`;

/**
 * The model has no idea what day it is, so left alone it invents dates in
 * journal headings (observed: a session held in Aug 2026 headed 2025-01-23).
 * Every session gets today's date in its system prompt. Date only, never a
 * timestamp: a per-request value would break gitagent's prompt caching.
 */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateSuffix() {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return `\n\n## Today\n\nToday's date is ${todayISO()} (${weekday}). Use this ` +
    `exact date when you write a journal entry heading. Never guess a date.`;
}

const { query } = await import("@open-gitagent/gitagent");

/** How long a wrap-up may take. Shutdown must wait at least this long. */
export const WRAPUP_TIMEOUT_MS = 90_000;

/**
 * Spend reporter, wired by the app so sessions.mjs stays free of the caps
 * module. Called with (kidId, deltaUsd, deltaTokens).
 */
let onSpend = null;
export function setSpendReporter(fn) { onSpend = fn; }

/** Cost since the last time we measured this session (costs() is cumulative). */
function spendDelta(s) {
  try {
    const c = s.q.costs();
    const usd = Number(c?.totalCostUsd || 0);
    const tok = Object.values(c?.modelUsage || {}).reduce((n, m) => n + Number(m.totalTokens || 0), 0)
      || Number(c?.totalInputTokens || 0) + Number(c?.totalOutputTokens || 0);
    const delta = { usd: Math.max(0, usd - s.lastCostUsd), tokens: Math.max(0, tok - s.lastTokens) };
    s.lastCostUsd = usd;
    s.lastTokens = tok;
    return delta;
  } catch {
    return { usd: 0, tokens: 0 };
  }
}

/** kidId -> session */
const sessions = new Map();
/** kidId -> promise chain (serializes ask + retire for that kid) */
const chains = new Map();
/**
 * Kids whose session is being written to the journal right now. Wrap-up runs
 * in the background and can take up to 90s, so a parent who opens the
 * dashboard immediately would otherwise see a stale journal with no
 * explanation. The dashboard reads this and says so.
 */
const journaling = new Set();

export const isJournaling = (kidId) => journaling.has(kidId);

const completedTurns = (msgs) =>
  msgs.filter((m) => m.type === "assistant" && ["stop", "error", "aborted"].includes(m.stopReason)).length;

function enqueue(kidId, job) {
  const prev = chains.get(kidId) || Promise.resolve();
  const run = prev.then(job);
  chains.set(kidId, run.catch(() => { /* keep the queue alive after failures */ }));
  return run;
}

function create(kidId, profile) {
  const dir = paths.kidRepo(kidId);
  const s = {
    kidId,
    dir,
    age: profile?.age ?? 8,
    id: newSessionId(),
    // The judge's state for this session: the frozen target, the promise
    // deriving it, the child's latest answer, and whether they pressed the
    // give-up control (which skips the judge entirely).
    frozen: null,
    freezing: null,
    lastAnswer: "",
    gaveUp: false,
    move: null,
    queue: [],
    wake: null,
    q: null,
    startedAt: Date.now(),
    userTurns: 0,
    retired: false,
    lastCostUsd: 0,
    lastTokens: 0,
    transcript: [],
  };
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
  // Fix 0, and it MUST happen before query(): gitagent reads agent.yaml when
  // the session loads, so filtering the prompt afterwards would do nothing.
  // One rival move reaches the model, so the move we grade is necessarily
  // the move it used.
  try {
    s.move = commitToMove(dir);
    if (s.move) {
      console.log(`[whyzr] ${kidId} session ${s.id}: move ${s.move.name} (${s.move.why}, rate ${s.move.rate.toFixed(2)})`);
    }
  } catch (err) {
    // Never block a child from talking because selection failed. Without a
    // filter the model sees every move, which is the pre-fix-0 behaviour:
    // degraded attribution, still a working tutor. Say so loudly.
    console.error(`[whyzr] move selection FAILED for ${kidId}, prompt is unfiltered: ${err.message}`);
    s.move = null;
  }

  // Age reaches the model here, as a prompt parameter. It used to be a branch
  // (age-5 / main / age-12) whose only difference was one file, which meant
  // three copies of the persona to keep in sync and a checkout on every
  // birthday. See age.mjs.
  const suffix = dateSuffix() + (profile ? voiceSuffix(profile) : "");
  s.q = query({ prompt: feed(), dir, maxTurns: 400, systemPromptSuffix: suffix });
  // Drive the session-length cap from a timer, not from the next message: a
  // child who simply closes the tab used to leave a session open forever,
  // never capped and never journaled.
  s.capTimer = setTimeout(() => retire(kidId, "time cap"), config.sessionMaxMs);
  s.capTimer.unref?.();
  (async () => {
    try {
      for await (const _ of s.q) { /* drain; channel closes after turn one */ }
    } catch (err) {
      // A faulted query cannot reliably run a wrap-up (it would hang the
      // deadline), so drop it and start fresh next message. Loud, not silent.
      console.error(`[whyzr] session FAULTED for ${kidId} (journal lost): ${err?.message || err}`);
      if (sessions.get(kidId) === s) sessions.delete(kidId);
    }
  })();
  sessions.set(kidId, s);
  return s;
}

function push(s, msg) {
  s.queue.push(msg);
  if (s.wake) { const w = s.wake; s.wake = null; w(); }
}

export function getSession(kidId) {
  return sessions.get(kidId) || null;
}

export function sessionAgeMs(kidId) {
  const s = sessions.get(kidId);
  return s ? Date.now() - s.startedAt : 0;
}

/**
 * Ask a question. Returns { reply, deltaUsd, deltaTokens, sessionId }.
 * onNewSession fires when this call had to create a session (so the caller
 * can count it against the daily cap).
 */
export function ask(kidId, text, { onNewSession, profile } = {}) {
  return enqueue(kidId, async () => {
    let s = sessions.get(kidId);
    if (!s) {
      s = create(kidId, profile);
      if (onNewSession) await onNewSession();
    }
    s.userTurns += 1;
    s.transcript.push({ role: "kid", text, at: new Date().toISOString() });

    // Freeze the target on the FIRST question, before any tutoring, and do
    // it in the background: the child should never wait on the judge. A
    // target derived later would have the tutor's hints in the room, which
    // is exactly the stretchy standard freezing exists to prevent.
    if (!s.frozen && !s.freezing && judgeConfigured()) {
      s.freezing = deriveTarget(text, s.age)
        .then(async (t) => {
          s.frozen = t;
          // The tutor's call_judge tool reads this for the question text. It
          // never contains the target: the tutor must not know the bar it is
          // steering the child toward, or it will teach to it.
          try {
            writeFileSync(join(s.dir, ".judge-target.json"),
              JSON.stringify({ question: t.question }, null, 2));
          } catch { /* the server keeps the authoritative copy in memory */ }
          await billJudge(s, t.usage, "target");
          console.log(`[whyzr] ${kidId} target frozen (gradable: ${t.gradable})`);
        })
        .catch((err) => {
          // No target means the session grades as ungradable, which skips the
          // confidence update. Losing one session's signal is correct; making
          // one up is not.
          console.error(`[whyzr] target derivation failed for ${kidId}: ${err.message}`);
        });
    }
    // The child's most recent substantive message is their answer so far.
    s.lastAnswer = text;

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
    reply = reply || "Hmm, my thinking got tangled. Can you say that again?";
    s.transcript.push({ role: "whyzr", text: reply, at: new Date().toISOString() });

    // Design section 2: the TUTOR decides when the child has reached an
    // answer, by calling the call_judge tool. It controls timing only; the
    // verdict is the server's and it never sees one. Checked after the turn
    // rather than during, so the child still gets this reply.
    const handedOff = takeJudgeRequest(s);
    if (handedOff) {
      s.lastAnswer = handedOff.final_answer;
      s.tutorEnded = true;
      console.log(`[whyzr] ${kidId}: tutor called the judge after ${s.userTurns} turns`);
      retire(kidId, "tutor called the judge");
    }

    // SessionCosts has NO top-level totalTokens: totalTokens lives only
    // inside modelUsage (and is the figure that includes cache tokens).
    const { usd: deltaUsd, tokens: deltaTokens } = spendDelta(s);
    return { reply, deltaUsd, deltaTokens, sessionId: s.id, turns: s.userTurns,
             sessionEnded: Boolean(handedOff) };
  });
}

/**
 * Retire a session: journal it (if it saw real conversation), then close the
 * feed. Enqueued so it runs AFTER any in-flight ask. Callers do not await.
 */
/**
 * The give-up control. Marks the session a failure and retires it. A button
 * in the UI, never keyword detection on the child's text: "just tell me"
 * has too many phrasings to match and a classifier would add a call and a
 * failure mode. Returns false if there was no live session to give up on.
 */
export function giveUp(kidId) {
  const s = sessions.get(kidId);
  if (!s || s.retired) return false;
  s.gaveUp = true;
  retire(kidId, "gave up");
  return true;
}

export function retire(kidId, why) {
  const s = sessions.get(kidId);
  if (!s || s.retired) return;
  s.retired = true;
  sessions.delete(kidId);
  if (s.userTurns >= 2) journaling.add(kidId);
  enqueue(kidId, () => retireNow(s, why));
}

async function retireNow(s, why) {
  try {
    if (s.userTurns >= 2) {
      const before = completedTurns(s.q.messages());
      push(s, WRAPUP_PROMPT);
      push(s, null);
      const deadline = Date.now() + WRAPUP_TIMEOUT_MS;
      while (completedTurns(s.q.messages()) <= before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      // The wrap-up is a real model turn and used to be invisible to the
      // budget: its cost never reached the daily cap or the global total.
      try {
        const d = spendDelta(s);
        if (onSpend && (d.usd || d.tokens)) await onSpend(s.kidId, d.usd, d.tokens);
      } catch { /* metering is best effort, never blocks the journal */ }
      const done = completedTurns(s.q.messages()) > before;
      console.log(
        `[whyzr] session ${s.id} for ${s.kidId} retired (${why}): ` +
        `wrap-up ${done ? "completed, journal written" : "TIMED OUT, journal NOT written"} ` +
        `after ${s.userTurns} kid turns`
      );
    } else {
      push(s, null);
      console.log(`[whyzr] session ${s.id} for ${s.kidId} retired (${why}): too short to journal (${s.userTurns} turns)`);
    }
  } catch (err) {
    console.error(`[whyzr] retire error: ${err?.message || err}`);
  } finally {
    journaling.delete(s.kidId);
    clearTimeout(s.capTimer);
    try { s.q.abort?.(); } catch { /* already gone */ }

    // gitagent updates skill confidence with a bare writeFile and never
    // commits (verified in its task-tracker tool). Left uncommitted, this
    // session's learning is invisible to `git diff child-a child-b` and is
    // destroyed the moment a worktree is rebuilt from its branch. A session
    // is the unit of learning, so the app commits it here, once, after the
    // agent has stopped writing.
    // Grade, then commit, both inside one hold of the lock so a verdict and
    // the confidence change it caused can never be split across processes.
    //
    // Fix 2, taken for real. The in-process promise chain serialises this
    // child's own turns, but it does not span PROCESSES, and the window
    // where two processes both write this worktree is routine rather than
    // exotic: on redeploy the old instance keeps running wrap-ups for up to
    // 105 seconds while the new instance is already accepting traffic on the
    // same volume. Two processes committing to one worktree fight over
    // .git/index.lock and lose commits.
    let verdictNote = "";
    try {
      await withChildLock(s.kidId, async () => {
        verdictNote = await gradeSession(s, why);
        const hash = commitSession(s.dir, `${s.id}, ${s.userTurns} turns, ended ${why}${verdictNote}`);
        if (hash) console.log(`[whyzr] committed session learning for ${s.kidId}: ${hash}`);
      });
    } catch (err) {
      console.error(`[whyzr] could not commit session learning for ${s.kidId}: ${err.message}`);
    }
    if (config.saveTranscripts && s.transcript.length) {
      try {
        saveTranscript(s.kidId, s.id, {
          sessionId: s.id,
          kidId: s.kidId,
          startedAt: new Date(s.startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          why,
          turns: s.userTurns,
          branch: safeBranch(s.dir),
          messages: s.transcript,
        });
      } catch (err) {
        console.error(`[whyzr] transcript save failed: ${err.message}`);
      }
    }
  }
}

/**
 * Read and clear the tutor's hand-off, if it made one this turn.
 *
 * Removed rather than left in place: it is untracked working-tree state, and
 * a stale request from a previous session would end the next one instantly.
 */
function takeJudgeRequest(s) {
  const path = join(s.dir, ".judge-request.json");
  if (!existsSync(path)) return null;
  try {
    const req = JSON.parse(readFileSync(path, "utf8"));
    return String(req.final_answer || "").trim() ? req : null;
  } catch {
    return null;
  } finally {
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Charge the judge's tokens to this child's daily budget.
 *
 * HANDOFF section 5: the judge is a SECOND model call per session, so budget
 * accounting must include it. Left out, the daily kill switch watches only
 * the tutor while the judge spends beside it, and the one number that is
 * supposed to make overspending impossible quietly stops being true.
 *
 * Best effort on purpose: a metering failure must never cost a child their
 * verdict, which is the thing the session existed to produce.
 */
async function billJudge(s, usage, what) {
  try {
    if (!onSpend || !usage) return;
    const tokens = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
    if (!tokens) return;                       // a path that made no call
    await onSpend(s.kidId, judgeCostUsd(usage), tokens);
  } catch (err) {
    console.error(`[whyzr] judge ${what} metering failed for ${s.kidId}: ${err.message}`);
  }
}

/**
 * Grade the session and write the evidence. Returns a short note for the
 * commit subject, so `git log` on a child's branch reads as a history of
 * what was tried and whether it worked.
 *
 * Every failure path here degrades to "no confidence update". That is
 * deliberate: a missing verdict costs one session of signal, while a
 * guessed one corrupts the only measurement the product makes.
 */
async function gradeSession(s, why) {
  if (!s.move) return "";
  try {
    let outcome;
    if (s.gaveUp) {
      // Design section 2: the give-up control logs failure immediately, no
      // judge involved. Checked FIRST so no code path can route it to Gemini.
      outcome = gaveUp();
    } else if (!judgeConfigured()) {
      return "";
    } else {
      if (s.freezing) await s.freezing;              // may still be in flight
      if (!s.frozen) return "";                       // derivation failed, no signal
      outcome = await grade(s.frozen, s.lastAnswer);
    }
    await billJudge(s, outcome.usage, "verdict");

    const { applied, before, after } = await applyVerdict(s.dir, s.move.name, outcome.verdict, outcome.reason);
    logVerdict(s.dir, {
      date: new Date().toISOString().slice(0, 10),
      verdict: outcome.verdict,
      reason: outcome.reason,
      move: s.move.name,
      question: s.frozen?.question || s.transcript.find((m) => m.role === "kid")?.text || "",
      target: s.frozen?.gradable ? s.frozen.target : "(no settled answer)",
      // Design section 2's grinding guardrail. The tutor can hint until the
      // child is effectively reading the answer back, then call it a success,
      // and with hint counting rejected nothing detects that. Turn count is
      // recorded as session METADATA and deliberately plays no part in the
      // verdict: scoring stays untouched, but a move whose successes average
      // fourteen turns becomes visible instead of looking like a good move.
      turns: s.userTurns,
      before, after,
    });
    console.log(
      `[whyzr] ${s.kidId} verdict ${outcome.verdict} on ${s.move.name}` +
      (applied ? `: confidence ${before.confidence} -> ${after.confidence}` : " (no confidence update)")
    );
    return `, ${outcome.verdict}`;
  } catch (err) {
    console.error(`[whyzr] grading failed for ${s.kidId}, no confidence update: ${err.message}`);
    return "";
  }
}

function safeBranch(dir) {
  try { return git(dir, ["branch", "--show-current"]); } catch { return "unknown"; }
}

/** Retire every live session (used on shutdown so journals are not lost). */
export function retireAll(why = "server shutdown") {
  const ids = [...sessions.keys()];
  ids.forEach((id) => retire(id, why));
  return Promise.all(ids.map((id) => chains.get(id) || Promise.resolve()));
}
