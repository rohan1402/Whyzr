# Feedback for the gitagent team

Everything below was found while building whyAI, by using gitagent as the
load-bearing chassis: CLI, SDK, hooks, memory, declarative tools, branches,
and the voice package. Versions tested: @open-gitagent/gitagent 2.0.2,
@open-gitagent/voice 1.0.0, Node 24 on macOS. Each item lists what happens,
why it matters, how whyAI works around it, and a suggested fix. Items 1 to 5
are the CLI and runtime, 6 to 7 are the SDK, 8 to 11 are the voice package.

## 1. Any invocation scaffolds and auto-commits in the current directory

What happens: running `gitagent` anywhere immediately scaffolds an agent in
the cwd, and if the working tree is dirty it commits everything with the
generic message "Scaffold gitagent agent".

Why it matters: user changes get swallowed into anonymous commits. It
happened to us twice; we rebuilt those commits by hand to keep a reviewable
history. In a git-native tool, the history is a feature, and this behavior
damages it.

whyAI workaround: we commit our own work before every gitagent invocation,
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

whyAI workaround: we created .gitignore with `.gitagent/` before the first
run. It is the first commit in our history.

Suggested fix: always write or update .gitignore during scaffold.

## 3. `gitagent plugin init <name>` crashes

What happens: the scaffold is created, then it throws
`pluginsNode.set is not a function` while updating agent.yaml (v2.0.2).

whyAI workaround: we avoid plugins entirely.

Suggested fix: likely a YAML node API mismatch in the agent.yaml update path.

## 4. Hooks fail open

What happens: if a pre_tool_use hook script crashes, times out, or exits
nonzero, runHooks logs the error and allows the tool call.

Why it matters: pre_tool_use is where safety enforcement lives. A safety
hook that fails open is a safety hook that can be disabled by any bug in the
hook itself. For whyAI the hook IS the child-safety layer.

whyAI workaround: hooks/guard.sh delegates to a node script written to never
crash, and it blocks (not allows) when input is unparseable.

Suggested fix: make failure behavior configurable per hook, with fail-closed
as the recommended default for pre_tool_use.

## 5. The agent.yaml tools list is not fully respected

What happens: `capture_photo` loads and appears in the system prompt even
though it is not in our agent.yaml `tools` list.

Why it matters: an agent author who removes a tool expects it gone. A camera
tool appearing uninvited in a children's product is exactly the kind of
surprise that erodes trust.

whyAI workaround: the guard hook is deny-by-default, so unlisted tools are
blocked at execution time regardless of what loads.

Suggested fix: honor the tools list strictly, or document which tools are
always on.

## 6. SDK: multi-turn AsyncIterable prompts end the public stream after turn one

What happens: with `query({prompt: asyncIterable})`, the agent_end event
fires after every completed prompt and its handler calls channel.finish().
The internal turn loop keeps running, but the public `for await (const m of
q)` stream ends after the first turn. Consumers silently see one turn of a
multi-turn conversation.

whyAI workaround: drain the short-lived stream, then poll `q.messages()`
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

whyAI handling: we do not ship the voice cockpit. Our own kid UI binds to
127.0.0.1, serves exactly one HTML file, and has no file API at all.

Suggested fix: deny dotfiles and an explicit denylist (.env, .git) in the
file API, and make auth opt-out rather than opt-in.

## 9. Voice package: text-only mode never displays the agent's reply

What happens: without a voice adapter key, text chat reaches the agent
correctly (the reply is present in /api/chat/history), but the web UI never
renders the assistant message, live or after reload.

Why it matters: text-only is the advertised fallback ("Text chat works
normally"), and it looks completely broken to a user.

whyAI handling: we verified the agent side works via the history API, then
built our own interface.

## 10. Voice package: side channels replace the agent's system prompt

What happens: the Telegram bridge calls query() with its own generic
`systemPrompt` ("You are an AI assistant responding to a Telegram user..."),
which replaces the agent's SOUL and persona assembly for those turns.

Why it matters: an agent's identity and prompt-level rules silently vanish
on that channel. For whyAI, the tutor would stop being a tutor on Telegram.
Code-level enforcement (hooks) still applies, which is why we enforce safety
in code, but the persona layer is gone.

whyAI handling: we do not enable any side channels.

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

whyAI handling: our kid UI keeps Claude as the only model. The browser does
speech-to-text and text-to-speech; every utterance round-trips through the
governed agent.

Suggested fix: offer a relay mode where the realtime model is restricted to
transcription and speech, and all conversational content comes from the
gitagent.
