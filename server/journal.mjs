// server/journal.mjs: read a kid's repo for the parent dashboard.
//
// Everything here is read-only except the rules editor, which commits inside
// the child's own worktree (which has no remotes: see worktrees.mjs
// invariants 1 and 2, so a parent's edit can never reach GitHub).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { git, commitInWorktree, restoreOriginal, assertNoRemotes } from "./worktrees.mjs";
import { paths } from "./config.mjs";

const JOURNAL = "memory/MEMORY.md";

/**
 * Journal entries as cards. A journal commit is one whose diff ADDS a session
 * heading; housekeeping commits that merely touch the file are filtered out
 * (same rule as the progress_report tool).
 */
export function journalCards(repoDir) {
  let raw = "";
  try {
    raw = git(repoDir, ["log", "-p", "--date=short", "--pretty=format:COMMIT\t%h\t%ad\t%s", "--", JOURNAL]);
  } catch {
    return [];
  }
  const cards = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("COMMIT\t")) {
      const [, hash, date, subject] = line.split("\t");
      current = { hash, date, subject, addsSession: false, added: [] };
      cards.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      if (/^## /.test(text)) current.addsSession = true;
      current.added.push(text);
    }
  }
  return cards
    .filter((c) => c.addsSession)
    .map((c) => ({
      hash: c.hash,
      date: c.date,
      subject: c.subject,
      title: (c.added.find((l) => /^## /.test(l)) || "").replace(/^##\s*/, ""),
      figuredOut: extractField(c.added, /what they figured out/i),
      thinkingMoves: extractField(c.added, /thinking (moves used|patterns observed)/i),
      sparks: extractField(c.added, /(curiosity )?sparks for next time/i),
    }));
}

function extractField(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`\\*\\*\\s*(${labelRe.source})\\s*:?\\s*\\*\\*:?`, "i"));
    if (!m) continue;
    const inline = lines[i].slice(m.index + m[0].length).trim();
    if (inline) return inline;
    const bullets = [];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j].match(/^\s*[-*]\s+(.*)$/);
      if (!b) break;
      bullets.push(b[1].trim());
    }
    if (bullets.length) return bullets.join("; ");
  }
  return null;
}

/** Full commit history of the kid's repo, including parent edits. */
export function repoHistory(repoDir, limit = 40) {
  try {
    return git(repoDir, ["log", `-${limit}`, "--date=short", "--pretty=format:%h\t%ad\t%s"])
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, date, ...rest] = l.split("\t");
        return { hash, date, subject: rest.join("\t") };
      });
  } catch {
    return [];
  }
}

export function commitDiff(repoDir, hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return null;
  try {
    return git(repoDir, ["show", "--format=%h %ad %s%n", "--date=short", hash]);
  } catch {
    return null;
  }
}

export function readRules(repoDir) {
  const p = join(repoDir, "RULES.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Save a parent's rules edit as a commit inside the kid's repo only. */
export function saveRules(repoDir, text) {
  assertNoRemotes(repoDir);
  if (typeof text !== "string" || text.length > 60_000) throw new Error("rules text rejected");
  writeFileSync(join(repoDir, "RULES.md"), text);
  return commitInWorktree(repoDir, ["RULES.md"], "Edited by parent");
}

export function restoreRules(repoDir) {
  return restoreOriginal(repoDir, "RULES.md");
}

/** Run the repo's own progress_report tool inside the kid's clone. */
export function progressReport(repoDir) {
  try {
    return execFileSync("node", ["tools/progress_report.mjs"], {
      cwd: repoDir,
      input: "{}",
      encoding: "utf8",
      timeout: 20_000,
    });
  } catch (err) {
    return `Progress report unavailable: ${err.message}`;
  }
}

export function kidRepoDir(kidId) {
  return paths.kidRepo(kidId);
}
