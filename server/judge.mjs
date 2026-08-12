// server/judge.mjs: the external outcome signal.
//
// Without this file, every confidence number in Whyzr is the model grading
// its own homework, which design-decisions section 12 finding 3 names as a
// framework-wide problem: gitagent's success and failure are self-reported
// unless the application supplies an external signal. This is that signal.
//
// Design decisions implemented here:
//
// - DIFFERENT MODEL FAMILY from the tutor. The tutor is Claude, the judge is
//   Gemini. Same family means the same blind spots, and a judge that shares
//   the tutor's misconceptions will confirm them.
// - ITS OWN SOUL.md (judge/SOUL.md), loaded as the system prompt, so the
//   judge's instructions live in git and are reviewable like everything else.
// - TARGET DERIVED AT SESSION START AND FROZEN. A judge asked after the fact
//   whether an answer was "good enough for a kid" has a stretchy standard and
//   drifts generous. Freezing it makes a fixed bar, and gives the tutor a
//   defined destination.
// - BLIND GRADING. The judge sees question, target, and final answer. Never
//   the transcript, never the tutor's reasoning, never the turn count.
// - THREE VERDICTS. success, failure, not gradeable. No partial: HANDOFF 1.1
//   removes it, so adjustConfidence is never called with it.
//
// The API key stays in this process and never enters a child's worktree or
// the agent's environment. The tutor asks for grading through a tool that
// writes a request file; it cannot reach Gemini itself.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.mjs";

const MODEL = process.env.WHYZR_JUDGE_MODEL || "gemini-3.5-flash-lite";
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** The judge's constitution, read from git like the tutor's. */
function judgeSoul() {
  const p = join(REPO_ROOT, "judge", "SOUL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

export const judgeConfigured = () => Boolean(process.env.GOOGLE_API_KEY);

/**
 * Token accounting for the judge, so spend can be reported as a measured
 * number rather than an estimate. The seeding script prints it; the server
 * folds it into the daily budget, because the judge is a second model call
 * per session and HANDOFF section 5 requires it to be counted.
 */
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, tier: null };
export const judgeUsage = () => ({ ...usage });
export const resetJudgeUsage = () => Object.assign(usage, { calls: 0, inputTokens: 0, outputTokens: 0 });

// Published per-million-token rates for the judge model. HANDOFF section 5:
// "the judge is a second model call per session, so budget accounting must
// include it". Without this the daily budget kill switch only ever sees the
// tutor, and the judge spends alongside it invisibly.
const RATE_IN_PER_M = Number(process.env.WHYZR_JUDGE_RATE_IN || 0.10);
const RATE_OUT_PER_M = Number(process.env.WHYZR_JUDGE_RATE_OUT || 0.40);

/** Dollar cost of one call's token usage. */
export function judgeCostUsd(u) {
  if (!u) return 0;
  return (Number(u.inputTokens || 0) / 1e6) * RATE_IN_PER_M
       + (Number(u.outputTokens || 0) / 1e6) * RATE_OUT_PER_M;
}

/** Zero usage, for the paths that deliberately make no model call. */
export const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

/**
 * One Gemini call. Returns parsed JSON, or throws. Deliberately small: the
 * judge does two things and both are a single turn with no tools.
 */
/**
 * Is this failure worth another attempt? Only transient conditions.
 *
 * 429 is the API asking us to slow down. A timeout or a dropped socket is
 * the network having a bad second. Neither says anything about whether the
 * request was valid, so retrying is correct. A 400 or a 403 does say
 * something, and retrying those just spends money to be told no twice.
 *
 * The timeout case earned its place: one 20-second judge call overran during
 * a seeded run and took the child's remaining NINETEEN sessions with it,
 * because the caller stops a child on any error rather than inventing
 * verdicts. Losing a run to a slow second is not a tradeoff worth keeping.
 */
function transient(err) {
  if (err?.status === 429) return "rate limited";
  if (err?.status >= 500) return `server error ${err.status}`;
  if (err?.name === "AbortError" || /aborted|timeout/i.test(String(err?.message))) return "timed out";
  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(String(err?.message))) return "network";
  return null;
}

/** Retry transient judge failures with bounded exponential backoff. */
async function askWithBackoff(systemPrompt, userPrompt, opts = {}) {
  const delays = [2_000, 6_000, 15_000];
  for (let i = 0; ; i++) {
    try {
      return await ask(systemPrompt, userPrompt, opts);
    } catch (err) {
      const why = transient(err);
      if (!why || i >= delays.length) throw err;
      console.warn(`[whyzr] judge ${why}, retrying in ${delays[i] / 1000}s`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

async function ask(systemPrompt, userPrompt, { timeoutMs = 20_000 } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT(MODEL)}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) {
      // Never log the URL: it carries the key as a query parameter.
      const err = new Error(`judge API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const u = data?.usageMetadata || {};
    const callUsage = {
      inputTokens: Number(u.promptTokenCount || 0),
      outputTokens: Number(u.candidatesTokenCount || 0),
    };
    usage.calls += 1;
    usage.inputTokens += callUsage.inputTokens;
    usage.outputTokens += callUsage.outputTokens;
    // "standard" means billing is enabled. Worth capturing: HANDOFF 2.4
    // forbids the free tier for any session involving a real child, because
    // free-tier content is used to improve Google's products.
    if (u.serviceTier) usage.tier = u.serviceTier;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { body: JSON.parse(text), usage: callUsage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Job 1. Derive ONE age-appropriate target for this question and freeze it.
 * Called once, at the child's first real question, before any tutoring.
 *
 * Returns { question, target, gradable, age } or null if the judge is not
 * configured. A question the judge calls ungradable is still tutored: the
 * child sees no difference, only the confidence update is skipped.
 */
export async function deriveTarget(question, age) {
  const prompt =
    `A ${age} year old asked: "${question}"\n\n` +
    `Derive the frozen target for this session.\n\n` +
    `Reply as JSON: {"gradable": boolean, "target": string, "why_not": string}\n` +
    `gradable is false ONLY when the question itself has no settled answer. ` +
    `When gradable is false, target is "" and why_not says why the question ` +
    `has no settled answer. When gradable is true, why_not is "".`;

  const { body: out, usage: callUsage } = await askWithBackoff(judgeSoul(), prompt);
  return {
    usage: callUsage,
    question,
    age,
    gradable: out.gradable === true,
    target: String(out.target || ""),
    whyNot: String(out.why_not || ""),
    derivedAt: new Date().toISOString(),
  };
}

/**
 * Job 2. Grade the child's final answer against the frozen target. Blind:
 * this call receives no part of the conversation beyond the final answer.
 *
 * Returns { verdict, reason } where verdict is success | failure |
 * not gradeable.
 */
export async function grade(frozen, finalAnswer) {
  if (!frozen?.gradable) {
    // HANDOFF section 5: the ungradable path must SKIP the judge call rather
    // than make it and discard the result. The gradability was already
    // settled when the target was derived, so there is nothing to ask.
    return { verdict: "not gradeable", usage: NO_USAGE,
             reason: frozen?.whyNot || "the question has no settled answer" };
  }
  if (!String(finalAnswer || "").trim()) {
    // No answer is a failure by definition, and needs no model call. Design
    // section 2: "No answer produced means failure, and the judge is never
    // called." Saves a call and removes a chance for the judge to be kind.
    return { verdict: "failure", usage: NO_USAGE, reason: "the child produced no final answer" };
  }

  const prompt =
    `Question: ${frozen.question}\n` +
    `Frozen target (age ${frozen.age}): ${frozen.target}\n` +
    `The child's final answer: ${finalAnswer}\n\n` +
    `Grade it.\n\n` +
    `Reply as JSON: {"verdict": "success" | "failure", "reason": string}\n` +
    `Borderline is failure. Judge the idea, not the vocabulary. ` +
    `"not gradeable" is not available here: this question was already ` +
    `established as having a settled answer.`;

  const { body: out, usage: callUsage } = await askWithBackoff(judgeSoul(), prompt);
  const verdict = out.verdict === "success" ? "success" : "failure";
  return { verdict, usage: callUsage, reason: String(out.reason || "") };
}

/**
 * The give-up control. Design section 2: pressing it logs failure
 * immediately, with no judge involved. A separate function rather than a
 * flag, so it is impossible to accidentally route it through the model.
 */
export function gaveUp() {
  return { verdict: "failure", usage: NO_USAGE, reason: "the child used the give-up control" };
}
