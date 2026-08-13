# Feedback for the gitagent team

Everything below was found while building Whyzr, by using gitagent as the
load-bearing chassis: CLI, SDK, hooks, memory, declarative tools, branches,
and the voice package. Versions tested: @open-gitagent/gitagent 2.0.2,
@open-gitagent/voice 1.0.0, Node 24 on macOS. Each item lists what happens,
why it matters, how Whyzr works around it, and a suggested fix. Items 1 to 5
are the CLI and runtime, 6 to 7 are the SDK, 8 to 11 are the voice package,
12 to 21 are the learning system, and 22 is the skills boundary. Item 21 is
a security issue and is the one we would fix first; item 22 cost us the most
time of anything here.

## 1. Any invocation scaffolds and auto-commits in the current directory

What happens: running `gitagent` anywhere immediately scaffolds an agent in
the cwd, and if the working tree is dirty it commits everything with the
generic message "Scaffold gitagent agent".

Why it matters: user changes get swallowed into anonymous commits. It
happened to us twice; we rebuilt those commits by hand to keep a reviewable
history. In a git-native tool, the history is a feature, and this behavior
damages it.

Whyzr workaround: we commit our own work before every gitagent invocation,
and our eval runner refuses to start on a dirty tree.

Suggested fix: never commit user changes silently. Ask, or scaffold only
behind an explicit `gitagent init`.

## 2. Scaffold only updates .gitignore if one already exists

What happens: if the directory has no .gitignore, `.gitagent/state.json`
gets tracked. Later, `git checkout` between branches fails because state.json
differs.

Why it matters: branches are gitagent's own headline feature (our age modes
depend on them), and this silently breaks branch switching for anyone who
scaffolds into an empty directory.

Whyzr workaround: we created .gitignore with `.gitagent/` before the first
run. It is the first commit in our history.

Suggested fix: always write or update .gitignore during scaffold.

## 3. `gitagent plugin init <name>` crashes

What happens: the scaffold is created, then it throws
`pluginsNode.set is not a function` while updating agent.yaml (v2.0.2).

Whyzr workaround: we avoid plugins entirely.

Suggested fix: likely a YAML node API mismatch in the agent.yaml update path.

## 4. Hooks fail open

What happens: if a pre_tool_use hook script crashes, times out, or exits
nonzero, runHooks logs the error and allows the tool call.

Why it matters: pre_tool_use is where safety enforcement lives. A safety
hook that fails open is a safety hook that can be disabled by any bug in the
hook itself. For Whyzr the hook IS the child-safety layer.

Whyzr workaround: hooks/guard.sh delegates to a node script written to never
crash, and it blocks (not allows) when input is unparseable.

Suggested fix: make failure behavior configurable per hook, with fail-closed
as the recommended default for pre_tool_use.

## 5. The agent.yaml tools list appears to be ignored

What happens: the loaded toolset does not follow agent.yaml. First
observed with `capture_photo` (loads and appears in the system prompt
despite not being listed). Later confirmed stronger: removing `cli` from
the tools list entirely still produces a session banner of
"Tools: cli, read, write, edit, memory, capture_photo, ..." with cli
present and callable.

Why it matters: an agent author who removes a tool expects it gone. A camera
tool appearing uninvited in a children's product is exactly the kind of
surprise that erodes trust.

Whyzr workaround: the guard hook is deny-by-default, so unlisted tools are
blocked at execution time regardless of what loads.

Suggested fix: honor the tools list strictly, or document which tools are
always on.

## 6. SDK: multi-turn AsyncIterable prompts end the public stream after turn one

What happens: with `query({prompt: asyncIterable})`, the agent_end event
fires after every completed prompt and its handler calls channel.finish().
The internal turn loop keeps running, but the public `for await (const m of
q)` stream ends after the first turn. Consumers silently see one turn of a
multi-turn conversation.

Whyzr workaround: drain the short-lived stream, then poll `q.messages()`
(the internal accumulator keeps growing) until each turn completes. Both our
eval runner and our kid UI server do this.

Suggested fix: only finish the channel when the prompt iterable is exhausted.

## 7. SDK: Query.steer() is a no-op

What happens: `steer(message)` has an empty function body in 2.0.2, so
mid-run steering silently does nothing.

Suggested fix: implement it or remove it from the type surface until it
works. A silent no-op is worse than an error.

## 8. Voice package: the file API serves secrets with no auth

What happens: `/api/file?path=.env` returns the agent's .env, API key
included. The only check is that the path resolves inside the agent
directory. Auth is off by default (the server logs "Auth: open").

Why it matters: anyone who can reach port 3333 can read every secret in the
agent directory. Combined with default-open auth, this is remote key
exfiltration in one GET request.

Whyzr handling: we do not ship the voice cockpit. Our own kid UI binds to
127.0.0.1, serves exactly one HTML file, and has no file API at all.

Suggested fix: deny dotfiles and an explicit denylist (.env, .git) in the
file API, and make auth opt-out rather than opt-in.

## 9. Voice package: text-only mode never displays the agent's reply

What happens: without a voice adapter key, text chat reaches the agent
correctly (the reply is present in /api/chat/history), but the web UI never
renders the assistant message, live or after reload.

Why it matters: text-only is the advertised fallback ("Text chat works
normally"), and it looks completely broken to a user.

Whyzr handling: we verified the agent side works via the history API, then
built our own interface.

## 10. Voice package: side channels replace the agent's system prompt

What happens: the Telegram bridge calls query() with its own generic
`systemPrompt` ("You are an AI assistant responding to a Telegram user..."),
which replaces the agent's SOUL and persona assembly for those turns.

Why it matters: an agent's identity and prompt-level rules silently vanish
on that channel. For Whyzr, the tutor would stop being a tutor on Telegram.
Code-level enforcement (hooks) still applies, which is why we enforce safety
in code, but the persona layer is gone.

Whyzr handling: we do not enable any side channels.

Suggested fix: side channels should append channel context via
systemPromptSuffix, not replace the agent's system prompt.

## 11. Voice architecture note: the speaking model is not the governed agent

What happens: in voice mode, the OpenAI Realtime or Gemini Live model is the
conversational brain; the gitagent runs behind it. The realtime model can
answer the user directly without consulting the governed agent, and none of
the agent's SOUL, RULES, or hooks apply to what it says.

Why it matters: for any agent whose value is its governance (ours is a
children's tutor with a constitution), voice mode routes the conversation
around the governance.

Whyzr handling: our kid UI keeps Claude as the only model. The browser does
speech-to-text and text-to-speech; every utterance round-trips through the
governed agent.

Suggested fix: offer a relay mode where the realtime model is restricted to
transcription and speech, and all conversational content comes from the
gitagent.

---

# Second round: the learning system

Items 12 to 19 come from building Whyzr's actual product loop on
`skills/`, `adjustConfidence` and the reinforcement primitives. Everything
below was read from the shipped source of 2.0.2 or observed running, and
each says which.

## 12. Skill stats are written but never committed, in a git-native framework

What happens: `saveSkillStats` (dist/learning/reinforcement.js:78) is a bare
`writeFile`. `task_tracker end` calls it after adjusting confidence, and
nothing ever commits the result.

Why it matters: this is the one that stings, because git is the whole pitch.
Every confidence update sits as an uncommitted working-tree change. It is
invisible to `git diff`, so the natural question for a multi-agent setup,
"how do these two forks differ in what they have learned", returns nothing.
It is also destroyed by any `git checkout`, `git worktree` rebuild, or fresh
container. An agent that learns but never commits its learning is not
git-native, it is a program with a text file.

Whyzr workaround: the application commits the skills directory itself, once
per session, alongside the journal.

Suggested fix: commit stat changes the way the memory tool already commits
memory (dist/tools/memory.js:120 does exactly this). It would make
`git diff agent-a agent-b -- skills/` work out of the box, which is the most
compelling demo the framework has.

## 13. Successes are a no-op until something fails

What happens: skills start at `confidence: 1.0`, and the success branch is
`confidence + 0.1 * (1 - confidence)` (reinforcement.js:19), which is exactly
0 at 1.0. Failure is a flat `-0.2` (reinforcement.js:24).

Why it matters: a brand new skill that succeeds 50 times in a row has
confidence 1.0, the same as one that has never been used. The number only
starts carrying information after the first failure. Observed live in Whyzr:
a child reached the answer, the judge returned success, and confidence moved
from 1.0 to 1.0.

Whyzr workaround: we do not select on confidence at all (see 14).

Suggested fix: start skills below 1.0, or document plainly that confidence is
a penalty counter rather than a quality estimate.

## 14. Confidence saturates, so it cannot rank two working skills

What happens: given the asymmetry in 13, confidence cannot represent "this
skill works better than that one". Both sit at 1.0 until one fails, and
after a failure the gap reflects recency of failure rather than quality.

Why it matters: `skill_learner status` already displays a success ratio, and
the counts needed for a real estimate (`usage_count`, `success_count`) are
already tracked. The information is there; confidence just is not the field
that carries it.

Observed, not just argued. In a seeded run of 20 sessions with one child,
the best move available to that child ended at **confidence 0.09 with a
success rate of 8 in 14**. `isSkillFlagged` calls anything below 0.4 a skill
in trouble, so by that measure it was the worst skill in the library, while
by success rate it was the best one that child had. Both numbers are right
about different things: confidence is a decaying penalty counter that still
remembers six failures, and the ratio says the child reaches the answer with
it more often than with anything else. An application that selected on
confidence, which is the obvious reading of the field, would have discarded
that child's best move.

Whyzr workaround: we select on a Laplace-smoothed success rate,
`(success_count + 1) / (usage_count + 2)`, and leave confidence to do the job
it is actually good at, which is flagging a skill below 0.4
(`isSkillFlagged`, reinforcement.js:89). Worth noting the two then disagree
openly, as above, and the framework offers no guidance on which to believe.

Suggested fix: expose a `successRate` helper next to `isSkillFlagged`, so
applications do not each invent their own.

## 15. An application's skill selection is silently overridden

What happens: `formatSkillsForPrompt` (dist/skills.js) injects EVERY
discovered skill into the system prompt with its confidence, and instructs
the model to "ALWAYS scan the skill list below BEFORE taking ANY action"
and pick. `loader.js` then asks the model to report `skill_used`.

Why it matters: an application that does its own selection is not actually
selecting. It can choose skill A while the model uses skill B, and skill A
then gets credited or blamed for skill B's result. Every stored number ends
up attached to the wrong skill, and nothing surfaces the mismatch. This is
the most damaging item in this list precisely because it fails silently and
the data still looks plausible.

The escape hatch exists but is undocumented: `manifest.skills` in agent.yaml
filters discovery to exactly the listed names (loader.js:193-197). Measured
in Whyzr with `loadAgent`: without it, all five of our rival skills reach the
prompt; with it, exactly one does.

A second undocumented consequence, which cost us a bug: because the filter is
exact, always-on skills disappear unless they are listed too. Filtering to
just the chosen skill silently removed our session wrap-up skill, and the
wrap-up is what writes the journal.

Whyzr workaround: we rewrite `manifest.skills` per session to the chosen
skill plus the always-on ones.

Suggested fix: document `manifest.skills` as the selection mechanism, and
either honour a caller-supplied choice in `query()` or state clearly in the
docs that the model, not the application, picks.

## 16. Success and failure are self-reported by the model

What happens: `task_tracker end` takes the outcome as a parameter, and the
model is the one calling it.

Why it matters: with no external signal, the reinforcement system measures
the model's opinion of its own work. In our data before we added an
independent judge, every recorded outcome was `success`, and 8 of 13 tasks
were never closed at all, so they produced no signal in either direction.

Whyzr workaround: a separate judge, in a different model family, returns the
verdict; the application calls `adjustConfidence` with it.

Suggested fix: say prominently in the docs that reinforcement is only as good
as the signal, and that supplying an external one is the application's job.

## 17. A partial costs 0.05 of confidence but a full point of failure

What happens: the `partial` branch (reinforcement.js:33-35) subtracts 0.05
from confidence, a near miss, and then runs `failure_count++`, a total loss,
identically to the `failure` branch.

Why it matters: two different notions of "did not work" coexist in one
record, undocumented. Any application computing a success rate from the
counts treats near misses as complete failures, while the confidence number
treats them as almost fine. The two disagree and neither is wrong on its own
terms.

(We initially believed a partial incremented neither counter, and that
`success_count + failure_count` therefore drifted from `usage_count`. We
checked the source before sending this, and that is not what ships. The
counts do reconcile. The real issue is the one above.)

Whyzr workaround: we removed partial from our verdict set entirely. Three
states: success, failure, not gradeable. `adjustConfidence` is never called
with a partial, and our code throws if anything tries.

Suggested fix: make the confidence penalty and the counter agree, or document
that partial is a failure that hurts less.

## 18. Crystallization only ever learns from wins

What happens: `skill_learner crystallize` throws on any non-success outcome,
and its own description is "Learn from successful tasks".

Why it matters: a library that only grows from successes cannot generate a
competing approach to a job it already does adequately. It extends a library,
it does not bootstrap one, and it can never produce the rival that would make
a confidence comparison meaningful. Day one still needs hand-written skills,
which is worth saying in the docs so nobody plans around it.

Whyzr workaround: we hand-wrote five deliberately substitutable skills so
there is something to compare.

Suggested fix: state the constraint in the skills documentation.

## 19. Cherry-picking a skill between branches conflicts on the evidence

What happens: cherry-picking a skill improvement from one agent branch to
another conflicts on the frontmatter. Reproduced: the prose improvement
auto-merges cleanly and the conflict lands exactly on the `confidence` and
`usage_count` lines.

Why it matters: this is correct, and we think it is a feature worth
advertising rather than a rough edge. The skill travels between agents, the
evidence does not, because that evidence was earned with a different user.
But it is undocumented, and it is the first thing anyone running multi-branch
agents will hit, at which point it looks like a bug.

Whyzr handling: none needed. We rely on it.

Suggested fix: document it, and mention stripping stats when promoting a
skill from one agent to a shared parent.

## 20. The reinforcement primitives are not reachable from the public API

What happens: `package.json` exports only `.` and `./cli`. The main entry
re-exports `discoverSkills` but not `adjustConfidence`, `loadSkillStats` or
`saveSkillStats`.

Why it matters: item 16 says supplying an external signal is the
application's job, but the functions needed to apply that signal cannot be
imported. `import ... from "@open-gitagent/gitagent/dist/learning/reinforcement.js"`
fails with ERR_PACKAGE_PATH_NOT_EXPORTED. That leaves two options: resolve a
path into `dist/` and hope it survives the next release, or reimplement the
confidence math and let it drift out of sync with the framework's.

Whyzr workaround: we resolve the `dist/` path explicitly, so at least the
numbers stay the framework's own.

Suggested fix: export the reinforcement primitives from the package entry.
They are the documented extension point.

## 21. SECURITY: the memory and skill_learner tools shell-inject on a model-chosen string

What happens: the memory tool commits with

    execSync(`git add "${memoryPath}" && git commit -m "${commitMsg.replace(/"/g, '\"')}"`)

(dist/tools/memory.js:120). Only the double quote is escaped. `$(...)`,
backticks, `;` and `&&` pass through untouched, and `commitMsg` is chosen by
the model. The same pattern is at skill-learner.js:78 and :341.

Reproduced: a save with the message `journal: puddles $(touch PROOF.txt)`
created the file, and the resulting commit subject reads `journal: puddles`,
so the log looks entirely normal afterwards.

Why it matters: it is arbitrary command execution in the host process, with
that process's environment, reached through a tool most applications
allow-list precisely because it looks harmless. Any prompt injection that
influences a commit message becomes code execution. For an agent handling
untrusted input, and especially for one built for children, this is the
difference between a sandbox and the appearance of one. Note that a hook
cannot save you by default: a `pre_tool_use` hook that allow-lists `memory`
never inspects the message.

Whyzr workaround: our guard hook now inspects the arguments of these tools
and refuses shell metacharacters, rather than trusting the tool name.

Suggested fix: pass arguments as an array with `execFile`, never build a
shell string. `git commit -m` takes the message as a single argv entry, so
no escaping is needed at all.

## 22. Skills are mandatory in the prompt and optional in practice

What happens: `formatSkillsForPrompt` puts only a skill's NAME and
DESCRIPTION in the system prompt, never its body, and instructs the model:
"If a skill's description matches or partially matches the task, you MUST
load its full instructions using the `read` tool ... Follow the loaded skill
instructions EXACTLY", under a heading marked FIRST PRIORITY (MANDATORY).

Measured: across six scripted tutoring sessions with a skill whose
description reads "How to build question ladders and escalate hints without
ever giving the answer. Check this before tutoring on any topic", the model
read that skill in **3 of 6 sessions**. Every session was a tutoring
session. The description could not have matched more squarely.

Why it matters, and this is the part that bit us. The split between an
always-present system prompt and a read-on-demand skill body is a real
architectural boundary, but nothing in the framework surfaces it. So the
natural reading, "put technique in skills, that is what skills are for", is
correct by design and unreliable in practice: an instruction placed in a
skill body is applied about half the time, and which half is invisible.

We hit this from both sides in one afternoon. Technique kept in the
constitution made the constitution unreadable to the parents who own it.
Technique moved into the skill made a specific safety behaviour depend on a
coin flip: the rule that stops the tutor answering "what is 7 times 8" now
lives in a skill body, and in the run that passed, the model had not read
it.

Whyzr workaround: safety-critical wording stays in RULES.md or SOUL.md,
which are verbatim in the prompt. Only depth that can afford to be missed
lives in the skill body. We also added an eval that records, per session,
which skills were actually read, because the alternative is assuming.

Suggested fix, any one of which would help:
- Document the boundary prominently: a skill body is not in the prompt, and
  loading it is the model's choice.
- Offer an `always_load: true` frontmatter flag for skills whose content
  must be present every turn.
- Report skill loads in the session record, so an application can see when
  a skill it depends on was skipped rather than inferring it from behaviour.
