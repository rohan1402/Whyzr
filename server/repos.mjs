// server/repos.mjs: one git repo per kid.
//
// Each kid gets a full clone of the Whyzr template repo on the server's
// persistent volume. Their age IS the branch that clone has checked out, so
// journal commits land on the right persona branch automatically.
//
// TWO INVARIANTS, both enforced here and asserted by evals:
//
// 1. NO REMOTES. Nothing a parent does in the app can ever reach
//    github.com/rohan1402/Whyzr. The clone's remotes are removed at creation
//    and no code path in this app runs `git push`.
//
// 2. LOCAL BRANCHES BEFORE STRIPPING. A fresh clone only has `main` as a
//    local branch; age-5 and age-12 exist solely as remote-tracking refs.
//    Removing the remote first makes `git checkout age-5` fail with
//    "pathspec did not match". So local tracking branches are materialized
//    FIRST, then the remote is removed. (Found by audit; regression-tested.)

import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, paths, ensureDataDirs } from "./config.mjs";

const AGE_BRANCHES = ["age-5", "main", "age-12"];

// Tag written at clone time marking the exact template state this kid started
// from. It is what "restore original" restores.
export const TEMPLATE_TAG = "whyzr-template-base";

/** Run git in a directory. Args are an array: never a shell string. */
export function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...opts,
  }).trim();
}

/**
 * Snap any typed age to the nearest persona branch.
 * Returns { branch, age, note } where note is a warm, user-facing string
 * (never silent: silent snapping reads as a bug).
 */
export function snapAge(rawAge) {
  const age = Math.round(Number(rawAge));
  if (!Number.isFinite(age)) return { branch: "main", age: 8, note: null };

  // "an 8 year old", not "a 8 year old": 8, 11 and 18 take "an".
  const a = /^(8|11|18)/.test(String(age)) ? "an" : "a";

  if (age <= 6) {
    return {
      branch: "age-5",
      age,
      note: age < 4
        ? `Whyzr is built for kids from about 4 up. For ${a} ${age} year old, sit together and explore as a pair.`
        : `Got it. Whyzr will talk like a friend for ${a} ${age} year old.`,
    };
  }
  if (age <= 10) {
    return { branch: "main", age, note: `Got it. Whyzr will talk like a friend for ${a} ${age} year old.` };
  }
  if (age <= 14) {
    return { branch: "age-12", age, note: `Got it. Whyzr will talk like a lab partner for ${a} ${age} year old.` };
  }
  return {
    branch: "age-12",
    age,
    note: `Whyzr is built for kids up to about 14, but you are welcome to try. Using the oldest setting.`,
  };
}

/**
 * Create a kid's repo: clone the template, materialize the age branches,
 * strip every remote, then check out the persona branch.
 */
export function provisionKidRepo(kidId, branch) {
  ensureDataDirs();
  const dest = paths.kidRepo(kidId);
  if (existsSync(dest)) return dest;

  git(REPO_ROOT, ["clone", "--quiet", REPO_ROOT, dest]);

  // Order matters. See invariant 2 above.
  for (const b of AGE_BRANCHES) {
    if (b === "main") continue;
    try {
      git(dest, ["branch", "--quiet", "--track", b, `origin/${b}`]);
    } catch {
      // Branch may already exist locally; harmless.
    }
  }
  for (const remote of git(dest, ["remote"]).split("\n").filter(Boolean)) {
    git(dest, ["remote", "remove", remote]);
  }

  // Always check out explicitly: without this, a kid snapped to "main"
  // inherits whatever branch the server's own repo happened to be on.
  git(dest, ["checkout", "--quiet", branch || "main"]);

  // Identity for journal + parent-edit commits made inside this clone.
  git(dest, ["config", "user.name", "Whyzr"]);
  git(dest, ["config", "user.email", "whyzr@localhost"]);

  // Mark the state this kid was provisioned with. "Restore original rules"
  // means THIS, not the oldest version in history: walking back through the
  // log would revert every constitution amendment ever made and hand the
  // child a tutor governed by the very first draft of the rules.
  git(dest, ["tag", TEMPLATE_TAG]);

  assertNoRemotes(dest);
  return dest;
}

/** Throws if the repo has any remote. Called at creation and before writes. */
export function assertNoRemotes(repoDir) {
  const remotes = git(repoDir, ["remote"]).split("\n").filter(Boolean);
  if (remotes.length) {
    throw new Error(`kid repo has remotes (${remotes.join(", ")}); refusing to continue`);
  }
}

/**
 * Move a kid to a different persona branch, carrying their journal across so
 * months of history survive an age change. The git history narrates it.
 */
export function changeAgeBranch(repoDir, fromBranch, toBranch) {
  if (fromBranch === toBranch) return false;
  assertNoRemotes(repoDir);
  git(repoDir, ["checkout", "--quiet", toBranch]);
  try {
    git(repoDir, ["checkout", fromBranch, "--", "memory/"]);
  } catch {
    return true; // nothing to carry yet
  }
  const dirty = git(repoDir, ["status", "--porcelain"]);
  if (dirty) {
    git(repoDir, ["add", "memory/"]);
    git(repoDir, ["commit", "--quiet", "-m", `Carry journal across age change (${fromBranch} to ${toBranch})`]);
  }
  return true;
}

/** Commit a parent's edit inside the kid's repo only. */
export function commitParentEdit(repoDir, relPath, message) {
  assertNoRemotes(repoDir);
  git(repoDir, ["add", relPath]);
  const staged = git(repoDir, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  git(repoDir, ["commit", "--quiet", "-m", message]);
  return git(repoDir, ["rev-parse", "--short", "HEAD"]);
}

/**
 * Restore a file to the state this kid's repo was PROVISIONED with, using the
 * tag written at clone time. Never walk back through history looking for the
 * "first" version: that would restore a pre-amendment constitution.
 */
export function restoreOriginal(repoDir, relPath) {
  assertNoRemotes(repoDir);
  let base = TEMPLATE_TAG;
  try {
    git(repoDir, ["rev-parse", "--verify", `${TEMPLATE_TAG}^{commit}`]);
  } catch {
    // Repo provisioned before tagging existed. Fall back to the newest commit
    // that is NOT a parent edit, which is the last template-authored state.
    const log = git(repoDir, ["log", "--format=%H%x09%s", "--", relPath]).split("\n").filter(Boolean);
    const clean = log.find((l) => !/^\S+\t(Edited by parent|Restore original)/.test(l));
    base = clean ? clean.split("\t")[0] : "HEAD";
  }
  git(repoDir, ["checkout", base, "--", relPath]);
  return commitParentEdit(repoDir, relPath, `Restore original ${relPath}`);
}

export function deleteKidRepo(kidId) {
  const dir = paths.kidRepo(kidId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
