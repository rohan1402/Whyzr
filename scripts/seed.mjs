// scripts/seed.mjs: seed two fictional children so the loop has something to show.
//
//   node scripts/seed.mjs --sessions 3          a cheap proof run
//   node scripts/seed.mjs --sessions 20         the full run
//   node scripts/seed.mjs --sessions 3 --reset  start the seeded branches over
//
// WHY THIS EXISTS. Real sessions in a one-week build cannot move confidence
// far enough to show learning, so design-decisions section 10 says to seed
// it. What that section also says, and what this file takes seriously, is
// that seeded data DEMONSTRATES THE MACHINERY, NOT LEARNING.
//
// INTEGRITY RULES, non-negotiable, from section 10:
//
//   1. Model-generated and model-graded. No external signal anywhere. The
//      child's answer is written by a model in character; the verdict comes
//      from the real judge, grading blind. This file never writes a verdict,
//      never nudges one, and never retries a grade it dislikes. If a child
//      profile says a move works badly for them, that shapes the ANSWER, and
//      the judge independently decides what the answer was worth.
//   2. Seeded children live on clearly labelled branches (child-seed-*),
//      never merged to main, never mixed with a real child.
//   3. The README states which numbers are seeded.
//
// The full tutoring conversation is deliberately NOT run. The judge grades
// blind, on the final answer only, so a ten-turn transcript cannot change a
// single number, and running one would cost roughly sixty times more to
// produce identical data. The real tutor is exercised by the layer-2
// behavioural evals instead. Saying which half ran where is the honest way
// to present this, and the README does.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, paths } from "../server/config.mjs";
import { provisionChild, commitSession, deleteChild, git } from "../server/worktrees.mjs";
import { commitToMove, readMoves, successRate } from "../server/moves.mjs";
import { deriveTarget, grade } from "../server/judge.mjs";
import { applyVerdict, logVerdict } from "../server/outcomes.mjs";

// .env for local runs; the host environment always wins.
const envPath = join(REPO_ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const SESSIONS = Number(flag("sessions", 3));
const RESET = args.includes("--reset");
const CHILD_MODEL = process.env.WHYZR_SEED_MODEL || "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------- the children
//
// Two deliberately opposed reasoning styles, so the five moves have
// genuinely different value to each. The opposition is the experiment: if
// both children ended up with the same evidence, the moves would not be
// rivals and the whole design would be decoration.
const CHILDREN = [
  {
    id: "seed-nova",
    age: 11,
    profile:
      "Nova is 11 and thinks from concrete evidence. She does well when asked to " +
      "predict what will happen before anything is explained, or to recall something " +
      "she has actually seen, because both give her something real to reason from. " +
      "Analogies backfire: she starts arguing about whether the analogy is accurate " +
      "and loses the original question. Being asked to imagine the opposite feels " +
      "like a trick to her and she hedges.",
    strong: ["predict-first", "observe-recall"],
    weak: ["analogy-bridge", "flip-it"],
  },
  {
    id: "seed-pip",
    age: 7,
    profile:
      "Pip is 7 and thinks by association and imagination. Analogies land hard for " +
      "him and he runs with them, and asking what the world would look like if the " +
      "opposite were true gets him talking immediately. Cold prediction questions " +
      "make him freeze and say he does not know, and being asked to break a question " +
      "into smaller parts loses him after the first part.",
    strong: ["analogy-bridge", "flip-it"],
    weak: ["predict-first", "decompose"],
  },
];

// Mixed on purpose. Design section 9 calls gradability the central risk and
// asks for the gradable-to-ungradable ratio to be instrumented from the
// first seeded run. A question set of only settled questions would produce a
// flattering ratio that means nothing.
const QUESTIONS = [
  "why is the sky blue",
  "why do ice cubes float",
  "why does bread get bigger when you bake it",
  "why do we dream",                              // unsettled, expected ungradable
  "why does the moon change shape",
  "why do my ears pop in a lift",
  "why do people like different music",           // not that kind of question
  "why does ice cream melt faster on a hot day",
  "why do leaves change colour",
  "why does a ball come back down",
  "why is the sea salty",
  "why do we get goosebumps",
  "why does soap make bubbles",
  "why do stars twinkle",
  "why does my shadow change size",
  "why do birds fly in a V",
  "why does metal feel colder than wood",
  "why do onions make you cry",
  "why does the sun feel hotter at midday",
  "why do we yawn when someone else does",        // unsettled, expected ungradable
];

// ------------------------------------------------------------ child simulation
/**
 * Write the child's final answer, in character, for the move that was used.
 *
 * Note what this prompt does NOT do: it never says "make this correct" or
 * "make this wrong". It describes the child and the move honestly and asks
 * for the answer that child would actually give. The judge then grades it
 * without knowing any of this. That separation is what keeps the seeded data
 * model-generated rather than author-decided.
 */
async function childAnswer(child, question, move) {
  const fit = child.strong.includes(move) ? "strong"
    : child.weak.includes(move) ? "weak" : "neutral";
  // The distinction below cost a run to learn, and it is worth stating.
  // The first seeded run gave Pip his strongest move, analogy-bridge, and he
  // engaged with it exactly as his profile says he would: he answered with an
  // analogy. The analogy was wrong ("the sky filters light like blue glass"),
  // so the judge failed it, correctly.
  //
  // That exposed a conflation in the first version of this prompt, between
  // "this move suits how the child thinks" and "this move gets the child to
  // the answer". Whyzr only measures the second. So a move that a child
  // enjoys but that leads them somewhere false is a FAILURE here, and that is
  // the system working, not a bug in it.
  //
  // The child model still never sees the frozen target. If it did, it would
  // parrot it, the judge would wave it through, and the seeded numbers would
  // measure nothing at all.
  const guidance = {
    strong:
      "This move suits how this child thinks AND leads them somewhere true. They reach the " +
      "real reason, expressed in their own words for their age, with no jargon. Correct in " +
      "substance, childlike in language.",
    weak:
      "This move does not suit how this child thinks. Their answer should be genuinely wrong " +
      "or empty: a confident misconception, a tangent, or an honest 'I do not know'. Do NOT " +
      "slip a correct answer in anyway.",
    neutral:
      "This move neither suits nor fights how this child thinks. A partial attempt that gets " +
      "part of the way and stops short of the real reason.",
  }[fit];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CHILD_MODEL,
      max_tokens: 200,
      system:
        "You simulate a child's final answer at the end of a tutoring session. " +
        "Reply with ONLY the child's words, one to three sentences, in their voice " +
        "for their age. No quotation marks, no narration, no stage directions.",
      messages: [{
        role: "user",
        content:
          `${child.profile}\n\n` +
          `The question the child asked: "${question}"\n` +
          `The reasoning move the tutor used: ${move}\n\n${guidance}\n\n` +
          `Write this child's final answer.`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`child model ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return (data.content?.[0]?.text || "").trim();
}

// Targets depend only on (question, age), and the judge freezes one per
// session, so deriving the same one repeatedly would burn calls to produce
// identical text. Cached across sessions; stated plainly rather than hidden.
const targetCache = new Map();
async function frozenTarget(question, age) {
  const key = `${age}:${question}`;
  if (!targetCache.has(key)) targetCache.set(key, await deriveTarget(question, age));
  return targetCache.get(key);
}

// --------------------------------------------------------------------- the run
async function seedChild(child, sessions, log) {
  if (RESET) deleteChild(child.id);
  const dir = provisionChild(child.id);
  const rows = [];

  for (let i = 0; i < sessions; i++) {
    const question = QUESTIONS[i % QUESTIONS.length];
    const move = commitToMove(dir);              // the real selection code
    const answer = await childAnswer(child, question, move.name);
    const frozen = await frozenTarget(question, child.age);
    const outcome = await grade(frozen, answer); // the real judge, blind
    const { before, after } = await applyVerdict(dir, move.name, outcome.verdict, outcome.reason);

    logVerdict(dir, {
      date: new Date().toISOString().slice(0, 10),
      verdict: outcome.verdict, reason: outcome.reason, move: move.name,
      question, target: frozen.gradable ? frozen.target : "(no settled answer)",
      before, after,
    });
    commitSession(dir, `seeded ${child.id} #${i + 1}, ${outcome.verdict}`);

    rows.push({ n: i + 1, question, move: move.name, why: move.why, verdict: outcome.verdict,
                gradable: frozen.gradable, conf: after ? after.confidence : (before?.confidence ?? null), answer });
    log(`  ${child.id} #${String(i + 1).padStart(2)}  ${move.name.padEnd(15)} ` +
        `${outcome.verdict.padEnd(13)} ${after ? `conf ${before.confidence} -> ${after.confidence}` : "no update"}  ${question}`);
  }
  return { child, dir, rows };
}

const line = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

line(`Seeding ${CHILDREN.length} fictional children, ${SESSIONS} sessions each`);
console.log("  model-generated answers, model-graded verdicts, no external signal\n");

const results = [];
for (const child of CHILDREN) results.push(await seedChild(child, SESSIONS, console.log));

// --------------------------------------------------------------- what it showed
line("Gradability (design section 9: the single number that says whether this works)");
const all = results.flatMap((r) => r.rows);
const gradable = all.filter((r) => r.gradable).length;
console.log(`  ${gradable} of ${all.length} sessions gradable ` +
  `(${Math.round((gradable / all.length) * 100)}%), ${all.length - gradable} ungradable and correctly unscored`);

line("Where each child's evidence ended up");
for (const { child, dir } of results) {
  console.log(`  ${child.id}:`);
  for (const m of readMoves(dir)) {
    if (!m.usage_count) continue;
    console.log(`    ${m.name.padEnd(16)} conf ${String(m.confidence).padEnd(5)} ` +
      `${m.success_count}/${m.usage_count}  smoothed ${successRate(m).toFixed(3)}`);
  }
}

line("THE THESIS: git diff between two children of the same tutor");
const [a, b] = results.map((r) => `child-${r.child.id}`);
const diff = git(paths.agentRepo(), ["diff", a, b, "--", "skills/"]);
console.log(diff.split("\n").filter((l) => /^diff --git|^[-+](confidence|usage_count|success_count|failure_count)/.test(l))
  .map((l) => "  " + l).join("\n") || "  (no divergence yet)");

line("Provenance");
console.log(`  branches: ${a}, ${b}  (never merged to main, never a real child)`);
console.log(`  child answers: ${CHILD_MODEL}   verdicts: the judge, grading blind`);
console.log(`  targets derived once per question+age and reused across sessions\n`);
