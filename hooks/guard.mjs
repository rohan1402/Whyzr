// Whyzr child-safety guard (pre_tool_use).
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

/**
 * The characters that can actually break out, scoped to where the value
 * lands. gitagent interpolates into a DOUBLE-QUOTED shell word:
 *
 *   git commit -m "<value>"
 *
 * Inside double quotes, `;` `|` `&` `<` `>` and newlines are literal, so
 * blocking them would refuse ordinary journal prose ("she asked why; then
 * she guessed") to stop nothing. Exactly three characters matter:
 *
 *   $         command substitution, $(...) and ${...}
 *   backtick  the older command substitution
 *   \         gitagent escapes " as \", so a trailing backslash escapes the
 *             escape and closes the quoted string early
 *
 * Narrow on purpose. A guard that breaks the product to stop an attack gets
 * switched off, and a switched-off guard protects nobody.
 */
const SHELL_META = /[$`\\]/;

/**
 * Argument names that never reach a shell and so are not checked.
 *
 * `content` is the journal body: memory.js writes it with writeFile and only
 * `message` is interpolated into the commit command (verified,
 * dist/tools/memory.js:111-120). A child's question genuinely can contain a
 * dollar sign ("why does a dollar buy less than it used to"), and refusing
 * to record that would be the guard damaging the product it protects.
 */
const NOT_SHELLED = new Set(["content"]);

/** Walk the args and report the first value that could break out of a shell. */
function shellUnsafe(args, depth = 0) {
  if (depth > 6) return null; // defensive: no unbounded recursion
  if (typeof args === "string") {
    const hit = args.match(SHELL_META);
    return hit ? JSON.stringify(hit[0]) : null;
  }
  if (Array.isArray(args)) {
    for (const v of args) {
      const found = shellUnsafe(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args)) {
      if (NOT_SHELLED.has(k)) continue;
      const found = shellUnsafe(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

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
      // These three are allowed by PURPOSE but not by trust. gitagent builds
      // a shell string from their arguments and runs it through execSync,
      // escaping only the double quote:
      //
      //   execSync(`git add "..." && git commit -m "${msg.replace(/"/g,'\\"')}"`)
      //   (dist/tools/memory.js:120, skill-learner.js:78 and :341)
      //
      // `$(...)` and backticks survive that and execute. The message is
      // chosen by the model, so any prompt injection that reaches a commit
      // message is arbitrary command execution in this process, with this
      // process's environment. Verified: a message containing
      // `$(touch PROOF.txt)` created the file, and the commit subject still
      // read normally afterwards.
      //
      // Allow-listing by tool name is therefore not enough. A guard that
      // waves these through inspects nothing, which is the appearance of a
      // sandbox rather than a sandbox. Reported upstream as FEEDBACK item 21;
      // until it is fixed, the arguments are checked here.
      case "memory":
      case "task_tracker":
      case "skill_learner": {
        const unsafe = shellUnsafe(args);
        if (unsafe) {
          return block(
            `${tool} argument contains shell metacharacters (${unsafe}). ` +
            "gitagent passes these to a shell, so they are refused here."
          );
        }
        return allow();
      }

      case "progress_report":
      // call_judge writes a JSON request file in the child's own worktree and
      // shells out to nothing, so the metacharacter check above does not
      // apply. It cannot reach the judge or the API key by design: the server
      // does the grading. See tools/call_judge.mjs.
      case "call_judge":
        return allow();

      case "cli": {
        const cmd = String(args.command || "").trim();
        return block(
          `the shell is disabled for Whyzr (attempted: "${cmd.slice(0, 80)}"). ` +
          "Whyzr never needs the shell to help a child think - see RULES.md rule 8."
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
          `${tool} to "${p}" is not allowed. Whyzr may only write under memory/ and workspace/. ` +
          "RULES.md, SOUL.md and the agent's own configuration belong to parents."
        );
      }

      case "capture_photo":
        return block("camera use is disabled around children");

      default:
        return block(`tool "${tool}" is not on Whyzr's allowlist`);
    }
  } catch (err) {
    return block(`guard error (${err.message}); blocking by default`);
  }
});
