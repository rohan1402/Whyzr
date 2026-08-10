// whyAI child-safety guard (pre_tool_use).
// Reads {event, session_id, tool, args} on stdin, prints a verdict:
//   {"action":"allow"} | {"action":"block","reason":"..."}
//
// Policy: deny by default.
//  - memory, task_tracker, skill_learner, progress_report: allowed
//  - cli: DISABLED ENTIRELY. The tutor never needs a shell to help a child
//    think, and a shell allowlist is an injection surface (a prefix-anchored
//    allowlist was bypassable with "date && <anything>", found in audit).
//    No shell, no bypass class.
//  - read: repo files only; no dotfiles or dot-directories in any path
//    segment (case-insensitive, so ".ENV" cannot reach ".env" on
//    case-insensitive filesystems like APFS); no absolute paths or ..
//  - write/edit: only under memory/ or workspace/; the agent can NEVER touch
//    its own constitution (RULES.md, SOUL.md, agent.yaml, hooks/, tools/,
//    skills/) - parents own those files, git history is the change log
//  - capture_photo: blocked (no camera around kids)
//  - anything else: blocked
//
// This script must never crash: gitagent treats hook errors as "allow"
// (fail-open), so every failure path here converges on an explicit verdict,
// and the process exits only after the verdict has flushed to stdout
// (process.exit() before the stream drains can truncate the write, which
// gitagent's JSON.parse failure would turn into an allow).

function verdict(v) {
  process.stdout.write(JSON.stringify(v), () => process.exit(0));
}
const allow = () => verdict({ action: "allow" });
const block = (reason) => verdict({ action: "block", reason });

// Paths the agent may write to. Everything else is parent territory.
const WRITABLE = [/^memory\//, /^workspace\//];

function unsafePath(p) {
  return typeof p !== "string" || p.startsWith("/") || p.startsWith("~") || p.includes("..");
}

// Any dotfile or dot-directory in any path segment (".env", ".ENV",
// ".git/config", "workspace/.hidden"). Case-insensitive by construction.
function hasDotSegment(p) {
  return p.split("/").some((seg) => seg.startsWith("."));
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
  // JSON.parse can succeed on non-objects (null, 5, "x", []); property access
  // on null would throw before any verdict is written, which gitagent treats
  // as fail-open allow. Block anything that is not a plain context object.
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) {
    return block("guard received a non-object hook context; blocking by default");
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
        return block(
          `the shell is disabled for whyAI (attempted: "${cmd.slice(0, 80)}"). ` +
          "whyAI never needs the shell to help a child think - see RULES.md rule 8."
        );
      }

      case "read": {
        const p = String(args.path || "");
        if (unsafePath(p)) return block(`read outside the project is not allowed: "${p}"`);
        if (hasDotSegment(p)) return block(`"${p}" is a hidden or internal file; not readable`);
        return allow();
      }

      case "write":
      case "edit": {
        const p = String(args.path || args.file_path || "");
        if (unsafePath(p)) return block(`${tool} outside the project is not allowed: "${p}"`);
        if (hasDotSegment(p)) return block(`${tool} to hidden or internal files is not allowed: "${p}"`);
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
