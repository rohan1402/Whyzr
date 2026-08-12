// server/review.mjs: Rohan's review tool. A terminal, not a screen.
//
//   npm run review                       overview: kids, usage, budget, sessions
//   npm run review -- --chat <session>   read one conversation
//   npm run review -- --history          every commit in the kid's repo
//   npm run review -- --diff <hash>      what a commit changed (parent edits!)
//
// Works two ways with no flags to remember:
//   - locally: reads the data directory directly
//   - against the deployed app: set WHYZR_URL and ADMIN_KEY, and it fetches
//     (so you can review the sibling test from your own laptop)

import { config, paths } from "./config.mjs";
import * as registry from "./registry.mjs";
import * as journal from "./journal.mjs";
import { listTranscripts, readTranscript } from "./transcripts.mjs";
import { git, childBranch } from "./worktrees.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? true);
};
const REMOTE = process.env.WHYZR_URL || flag("url");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const rule = () => console.log(dim("─".repeat(64)));

async function remote(path, params = {}) {
  const url = new URL(path, REMOTE);
  url.searchParams.set("key", process.env.ADMIN_KEY || "");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function overview() {
  let data;
  if (REMOTE) {
    data = await remote("/api/admin/overview");
  } else {
    const reg = registry.read();
    data = {
      kids: Object.entries(reg.kids).map(([id, k]) => ({
        id, nickname: k.nickname, age: k.age, branch: childBranch(id), usage: k.usage,
        history: journal.repoHistory(paths.kidRepo(id), 60),
      })),
      global: reg.global,
      transcripts: listTranscripts(),
      budget: config.dailyBudgetUsd,
      saveTranscripts: config.saveTranscripts,
    };
  }

  console.log(bold("\nWhyzr review") + dim(REMOTE ? `  (${REMOTE})` : "  (local data dir)"));
  rule();
  const spend = data.global?.spendUsd ?? 0;
  console.log(`Budget today: $${spend.toFixed(3)} of $${data.budget}   ` +
    dim(`transcripts: ${data.saveTranscripts ? "saving" : "off"}`));

  if (!data.kids.length) { console.log(dim("\nNo kids set up yet.")); return; }

  for (const kid of data.kids) {
    console.log(`\n${bold(kid.nickname)} ${dim(`age ${kid.age}, branch ${kid.branch}, id ${kid.id}`)}`);
    const u = kid.usage || {};
    console.log(`  today: ${u.sessions || 0} sessions, ${u.tokens || 0} tokens, $${(u.spendUsd || 0).toFixed(3)}`);
    // Count by what a commit DID, not by loose word matching on its message:
    // journal entries are commits that add a session heading, parent actions
    // are the two messages this app writes itself.
    const journalCommits = REMOTE
      ? (kid.history || []).filter((h) => /^journal:/i.test(h.subject))
      : journal.journalCards(paths.kidRepo(kid.id));
    const parentEdits = (kid.history || []).filter((h) =>
      /^(Edited by parent|Restore original)/.test(h.subject));
    console.log(`  journal entries: ${journalCommits.length}   parent edits: ${bold(String(parentEdits.length))}`);
    for (const e of parentEdits) console.log(dim(`    ${e.hash}  ${e.date}  ${e.subject}`));
  }

  if (data.transcripts?.length) {
    console.log(bold("\nConversations"));
    for (const t of data.transcripts) {
      console.log(`  ${t.sessionId}  ${dim(`${t.turns ?? "?"} turns, ended: ${t.why || "?"}`)}`);
    }
    console.log(dim(`\n  read one:  npm run review -- --chat ${data.transcripts[0].sessionId}`));
  }
  console.log("");
}

async function chat(sessionId) {
  const kidId = flag("kid") || firstKidId();
  const t = REMOTE
    ? await remote("/api/admin/transcript", { kid: kidId, session: sessionId })
    : readTranscript(kidId, sessionId);
  if (!t) { console.log("Conversation not found."); return; }
  console.log(bold(`\nConversation ${t.sessionId}`) + dim(`  ${t.turns} turns, ${t.branch}, ended: ${t.why}`));
  rule();
  for (const m of t.messages || []) {
    const who = m.role === "kid" ? bold("KID  ") : "WHYZR";
    console.log(`\n${who} ${m.text}`);
  }
  console.log("");
}

function firstKidId() {
  return Object.keys(registry.read().kids)[0] || "";
}

async function history() {
  const kidId = flag("kid") || firstKidId();
  const list = REMOTE
    ? (await remote("/api/admin/overview")).kids.find((k) => k.id === kidId)?.history || []
    : journal.repoHistory(paths.kidRepo(kidId), 100);
  console.log(bold(`\nRepo history for ${kidId}`));
  rule();
  for (const h of list) console.log(`${h.hash}  ${h.date}  ${h.subject}`);
  console.log(dim(`\nsee a change:  npm run review -- --diff ${list[0]?.hash || "<hash>"}`));
}

async function diff(hash) {
  const kidId = flag("kid") || firstKidId();
  const out = REMOTE
    ? (await remote("/api/admin/diff", { kid: kidId, hash })).diff
    : journal.commitDiff(paths.kidRepo(kidId), hash);
  console.log(out || "Commit not found.");
}

try {
  if (flag("chat")) await chat(flag("chat"));
  else if (args.includes("--history")) await history();
  else if (flag("diff")) await diff(flag("diff"));
  else await overview();
} catch (err) {
  console.error(`review failed: ${err.message}`);
  if (REMOTE && !process.env.ADMIN_KEY) console.error("(set ADMIN_KEY to read a deployed instance)");
  process.exit(1);
}
