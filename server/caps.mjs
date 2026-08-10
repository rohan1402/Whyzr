// server/caps.mjs: cost armor.
//
// Four layers, all of which end a session SOFTLY (the journal still gets
// written by the session lifecycle) rather than erroring at a child:
//   1. per-session turn cap      -> warm wind-down, wrap-up runs
//   2. per-kid sessions per day  -> "come back tomorrow"
//   3. per-kid daily tokens      -> same
//   4. global daily budget       -> nap mode for everyone
//
// Spend is summed from the SDK's own cost tracker (q.costs()), so the numbers
// are the model's, not an estimate of ours.

import { config } from "./config.mjs";
import { update, read, rollDay, today } from "./registry.mjs";

const NAP =
  "Whyzr is having a nap right now. Come back tomorrow and we will explore something new!";
const DAY_DONE =
  "That is all the thinking time for today! Come back tomorrow, I will be here.";
const TURNS_DONE =
  "What a lot of good thinking we did! My thinking time is up for now, and I saved today's discoveries in your journal.";

/** Global budget check: is the app allowed to make model calls at all? */
export function napping() {
  const reg = read();
  const g = reg.global || {};
  if (g.day !== today()) return false;
  return (g.spendUsd || 0) >= config.dailyBudgetUsd;
}

/**
 * May this kid start a NEW session right now?
 * Returns { ok } or { ok: false, reason, message }.
 */
export function canStartSession(kidId) {
  if (napping()) return { ok: false, reason: "budget", message: NAP };
  const kid = read().kids[kidId];
  if (!kid) return { ok: false, reason: "unknown", message: NAP };
  const usage = kid.usage && kid.usage.day === today() ? kid.usage : { sessions: 0, tokens: 0 };
  if (usage.sessions >= config.maxSessionsPerDay) {
    return { ok: false, reason: "sessions", message: DAY_DONE };
  }
  if (usage.tokens >= config.maxDailyTokensPerKid) {
    return { ok: false, reason: "tokens", message: DAY_DONE };
  }
  return { ok: true };
}

/** May this kid send another message in the CURRENT session? */
export function canSendTurn(kidId, session) {
  if (napping()) return { ok: false, reason: "budget", message: NAP, endSession: true };
  if (session && session.userTurns >= config.maxTurnsPerSession) {
    return { ok: false, reason: "turns", message: TURNS_DONE, endSession: true };
  }
  const kid = read().kids[kidId];
  const usage = kid && kid.usage && kid.usage.day === today() ? kid.usage : { tokens: 0 };
  if (usage.tokens >= config.maxDailyTokensPerKid) {
    return { ok: false, reason: "tokens", message: DAY_DONE, endSession: true };
  }
  return { ok: true };
}

export function noteSessionStart(kidId) {
  return update((reg) => {
    const kid = reg.kids[kidId];
    if (!kid) return;
    rollDay(kid);
    kid.usage.sessions += 1;
  });
}

/**
 * Add an increment of spend to the global budget. Called with the DELTA for
 * a turn so the global number is a true running total across sessions.
 */
export function addSpend(kidId, deltaUsd, deltaTokens) {
  if (!deltaUsd && !deltaTokens) return Promise.resolve();
  return update((reg) => {
    const kid = reg.kids[kidId];
    if (kid) {
      rollDay(kid);
      kid.usage.tokens += Math.max(0, deltaTokens || 0);
      kid.usage.spendUsd = Number(((kid.usage.spendUsd || 0) + Math.max(0, deltaUsd || 0)).toFixed(6));
    }
    if (!reg.global || reg.global.day !== today()) reg.global = { day: today(), spendUsd: 0 };
    reg.global.spendUsd = Number((reg.global.spendUsd + Math.max(0, deltaUsd || 0)).toFixed(6));
  });
}

export const messages = { NAP, DAY_DONE, TURNS_DONE };
