// tools/call_judge.mjs: the tutor's hand-off to the judge.
//
// Design section 2 (LOCKED): "The tutor calls the judge when it believes the
// child has reached an answer. A tool call, so it is mechanically logged and
// auditable. The tutor controls TIMING, never the VERDICT."
//
// This tool does NOT grade anything, and deliberately cannot. It writes a
// request file into the child's own worktree and returns. The server sees the
// file when the session retires, and the grading happens there, in the server
// process, where the Google API key lives.
//
// That split is the whole point of the design being a tool call:
//
//   - the API key never enters the agent's environment, so a prompt injection
//     that reaches the tutor cannot spend money or exfiltrate a key
//   - the tutor cannot see the verdict, so it cannot learn to argue with it
//     or to steer toward an easier one
//   - the request is a file in git, so "the tutor decided the child was done
//     at this moment" is auditable after the fact rather than a claim
//
// A tutor that could call the judge directly would control both timing and
// outcome, and the separation the whole scoring design rests on would be
// gone.

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUEST_FILE = ".judge-request.json";

function read(stream) {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", () => resolve(""));
  });
}

const raw = await read(process.stdin);
let params = {};
try { params = JSON.parse(raw || "{}"); } catch { params = {}; }

const finalAnswer = String(params.final_answer || "").trim();
if (!finalAnswer) {
  // Refusing here matters: an empty answer graded as "no answer" is a
  // failure, and a tutor that fires this tool by reflex at the end of every
  // conversation would manufacture failures for children who were still
  // thinking. Make it say what it is submitting.
  console.log("No final answer was passed, so nothing was submitted. Call this only once the child has actually said their answer, and pass their exact words.");
  process.exit(0);
}

const cwd = process.cwd();
let question = String(params.question || "").trim();
if (!question) {
  // Fall back to the frozen target's question, which the server wrote when it
  // derived the target at the start of the session.
  try {
    question = JSON.parse(readFileSync(join(cwd, ".judge-target.json"), "utf8")).question || "";
  } catch { /* leave blank; the server has the frozen record anyway */ }
}

writeFileSync(join(cwd, REQUEST_FILE), JSON.stringify({
  final_answer: finalAnswer,
  question,
  at: new Date().toISOString(),
}, null, 2));

// What the tutor is told back is deliberately empty of outcome. It learns
// that the hand-off happened and nothing else, because anything more would
// leak the verdict into the tutor's context.
console.log(
  "Recorded. The session is complete and their answer has been handed over. " +
  "Say a warm goodbye, then write the growth journal entry. You will not be " +
  "told how it was graded, and you should not mention grading to the child."
);
