// whyAI child-safety guard (pre_tool_use).
// Reads {event, session_id, tool, args} on stdin, prints a verdict:
//   {"action":"allow"} | {"action":"block","reason":"..."}
//
// Policy: deny by default.
//  - memory, task_tracker, skill_learner, progress_report: allowed
//  - cli: small allowlist (date, git log/show/diff, ls, wc, pwd) - the tutor
//    never needs the shell to answer a child's question
//  - read: repo files only; never .env*, never absolute paths or ..
//  - write/edit: only under memory/ or workspace/; the agent can NEVER touch
//    its own constitution (RULES.md, SOUL.md, agent.yaml, hooks/, tools/,
//    skills/) - parents own those files, git history is the change log
//  - capture_photo: blocked (no camera around kids)
//  - anything else: blocked
//
// This script must never crash: gitagent treats hook errors as "allow"
// (fail-open), so every failure path here converges on an explicit verdict.

function verdict(v) {
  process.stdout.write(JSON.stringify(v));
  process.exit(0);
}
const allow = () => verdict({ action: "allow" });
const block = (reason) => verdict({ action: "block", reason });

const CLI_ALLOWLIST = [
  /^date(\s|$)/,
  /^ls(\s|$)/,
  /^pwd$/,
  /^wc(\s|$)/,
  /^git log(\s|$)|^git log$/,
  /^git show(\s|$)/,
  /^git diff(\s|$)/,
];

// Paths the agent may write to. Everything else is parent territory.
const WRITABLE = [/^memory\//, /^workspace\//];

// Never readable, even inside the repo.
const UNREADABLE = [/^\.env/, /^\.git\//, /(^|\/)\.env/];

function unsafePath(p) {
  return typeof p !== "string" || p.startsWith("/") || p.startsWith("~") || p.includes("..");
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let ctx;
  try {
    ctx = JSON.parse(raw);
  } catch {
    return block("guard could not parse hook input; blocking by default");
  }
  const tool = ctx.tool || "";
  const args = ctx.args || {};

  try {
    switch (tool) {
      case "memory":
      case "task_tracker":
      case "skill_learner":
      case "progress_report":
        return allow();

      case "cli": {
        const cmd = String(args.command || "").trim();
        if (CLI_ALLOWLIST.some((re) => re.test(cmd))) return allow();
        return block(
          `shell command not on the allowlist: "${cmd.slice(0, 80)}". ` +
          "whyAI never needs the shell to help a child think - see RULES.md rule 7."
        );
      }

      case "read": {
        const p = String(args.path || "");
        if (unsafePath(p)) return block(`read outside the project is not allowed: "${p}"`);
        if (UNREADABLE.some((re) => re.test(p))) return block(`"${p}" holds secrets or internals; not readable`);
        return allow();
      }

      case "write":
      case "edit": {
        const p = String(args.path || args.file_path || "");
        if (unsafePath(p)) return block(`${tool} outside the project is not allowed: "${p}"`);
        if (WRITABLE.some((re) => re.test(p))) return allow();
        return block(
          `${tool} to "${p}" is not allowed. whyAI may only write under memory/ and workspace/. ` +
          "RULES.md, SOUL.md and the agent's own configuration belong to parents."
        );
      }

      case "capture_photo":
        return block("camera use is disabled around children");

      default:
        return block(`tool "${tool}" is not on whyAI's allowlist`);
    }
  } catch (err) {
    return block(`guard error (${err.message}); blocking by default`);
  }
});
