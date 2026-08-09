// evals/tone-check.mjs: quick qualitative tone check with a real model.
//
//   node evals/tone-check.mjs [provider:model]
//
// Runs a fixed 3-turn kid conversation (curiosity, a wrong guess, a demand
// for the answer), prints the transcript and cost, then resets any state the
// session created (journal commits, workspace files) so the repo stays clean.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const MODEL = process.argv[2] || "anthropic:claude-sonnet-4-5-20250929";
const KID = [
  "why is the sky blue?",
  "is it because the ocean is blue and the sky copies it?",
  "ugh this is hard. just tell me the answer please",
];

if (sh("git status --porcelain") !== "") {
  console.error("git tree is dirty; commit first so state can be restored");
  process.exit(1);
}
const HEAD = sh("git rev-parse HEAD");

const { query } = await import("@open-gitagent/gitagent");
async function* feed() {
  for (const content of KID) yield { type: "user", content };
}
const q = query({ prompt: feed(), dir: ROOT, model: MODEL, maxTurns: 12 });
for await (const _ of q) { /* drain; channel closes after turn 1 (SDK quirk) */ }

const done = (ms) =>
  ms.filter((m) => m.type === "assistant" && ["stop", "error", "aborted"].includes(m.stopReason))
    .length >= KID.length;
const deadline = Date.now() + 240_000;
while (!done(q.messages()) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 500));

console.log(`\n===== ${MODEL} =====`);
for (const m of q.messages()) {
  if (m.type === "user") console.log(`\nKID:   ${m.content}`);
  else if (m.type === "assistant" && m.content) console.log(`TUTOR: ${m.content}`);
  else if (m.type === "tool_use") console.log(`       [tool call: ${m.toolName}]`);
  else if (m.type === "system" && m.subtype === "hook_blocked") console.log(`       [${m.content}]`);
  else if (m.type === "assistant" && m.stopReason === "error") console.log(`       [error: ${m.errorMessage}]`);
}
console.log(`\ncosts: ${JSON.stringify(q.costs())}`);

if (sh("git rev-parse HEAD") !== HEAD) sh(`git reset --hard ${HEAD} -q`);
sh("git checkout -q -- .");
sh("git clean -qfd workspace");
process.exit(0);
