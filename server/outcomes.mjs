// server/outcomes.mjs: turning a verdict into evidence on a child's branch.
//
// This is the short file the whole product hangs off. A verdict from the
// judge arrives here, becomes a confidence update on the move that was
// actually used, and lands in git as a commit on that child's branch. Run it
// enough times for two children and `git diff child-a child-b -- skills/`
// stops being a claim and becomes a measurement.
//
// The arithmetic is deliberately NOT ours. adjustConfidence, loadSkillStats
// and saveSkillStats are gitagent's own, so the numbers in a Whyzr branch are
// the framework's numbers and the design doc's "[verified]" tags stay true.
// What the framework does not supply is the SIGNAL (its success and failure
// are self-reported by the model) and the COMMIT (saveSkillStats is a bare
// writeFile). Whyzr supplies both.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./config.mjs";

// Reached by path, not by package name, because gitagent's exports map
// publishes only "." and "./cli", and the reinforcement primitives are not
// re-exported from the main entry (only discoverSkills is). So an
// application that wants to supply the external success signal the framework
// asks for has two options: reach into dist/ like this, or reimplement the
// confidence math and let it drift out of sync with the framework's. Both
// are bad, and this is the less bad one, since the numbers stay the
// framework's own. Logged in FEEDBACK.md.
const REINFORCEMENT = pathToFileURL(
  join(REPO_ROOT, "node_modules/@open-gitagent/gitagent/dist/learning/reinforcement.js")
).href;
const { adjustConfidence, loadSkillStats, saveSkillStats } = await import(REINFORCEMENT);

const LOG = "verdicts.md";

/**
 * Apply a verdict to the move this session committed to.
 *
 * "not gradeable" deliberately touches nothing: design section 2 says no
 * update at all. It is not a soft failure, and treating it as one would
 * punish a child for asking an interesting question.
 *
 * Returns { applied, before, after } for logging. `applied` is false when
 * nothing was written, which is the correct outcome for an ungradable
 * session and for a session with no move.
 */
export async function applyVerdict(dir, moveName, verdict, reason) {
  if (!moveName || verdict === "not gradeable") {
    return { applied: false, before: null, after: null };
  }
  // HANDOFF 1.1: three verdicts, and "partial" is removed. adjustConfidence
  // still accepts it, so guard the boundary here rather than trusting every
  // future caller to remember.
  if (verdict !== "success" && verdict !== "failure") {
    throw new Error(`refusing to apply unknown verdict "${verdict}"`);
  }

  const skillDir = join(dir, "skills", moveName);
  if (!existsSync(skillDir)) return { applied: false, before: null, after: null };

  const before = await loadSkillStats(skillDir);
  const after = adjustConfidence(before, verdict, verdict === "failure" ? reason : undefined);
  await saveSkillStats(skillDir, after);
  return { applied: true, before, after };
}

/**
 * Append the verdict to the child's own verdict log, in git. This is what a
 * parent reads months later, and what makes a confidence number defensible
 * rather than magic: every point of movement has a dated line saying which
 * question caused it and why.
 *
 * The child's question is recorded, their answer is not. The question is the
 * interesting artifact and the answer is the part most likely to carry
 * something personal.
 */
export function logVerdict(dir, entry) {
  const path = join(dir, LOG);
  if (!existsSync(path)) {
    writeFileSync(path,
      "# Verdicts\n\n" +
      "One line per graded session. Written by the judge (a different model\n" +
      "family from the tutor), which sees only the question, the frozen\n" +
      "target, and the child's final answer.\n\n");
  }
  const conf = entry.after
    ? ` ${entry.move} ${entry.before.confidence} -> ${entry.after.confidence}`
    : ` ${entry.move || "no move"} unchanged`;
  appendFileSync(path,
    `- ${entry.date} **${entry.verdict}**${conf}\n` +
    `  - question: ${oneLine(entry.question)}\n` +
    `  - target: ${oneLine(entry.target)}\n` +
    `  - reason: ${oneLine(entry.reason)}\n`);
  return LOG;
}

// Markdown list items break on a newline, and a model-written reason can
// contain one.
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim() || "(none)";
