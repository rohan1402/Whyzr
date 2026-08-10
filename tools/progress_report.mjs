// progress_report: parent-facing summary built from the growth journal
// (memory/MEMORY.md) and its git history. JSON args on stdin, report on
// stdout. Run with cwd = agent dir (gitagent spawns tool scripts that way).
//
// Parsing is deliberately tolerant: the session-wrapup skill specifies
// canonical labels ("Thinking moves used:", "Sparks for next time:"), but
// models sometimes improvise variants ("Thinking patterns observed:",
// "Curiosity sparks for next time:") and write bullet lists instead of
// inline comma lists. A real session did exactly that (audit finding), so
// the parser accepts both label families and both list shapes.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const JOURNAL = "memory/MEMORY.md";

let rawArgs = "";
process.stdin.on("data", (c) => (rawArgs += c));
process.stdin.on("end", () => {
  let entriesWanted = 3;
  try {
    const n = Number(JSON.parse(rawArgs).entries);
    if (Number.isFinite(n) && n > 0) entriesWanted = Math.floor(n);
  } catch { /* default */ }

  if (!existsSync(JOURNAL)) {
    console.log("No growth journal yet. After the first session, entries will appear here.");
    return;
  }
  const txt = readFileSync(JOURNAL, "utf8");
  const sessions = txt.split(/\n(?=## )/).filter((s) => s.startsWith("## "));

  console.log("# whyAI progress report\n");
  console.log(`Journal sessions recorded: ${sessions.length}\n`);

  console.log("## Journal history (git)");
  try {
    // A journal commit is one that ADDS a session heading (## ...) to the
    // journal. Housekeeping commits (scaffolds, resets) touch the file but
    // never add a session, so they are filtered from the parent view.
    // Message-prefix filtering is deliberately not used: real sessions do
    // not always follow the commit-message convention.
    const raw = execSync(
      `git log -p --date=short --pretty=format:'COMMIT\t%ad\t%s' -- ${JOURNAL}`,
      { encoding: "utf8" }
    );
    const entries = [];
    let current = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("COMMIT\t")) {
        const [, date, subject] = line.split("\t");
        current = { date, subject, addsSession: false };
        entries.push(current);
      } else if (current && /^\+## /.test(line)) {
        current.addsSession = true;
      }
    }
    const journalCommits = entries.filter((e) => e.addsSession);
    console.log(
      journalCommits.length
        ? journalCommits.slice(0, 15).map((e) => `- ${e.date}  ${e.subject}`).join("\n")
        : "- (no journal commits yet)"
    );
  } catch {
    console.log("- (git history unavailable)");
  }
  console.log("");

  if (!sessions.length) return;

  // Collect labeled items: inline content on the label line, or bullet lines
  // directly under the label. splitCommas is true only for fields documented
  // as comma lists (thinking moves); sparks are free prose that may itself
  // contain commas, so they are kept whole.
  function collect(labelRe, splitCommas) {
    const items = [];
    const lines = txt.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(labelRe);
      if (!m) continue;
      const inline = lines[i].slice(m.index + m[0].length).trim();
      if (inline) {
        const parts = splitCommas ? inline.split(",") : [inline];
        for (const part of parts) {
          const p = part.trim().replace(/\.$/, "");
          if (p) items.push(p);
        }
      }
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j].match(/^\s*[-*]\s+(.*)$/);
        if (!b) break;
        items.push(b[1].trim().replace(/\.$/, ""));
      }
    }
    return items;
  }

  const MOVES_RE = /\*\*\s*thinking\s+(moves\s+used|patterns\s+observed)\s*:?\s*\*\*:?/i;
  const SPARKS_RE = /\*\*\s*(curiosity\s+)?sparks\s+for\s+next\s+time\s*:?\s*\*\*:?/i;

  const moves = collect(MOVES_RE, true);
  console.log("## Thinking moves observed");
  if (moves.length) {
    const tally = new Map();
    for (const mv of moves) tally.set(mv, (tally.get(mv) || 0) + 1);
    for (const [mv, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`- ${mv} (x${n})`);
    }
  } else {
    console.log("- (none recorded yet)");
  }
  console.log("");

  const sparks = collect(SPARKS_RE, false);
  console.log("## Open sparks (mysteries the child wants to chase)");
  if (sparks.length) {
    for (const s of sparks.slice(-5)) console.log(`- ${s}`);
  } else {
    console.log("- (none recorded yet)");
  }
  console.log("");

  console.log("## Most recent entries");
  console.log(sessions.slice(-entriesWanted).join("\n"));
});
