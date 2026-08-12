// server/moves.mjs: choosing which reasoning move to try on this child.
//
// This is the file design-decisions section 6 is about. GitAgent does no
// skill selection at all: skills.js loads EVERY skill into the system prompt
// tagged with <confidence> and instructs the model to scan the list and pick.
// Selection is a gap to fill, not a feature to override.
//
// Three decisions implemented here, in the order they matter.
//
// FIX 0 (critical). `formatSkillsForPrompt` injects all skills and tells the
// model to choose, so an app that "selects" move A can have the model use
// move B, and then move A is credited or blamed for move B's result. Every
// confidence number in the system would be attached to the wrong move. The
// resolution (HANDOFF section 2.1) is to filter the prompt via
// `manifest.skills` in agent.yaml, which filters DISCOVERY to exactly the
// listed names (verified: loader.js:193-197). One rival move reaches the
// model per session, so attribution is mechanical rather than conventional.
//
// A consequence the design doc missed and the handoff caught: because the
// filter is exact, always-on skills vanish unless they are listed too. The
// per-session list is the chosen move PLUS the always-on skills, never the
// move alone. Omitting session-wrapup would silently stop the journal, which
// is the product.
//
// FIX 1. Do not select on `confidence`. Its math is asymmetric and
// saturating (verified: reinforcement.js:19,24): success moves it by
// 0.1 * (1 - conf) so a move at 1.0 gains nothing, while failure is a flat
// -0.2. It is a decaying penalty counter, not an estimate of how well a move
// works. Select on smoothed success rate instead:
//
//     successRate = (success_count + 1) / (usage_count + 2)
//
// +1/+2 is Laplace smoothing, conventional, not tuned. Confidence keeps its
// real job: flagging skills below 0.4, and going into the prompt.
//
// FIX 1b. Always try a move with `usage_count: 0` first, because no evidence
// is not good evidence. Random epsilon exploration was proposed and then
// killed by its own simulation (66% down to 61% at epsilon 0.25), so there
// is deliberately no randomness here: selection is a pure function of the
// stats on the child's branch, which also makes it testable.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills that are always in the prompt and are never graded. They are
 * scaffolding, not rivals: the tutoring method itself and the wrap-up that
 * writes the journal. Neither carries confidence frontmatter, so neither
 * competes with the moves.
 */
export const ALWAYS_ON = ["socratic-method", "session-wrapup"];

/** A move is a skill that keeps score. That is what makes it a rival. */
export function readMoves(dir) {
  const skillsDir = join(dir, "skills");
  if (!existsSync(skillsDir)) return [];
  const moves = [];
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const stats = parseFrontmatter(readFileSync(file, "utf8"));
    if (stats.confidence === null) continue; // scaffolding, not a rival
    moves.push({ name, ...stats });
  }
  return moves.sort((a, b) => a.name.localeCompare(b.name)); // deterministic
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = { confidence: null, usage_count: 0, success_count: 0, failure_count: 0 };
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(confidence|usage_count|success_count|failure_count):\s*(.+)$/);
    if (kv) {
      const n = Number(kv[2].trim());
      if (Number.isFinite(n)) out[kv[1]] = n;
    }
  }
  return out;
}

/** Fix 1. Laplace-smoothed, so a 1-for-1 move does not outrank a 9-for-10 one. */
export const successRate = (m) => (m.success_count + 1) / (m.usage_count + 2);

/**
 * Choose this session's move. Returns { name, why, rate } or null if the
 * child's branch somehow has no moves at all.
 *
 * Ties break on name, not at random: two moves with identical evidence
 * should produce identical choices run to run, or the evals cannot tell a
 * regression from a coin flip.
 */
export function selectMove(dir) {
  const moves = readMoves(dir);
  if (!moves.length) return null;

  // Fix 1b: anything untried goes first. No evidence is not good evidence.
  const untried = moves.filter((m) => m.usage_count === 0);
  if (untried.length) {
    return { name: untried[0].name, why: "never tried", rate: successRate(untried[0]) };
  }

  let best = moves[0];
  for (const m of moves) if (beats(m, best)) best = m;
  return { name: best.name, why: "highest smoothed success rate", rate: successRate(best) };
}

/**
 * Is `a` a better choice than `b`?
 *
 * The tie-break is the interesting part, and it was earned by a seeded run.
 * The first version compared rates with `>` and kept the incumbent on a tie,
 * and because moves are iterated in name order, ties silently resolved
 * alphabetically. Ties are not rare either: with Laplace smoothing a move
 * that is 1-for-1 and another that is 1-for-1 sit at exactly the same rate,
 * which is the normal state of affairs right after the cold-start phase.
 *
 * The result, straight from the seeded data: for a child whose profiled
 * strengths were predict-first and observe-recall, `decompose` tied
 * predict-first at 0.667 on session 7, won the tie on the letter D, and then
 * held the lead for FOURTEEN consecutive sessions. predict-first was tried
 * once. The system was not measuring that child, it was measuring the
 * alphabet.
 *
 * Breaking ties toward the LEAST-TRIED move fixes it and costs nothing: it
 * is still deterministic, so the evals stay exact, and it is not the random
 * epsilon exploration that design section 6 fix 1b rejected on its own
 * simulation evidence. It only decides cases where the evidence genuinely
 * does not, and in exactly those cases it buys another sample of whichever
 * move we know least about.
 */
function beats(a, b) {
  const ra = successRate(a);
  const rb = successRate(b);
  if (ra !== rb) return ra > rb;
  if (a.usage_count !== b.usage_count) return a.usage_count < b.usage_count;
  return a.name < b.name; // total order, so selection never depends on readdir
}

/**
 * Fix 0. Rewrite the worktree's agent.yaml so `manifest.skills` lists the
 * chosen move plus the always-on skills, and nothing else. gitagent reads
 * agent.yaml when the session loads, so this must run BEFORE query().
 *
 * The rewrite is line-based rather than a YAML round-trip on purpose: a
 * real YAML dump would reformat the whole file and bury the one line that
 * changed under a noisy diff, and this file is committed with the session so
 * that `git log -p -- agent.yaml` reads as a record of which move was tried
 * when. The diff is the audit trail, so it has to stay small.
 */
export function writeManifestSkills(dir, moveName) {
  const path = join(dir, "agent.yaml");
  const listed = [moveName, ...ALWAYS_ON].filter(Boolean);
  const block = `skills: [${listed.join(", ")}]`;
  const text = readFileSync(path, "utf8");
  const next = /^skills:.*$/m.test(text)
    ? text.replace(/^skills:.*$/m, block)
    : text.replace(/^(tools:.*)$/m, `$1\n${block}`);
  if (next !== text) writeFileSync(path, next);
  return listed;
}

/**
 * Everything a session needs to commit to one move: pick it, filter the
 * prompt to it, and hand back what was chosen so the caller can log it and
 * grade it later.
 */
export function commitToMove(dir) {
  const chosen = selectMove(dir);
  if (!chosen) return null;
  const listed = writeManifestSkills(dir, chosen.name);
  return { ...chosen, listed };
}
