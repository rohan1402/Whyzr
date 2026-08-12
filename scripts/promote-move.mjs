// scripts/promote-move.mjs: fix 3, promoting a move without its evidence.
//
//   node scripts/promote-move.mjs --child seed-pip --move analogy-bridge
//   node scripts/promote-move.mjs --child seed-pip --move analogy-bridge --dry
//
// A move improved while working with one child should travel to every other
// child. The EVIDENCE that move accumulated must not travel with it, because
// it was earned with a different child, on different questions, at a
// different age. Copying the file wholesale (design section 6, fix 3) drags
// `confidence`, `usage_count`, `success_count`, `failure_count` and
// `negative_examples` into main, where they become the starting position for
// every child provisioned afterwards. A new child would inherit a stranger's
// track record and the selector would act on it immediately.
//
// So: the prose is promoted, the numbers are reset to a clean slate.
//
// This is the deliberate counterpart to the cherry-pick conflict (FEEDBACK
// item 19). Git refuses to merge two children's confidence lines, which is
// correct and is the feature. Promotion to main is the one direction that
// SHOULD be allowed, and it is allowed only because the stats are stripped
// on the way through.

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config, paths, ensureDataDirs } from "../server/config.mjs";
import { git, childBranch, ensureAgentRepo, assertNoRemotes } from "../server/worktrees.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1]; };
const DRY = args.includes("--dry");

/** The clean slate a promoted move starts from, matching gitagent's defaults. */
const FRESH = {
  confidence: "1.0",
  usage_count: "0",
  success_count: "0",
  failure_count: "0",
};

/**
 * Reset every evidence field in the frontmatter, and drop negative_examples
 * entirely. negative_examples is prose about how a move failed a specific
 * child on a specific question, so it is the most obviously personal field
 * of the lot and the one most likely to leak something about them.
 */
export function stripStats(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return text;
  const out = [];
  let skippingList = false;
  for (const line of m[1].split("\n")) {
    // negative_examples is a YAML list, so its indented items must go too.
    if (/^negative_examples:/.test(line)) { skippingList = true; continue; }
    if (skippingList) {
      if (/^\s+[-\s]/.test(line) || line.trim() === "") continue;
      skippingList = false;
    }
    const key = line.match(/^(confidence|usage_count|success_count|failure_count):/);
    out.push(key ? `${key[1]}: ${FRESH[key[1]]}` : line);
  }
  out.push("negative_examples: []");
  return `---\n${out.join("\n")}\n---\n${m[2]}`;
}

function promote(childId, moveName) {
  ensureDataDirs();
  const agent = ensureAgentRepo();
  assertNoRemotes(agent);

  const branch = childBranch(childId);
  const rel = `skills/${moveName}/SKILL.md`;
  const source = git(agent, ["show", `${branch}:${rel}`]);
  const stripped = stripStats(source);

  if (DRY) {
    console.log(stripped.split("\n").slice(0, 12).join("\n"));
    return null;
  }

  // A bare repo has no working tree, so main is checked out temporarily.
  const tmp = join(config.dataDir, `promote-${Date.now()}`);
  git(agent, ["worktree", "add", "--quiet", tmp, "main"]);
  try {
    writeFileSync(join(tmp, rel), stripped);
    git(tmp, ["config", "user.name", "Whyzr"]);
    git(tmp, ["config", "user.email", "whyzr@localhost"]);
    git(tmp, ["add", "--", rel]);
    if (!git(tmp, ["diff", "--cached", "--name-only"])) {
      console.log(`main already matches ${moveName}; nothing to promote`);
      return null;
    }
    git(tmp, ["commit", "--quiet", "-m",
      `promote ${moveName} to main (evidence stripped)`]);
    const hash = git(tmp, ["rev-parse", "--short", "HEAD"]);
    console.log(`promoted ${moveName} from ${branch} to main as ${hash}, stats reset`);
    return hash;
  } finally {
    try { git(agent, ["worktree", "remove", "--force", tmp], { stdio: "pipe" }); } catch { /* best effort */ }
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

// Only run when invoked directly, so the evals can import stripStats.
if (process.argv[1] && process.argv[1].endsWith("promote-move.mjs")) {
  const child = flag("child");
  const move = flag("move");
  if (!child || !move) {
    console.error("usage: node scripts/promote-move.mjs --child <id> --move <name> [--dry]");
    process.exit(1);
  }
  promote(child, move);
}

export { promote };
