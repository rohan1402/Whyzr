// server/worktrees.mjs: one git worktree per child.
//
// Each child is a BRANCH of this repository, checked out as its own worktree
// so many children can be in session at once against one shared .git. The
// branch is where that child's learning accumulates: their MEMORY.md facts
// and, more importantly, the confidence stats in skills/<move>/SKILL.md.
// Two children running the same move keep independent scores with no
// isolation code, because git already does that.
//
// FOUR INVARIANTS, all enforced here and asserted by evals:
//
// 1. CHILDREN NEVER LIVE IN THE SOURCE REPO. Worktrees share the parent's
//    .git, so worktreeing off the source would (a) create a `child-<id>`
//    branch inside the repository we push to GitHub, putting a real child's
//    data one `git push --all` away from being public, and (b) require
//    stripping the developer's own origin. Instead there is a separate
//    AGENT REPO on the data volume: a clone of the source with every remote
//    removed. All child branches and worktrees live there.
//
// 2. NO REMOTES, ANYWHERE BELOW THE AGENT REPO. A worktree inherits its
//    parent's remotes, and cannot be stripped individually, so the agent
//    repo is stripped once at creation and every worktree inherits none.
//    Template updates use `git fetch <path>`, which needs no named remote.
//
// 3. ONE WRITER PER CHILD. Two concurrent sessions for the same child would
//    both read stats, both write, and one update would vanish. An O_EXCL
//    lockfile (atomic create) serialises them. Different children stay fully
//    parallel, which is the point of worktrees.
//
// 4. WORKTREES ARE DISPOSABLE, BRANCHES ARE NOT. The worktree directory is
//    filesystem state on a volume; the branch is the durable artifact. On
//    boot, any branch without a worktree is rebuilt.

import { existsSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, paths, ensureDataDirs } from "./config.mjs";

// A lock is held for ONE operation (a turn, or a wrap-up), not a whole
// session. Both have a 90s internal deadline, so the stale threshold must sit
// comfortably above that: at 120s a legitimately slow turn could have its
// lock stolen and admit a second writer, which is the exact corruption the
// lock exists to prevent.
const LOCK_TIMEOUT_MS = 300_000;   // 5 min: > 90s turn + 90s wrap-up + slack
const LOCK_WAIT_MS = 120_000;      // a caller may wait out one full turn
const LOCK_POLL_MS = 100;

/** Run git. Args are always an array, never a shell string. */
export function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...opts,
  }).trim();
}

/**
 * Invariants 1 and 2. Create the agent repo if missing: a clone of the
 * source with every remote removed. Idempotent, safe on every boot.
 */
export function ensureAgentRepo() {
  ensureDataDirs();
  const agent = paths.agentRepo();
  if (!existsSync(join(agent, ".git"))) {
    git(REPO_ROOT, ["clone", "--quiet", "--no-hardlinks", REPO_ROOT, agent]);
    console.log(`[whyzr] created agent repo at ${agent}`);
  }
  const remotes = git(agent, ["remote"]).split("\n").filter(Boolean);
  for (const r of remotes) git(agent, ["remote", "remove", r]);
  if (remotes.length) {
    console.log(`[whyzr] stripped remote(s) [${remotes.join(", ")}] from the agent repo; no child can push anywhere`);
  }
  git(agent, ["config", "user.name", "Whyzr"]);
  git(agent, ["config", "user.email", "whyzr@localhost"]);
  return agent;
}

/**
 * Fast-forward the agent repo's main to the deployed source, without ever
 * configuring a remote (fetch takes a path). Called at boot so a redeploy
 * brings new moves and rule changes to the template. Child branches are
 * untouched: merging main into them is a separate, deliberate step.
 */
export function syncTemplate() {
  const agent = paths.agentRepo();
  try {
    git(agent, ["fetch", "--quiet", REPO_ROOT, "main:main"]);
  } catch (err) {
    // Non-fast-forward means the agent repo's main has diverged from the
    // source, which should not happen: main is only ever written by deploys.
    console.warn(`[whyzr] template sync skipped: ${err.message.split("\n")[0]}`);
  }
  return agent;
}

/** Throws unless the repo (and therefore every worktree) has no remotes. */
export function assertNoRemotes(dir = paths.agentRepo()) {
  const remotes = git(dir, ["remote"]).split("\n").filter(Boolean);
  if (remotes.length) {
    throw new Error(`repo has remotes (${remotes.join(", ")}); refusing to continue`);
  }
}

export const childBranch = (childId) => `child-${childId}`;

function branchExists(branch) {
  try {
    // stdio pipe: a missing ref is an expected answer here, not an error to
    // print. Without this git's "fatal: Needed a single revision" leaks to
    // the server log on every new child.
    git(paths.agentRepo(), ["rev-parse", "--verify", `refs/heads/${branch}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Provision a child's worktree, forked from main. Returns the directory.
 * A new child inherits main's moves with no stats: a clean slate, which is
 * correct, because evidence is earned per child.
 */
export function provisionChild(childId) {
  const agent = ensureAgentRepo();
  const dir = paths.kidRepo(childId);
  const branch = childBranch(childId);

  if (existsSync(join(dir, ".git"))) return dir;

  // A directory with no .git is a leftover from a failed provision.
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  pruneWorktrees();

  if (branchExists(branch)) {
    git(agent, ["worktree", "add", "--quiet", dir, branch]);
  } else {
    git(agent, ["worktree", "add", "--quiet", "-b", branch, dir, "main"]);
  }

  // Commits made inside the worktree (journal saves, confidence updates,
  // parent rules edits) are authored by the app, not by a person.
  git(dir, ["config", "user.name", "Whyzr"]);
  git(dir, ["config", "user.email", "whyzr@localhost"]);

  // Marks the state this child started from. "Restore original rules"
  // restores THIS, never the oldest version in history, which would undo
  // every constitution amendment ever made. Tags are repo-global and the
  // agent repo is shared, so the tag is namespaced per child.
  try { git(dir, ["tag", "--force", templateTag(childId)]); } catch { /* non-fatal */ }

  assertNoRemotes(dir);
  return dir;
}

export const templateTag = (childId) => `template-base-${childId}`;

/** The child id owning a worktree, read from its branch. */
export function childIdOf(dir) {
  const branch = git(dir, ["branch", "--show-current"]);
  return branch.startsWith("child-") ? branch.slice("child-".length) : null;
}

/**
 * The commit a worktree's template state came from: the per-child tag, or
 * the fork point from main if the tag is missing (older worktrees). Never
 * "the first commit touching this file", which would restore a constitution
 * from before every amendment.
 */
export function templateBase(dir) {
  const childId = childIdOf(dir);
  if (childId) {
    try {
      git(dir, ["rev-parse", "--verify", `${templateTag(childId)}^{commit}`], { stdio: "pipe" });
      return templateTag(childId);
    } catch { /* fall through */ }
  }
  try {
    return git(dir, ["merge-base", "HEAD", "main"], { stdio: "pipe" });
  } catch {
    return "HEAD";
  }
}

// ----------------------------------------------------------- writing to git

/** Stage paths and commit if anything changed. Returns the short hash or null. */
export function commitInWorktree(dir, addPaths, message) {
  assertNoRemotes(dir);
  git(dir, ["add", "--", ...addPaths]);
  const staged = git(dir, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  git(dir, ["commit", "--quiet", "-m", message]);
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

/**
 * THE FIX THAT MAKES THIS PROJECT GIT-NATIVE.
 *
 * gitagent's reinforcement learning writes skill stats with writeFile and
 * never commits (verified: tools/task-tracker.js calls saveSkillStats, which
 * is a bare write). Left alone, every confidence update is an uncommitted
 * working-tree change, which means: rebuilding a worktree from its branch
 * destroys all learning, and `git diff child-a child-b -- skills/` (the
 * entire thesis of this design) returns empty.
 *
 * So the app commits the learning itself, once per session.
 */
export function commitLearning(dir, note) {
  return commitInWorktree(dir, ["skills/"], `learning: ${note}`);
}

/** Commit whatever the session wrote: journal facts and skill evidence. */
export function commitSession(dir, note) {
  return commitInWorktree(dir, ["skills/", "memory/"], `session: ${note}`);
}

/** Restore a tracked file to the state this child was provisioned with. */
export function restoreOriginal(dir, relPath) {
  git(dir, ["checkout", templateBase(dir), "--", relPath]);
  return commitInWorktree(dir, [relPath], `Restore original ${relPath}`);
}

export function pruneWorktrees() {
  try { git(paths.agentRepo(), ["worktree", "prune"]); } catch { /* best effort */ }
}

/** Every child branch currently known to the repo. */
export function listChildBranches() {
  return git(paths.agentRepo(), ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    .split("\n")
    .filter((b) => b.startsWith("child-"))
    .map((b) => b.slice("child-".length));
}

/**
 * Invariant 4. Worktrees live on a volume and can go missing (fresh
 * container, wiped disk, manual cleanup) while the branch survives in .git.
 * Rebuild them at boot so a returning child keeps their history.
 */
export function rebuildMissingWorktrees() {
  pruneWorktrees();
  const rebuilt = [];
  for (const childId of listChildBranches()) {
    if (!existsSync(join(paths.kidRepo(childId), ".git"))) {
      try {
        provisionChild(childId);
        rebuilt.push(childId);
      } catch (err) {
        console.error(`[whyzr] could not rebuild worktree for ${childId}: ${err.message}`);
      }
    }
  }
  if (rebuilt.length) console.log(`[whyzr] rebuilt ${rebuilt.length} worktree(s) from branches: ${rebuilt.join(", ")}`);
  return rebuilt;
}

// ------------------------------------------------------------------ locking

// Locks live OUTSIDE the worktree. Inside, the lock file showed up as an
// untracked change: it dirtied `git status`, could be swept into a commit by
// any `git add -A`, and made "is this worktree clean" untestable.
const lockPath = (childId) => join(paths.locksDir(), `${childId}.lock`);

/**
  * Invariant 3. Acquire the per-child lock via O_EXCL, which is atomic: the
 * create either succeeds or fails, with no window where two callers both
 * think they won. A lock older than LOCK_TIMEOUT_MS is treated as abandoned
 * (crashed process) and reclaimed, so a crash cannot wedge a child forever.
 */
export async function withChildLock(childId, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const path = lockPath(childId);
  const deadline = Date.now() + waitMs;
  let fd = null;

  for (;;) {
    try {
      fd = openSync(path, "wx");  // wx === O_CREAT | O_EXCL
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (reclaimIfStale(path)) continue;
      if (Date.now() > deadline) {
        throw new Error(`another session is already active for this child (waited ${waitMs}ms)`);
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }

  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch { /* the lock is the file's existence, not its contents */ }

  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

function reclaimIfStale(path) {
  try {
    const { at } = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isFinite(at) && Date.now() - at > LOCK_TIMEOUT_MS) {
      unlinkSync(path);
      console.warn(`[whyzr] reclaimed stale session lock: ${path}`);
      return true;
    }
  } catch {
    // Unreadable or half-written lock file: if it is old enough, drop it.
    try {
      const { mtimeMs } = statSync(path);
      if (Date.now() - mtimeMs > LOCK_TIMEOUT_MS) { unlinkSync(path); return true; }
    } catch { /* gone already */ }
  }
  return false;
}

/** True while a session holds this child's lock. */
export function isChildLocked(childId) {
  return existsSync(lockPath(childId));
}

// ------------------------------------------------------------------ removal

/**
 * Delete a child completely: worktree, branch, and the objects behind them.
 * `git branch -D` only drops the pointer, so the reflog expiry and gc are
 * the parts that actually remove the data.
 */
export function deleteChild(childId) {
  const dir = paths.kidRepo(childId);
  const branch = childBranch(childId);
  try { git(paths.agentRepo(), ["worktree", "remove", "--force", dir]); } catch { /* may not exist */ }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  pruneWorktrees();
  try { git(paths.agentRepo(), ["branch", "-D", branch]); } catch { /* may not exist */ }
  try { git(paths.agentRepo(), ["tag", "-d", templateTag(childId)]); } catch { /* may not exist */ }
  try {
    git(paths.agentRepo(), ["reflog", "expire", "--expire=now", "--all"]);
    git(paths.agentRepo(), ["gc", "--prune=now", "--quiet"]);
  } catch { /* best effort; the script does this thoroughly */ }
  return true;
}
