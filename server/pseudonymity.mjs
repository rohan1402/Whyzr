// server/pseudonymity.mjs: keep real identity out of the git history.
//
// The structural work is already done elsewhere: a child is a random 8-char
// id, branches are child-<id>, commit messages carry session ids, and the
// nickname lives only in registry.json, which sits OUTSIDE every git repo and
// which the guard hook forbids the agent from reading. Nothing the app itself
// writes to git contains a name.
//
// The leak that remains is the child. A child who types "my name is <name>,
// why is the sky blue" can have that sentence land in a journal entry the
// model writes, and journal entries are committed. Once committed, they are
// in the branch forever, which is exactly the property this project is
// selling. RULES.md tells the tutor not to record names; this module is the
// enforcement that does not depend on the model complying.
//
// Scope, stated honestly: this catches the registered nickname and obvious
// "my name is X" self-introductions. It is not a general PII detector and
// does not claim to be. Transcripts (SAVE_TRANSCRIPTS, off by default) are
// deliberately raw and are deleted after testing.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { commitInWorktree } from "./worktrees.mjs";

const PLACEHOLDER = "the child";

/** Escape a user-supplied string so it can sit inside a RegExp literally. */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Redact identifying text. Returns { text, hits }.
 *
 * Two passes:
 *   1. the registered nickname, whole-word and case-insensitive
 *   2. self-introductions ("my name is Aarav", "I'm called Aarav"), which
 *      catch the real name even when the nickname is something else
 */
export function redact(text, nickname) {
  let out = String(text ?? "");
  let hits = 0;

  const nick = String(nickname ?? "").trim();
  // A one-character nickname, or one made only of punctuation, would match
  // half the file. Below two characters, structural pseudonymity is all the
  // protection there is.
  if (nick.length >= 2) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(nick)}(?=$|[^\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, (_m, lead) => { hits += 1; return `${lead}${PLACEHOLDER}`; });
  }

  const intro = /\b(my name is|i am called|i'm called|call me)\s+([\p{Lu}][\p{L}'-]{1,30})/giu;
  out = out.replace(intro, (_m, phrase) => { hits += 1; return `${phrase} ${PLACEHOLDER}`; });

  return { text: out, hits };
}

/** Files inside a child's worktree that are allowed to be committed. */
const SCRUBBED = ["memory/MEMORY.md"];

/**
 * Scrub a child's committed-facing files and commit the correction if
 * anything was found. Runs after the session's own commit, so the redaction
 * is itself a visible commit rather than a silent rewrite of history: a
 * parent reviewing the log can see that it happened.
 *
 * Returns { hits, hash } so callers can log it.
 */
export function scrubWorktree(dir, nickname) {
  let hits = 0;
  const touched = [];
  for (const rel of SCRUBBED) {
    const path = join(dir, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    const { text, hits: n } = redact(before, nickname);
    if (n && text !== before) {
      writeFileSync(path, text);
      hits += n;
      touched.push(rel);
    }
  }
  if (!touched.length) return { hits: 0, hash: null };
  const hash = commitInWorktree(dir, touched, "redact: identifying text removed from the journal");
  return { hits, hash };
}
