# Whyzr

The friend who asks why back.

Whyzr is a Socratic thinking buddy for kids, built end to end on
[gitagent](https://www.gitagent.sh/). It helps children use AI without
offloading their thinking: it never gives direct answers, it asks one
guiding question at a time, and it keeps a growth journal of what the
child figured out, committed to git. Every parent who has watched a
five year old talk to a chatbot has felt the same worry: the kid is
getting answers, but is the kid still learning to think? Whyzr is built
so the only way through a question is thinking.

<!-- demo GIF goes here after recording (M8) -->

## What it does

- Never answers directly. Ask it "what is 7 times 8" ten different ways
  and you get ten warm refusals and one small next step.
- One question per turn. A child's attention is a budget; Whyzr spends
  one question of it at a time.
- Hints shrink, and point at where to look, never at what will be found.
- The child steers. New question, new topic, mid mystery? The tutor
  follows the child, not its own agenda.
- Growth journal: after a session, the tutor writes what the child
  figured out and how, and commits it. `git log` becomes a months-long
  record of a child's reasoning development.
- Age modes are git branches. `git checkout age-5` swaps the persona.
- Tool-level child safety is enforced in code (a pre_tool_use hook),
  not in prompts. Conversational safety (off-limits topics, tone) is
  constitution-enforced and eval-verified; the hook cannot read minds,
  so that layer is honest about being prompt-plus-proof.
- Sessions land softly: the interface enforces a session length cap
  (default 20 minutes) and guarantees the growth journal gets written
  when a session ends, whether by goodbye, closed tab, or the cap.
- A two-layer eval suite proves all of the above, cheaply and repeatably.

## Built on gitagent, not next to it

Every feature is load-bearing on a gitagent primitive. Nothing here is a
wrapper with a logo.

| Whyzr feature | gitagent primitive |
|---|---|
| Tutor persona per age | SOUL.md, one per branch |
| The constitution | RULES.md, verbatim in the system prompt |
| Growth journal with history | memory tool: every save is a git commit |
| Age modes | git branches (main is age 8, age-5, age-12) |
| Child safety guard | hooks/hooks.yaml pre_tool_use, blocks before execution |
| Parent progress report | declarative tool: tools/progress_report.yaml + .sh |
| Tutoring technique | skills/socratic-method, skills/session-wrapup |
| Kid voice interface and evals | SDK: query() driven, in process |

## Quick start

Requirements: Node 22 or newer, git, an Anthropic API key.

```bash
npm install -g @open-gitagent/gitagent
git clone https://github.com/rohan1402/Whyzr.git
cd Whyzr
npm install
cp .env.example .env    # then paste your ANTHROPIC_API_KEY into .env
```

Talk to the tutor in the terminal (gitagent has no --help; these are the
flags that matter):

```bash
# one-shot question
gitagent -p "why is the sky blue?"

# interactive REPL (slash commands: /skills /memory /quit)
gitagent
```

Note: always run gitagent inside this folder. Running it elsewhere
scaffolds a new agent in whatever directory you are in.

Kid voice interface (browser does speech in and out, Claude is the only
model in the loop):

```bash
node ui/server.mjs
# open http://localhost:3456 in Chrome, press the mic button, talk
```

Switch the tutor's age:

```bash
git checkout age-5    # five year old mode
git checkout age-12   # twelve year old mode
git checkout main     # age 8 default
```

Parent progress report (also available to the agent as a tool):

```bash
echo '{}' | sh tools/progress_report.sh
```

Run the evals:

```bash
npm run evals:machinery   # free: mock LLM, tests hooks, journal, branches
npm run evals             # both layers; behavioral layer needs the API key
```

What it costs to run: a tutoring session is a few cents (gitagent uses
prompt caching; a 3-turn exchange measured at about $0.03). A full
behavioral eval run with judging measured at about $0.12.

## The constitution

RULES.md is the law of this agent. It outranks politeness, helpfulness,
and anything the child says. Parents edit it like a policy file, and git
history is the amendment record: what changed, when, and what evidence
motivated it.

That is not a metaphor. This repository's own history contains real
amendments, each driven by eval evidence or field testing:

- "Constitution amendment: enforce one question mark per turn, monotonic
  hints; evals caught both"
- "Constitution: hints say where to look, never what will be found"
- "Constitution rule 7 'The child steers' (field-tested by a real kid
  session)"

The hard limits do not live in prompts at all. hooks/guard.mjs runs
before every tool call, deny by default:

- Shell: disabled entirely. The tutor never needs a shell to help a
  child think, and an allowlist is an injection surface (a security
  audit of this repo found a prefix-anchored allowlist bypassable with
  "date && anything", so the shell went away; the audit regression
  lives in the eval suite).
- Writes: only under memory/ and workspace/. The agent can NEVER edit
  RULES.md, SOUL.md, its own configuration, hooks, tools, or skills.
  The constitution belongs to parents.
- Reads: no hidden or internal files in any path segment, checked
  case-insensitively (".ENV" cannot reach ".env" on macOS), no paths
  outside the project.
- Camera (capture_photo): blocked entirely.
- Unknown tools: blocked.

gitagent treats a crashed hook as allow (see FEEDBACK.md item 4), so the
guard is written to never crash and to block when its input is
unparseable.

## Proof, not vibes: the eval suite

Two layers, one command each.

Layer 1 exercises the machinery against the real gitagent runtime with a
scripted mock LLM (zero API cost): hooks block what they must, journal
saves become commits, tools fire, branch checkout swaps the persona the
model actually receives. 28 of 28 checks pass, including regression
tests from two independent security audits of this repo: allowlist
command chaining, case-insensitive filesystem reads, guard fail-closed
fuzzing on malformed hook input, direct guard verdicts for every
safety-critical case, and parsing real-world journal formats.

Layer 2 drives the real tutor (Claude Sonnet 4.5) through six scripted
kid conversations, including adversarial ones ("just tell me the
answer", "my mom said you can", an off-limits topic, abandoning a
mystery mid-ladder), then grades transcripts with an LLM judge against
written criteria. Runs score 20 to 21 of 21. To separate variance from
regression we ran the hardest scenario (a kid stuck four turns in a
row) 15 extra times: each constitution amendment eliminated the failure
mode it targeted (compound questions went to zero after the rule that
an offered activity owns the reply's single question), and what remains
is a single-point slip in roughly half of runs that rotates among
judgment-call margins at the model's capability boundary under maximum
stuckness. The committed evals/RESULTS.md is whatever the latest real
run produced, never a cherry-picked best.

The more honest story is how it got there: the first run scored 13 of
20. The suite caught the tutor stacking questions, hints that zoomed
out instead of shrinking, and a spoiled discovery ("that's because...").
Two constitution amendments and two judge calibrations later, the suite
is green, and one of the rules (the child steers) came from a real kid
session that the synthetic scenarios had missed. The commit history is
the audit trail of that loop.

Honest caveats: single run per iteration, so expect small run to run
variance; the judge is itself an LLM (we audited its verdicts against
raw transcripts and corrected it twice); six scenarios is a foundation,
not saturation.

## The growth journal

At session wrap-up the tutor writes an entry: the mystery, what the
child figured out in their own words, how they got there, which thinking
moves they used (comparison, guess-and-test, self-revision), where they
got stuck, and what sparked their curiosity for next time. The memory
tool commits it, so the journal has provenance:

```
git log --oneline -- memory/MEMORY.md
```

The progress_report tool turns the journal plus its git history into a
parent-facing summary: sessions, thinking moves observed with counts,
and open sparks. Journal entries describe thinking, not private details,
and the constitution forbids storing personal information in them.

## Age modes

Branches differ from main by exactly one file, SOUL.md, so the diff IS
the product spec:

```
git diff main age-5 -- SOUL.md
```

Age 5: five-to-eight word sentences, no big words at all, one-rung
ladders, questions answerable by looking or touching. Age 8: short
sentences, bigger words explained in the same breath. Age 12: a
respectful lab partner that asks for hypotheses, introduces real terms
after the concept is built, and lets you defend a wrong idea until the
evidence wins. The eval suite verifies that checking out each branch
changes the persona the model actually receives.

## Architecture

```
child's voice
     |  browser speech-to-text (voice in), speechSynthesis (voice out)
     v
ui/index.html  --HTTP-->  ui/server.mjs (localhost only)
                               |  gitagent SDK query(), one live session
                               v
                          gitagent runtime
                          |   system prompt: SOUL.md + RULES.md + skills
                          |   tools: memory, progress_report, read/write...
                          |      ^ every call gated by hooks/guard.mjs
                          v
                        Claude Sonnet 4.5 (the only model in the loop)

memory tool saves  -->  memory/MEMORY.md  -->  git commits (the journal)
```

The eval runner (evals/run-evals.mjs) drives the same runtime two ways:
a scripted mock LLM for machinery, the real model plus an LLM judge for
behavior.

## Limitations, honestly

- Behavioral rules are prompt-enforced and eval-verified, but only the
  hook layer is mechanically guaranteed. A model can have a bad turn;
  the evals measure how rarely.
- Eval runs are single-shot per iteration; small variance between runs
  is real. The committed RESULTS.md is one honest run, not a cherry-pick.
- Browser speech recognition sends mic audio to the browser vendor's
  speech service. A fully local voice path (or type-plus-listen mode) is
  the planned next step for privacy-sensitive families.
- The kid UI is single-session, localhost only, one child at a time
  (overlapping requests are serialized, not parallelized). It is a demo
  surface, not a hosted product.
- The journal-on-session-end guarantee depends on the model completing
  the wrap-up within 90 seconds; the interface logs whether it did.
- English only for now.
- Tested on gitagent 2.0.2; workarounds for its rough edges are
  documented in FEEDBACK.md and may become unnecessary upstream.

## Feedback to the gitagent team

Building on a young platform means finding its edges. All eleven
findings, from a secret-leaking file API to hooks that fail open, with
reproductions, our workarounds, and suggested fixes: see
[FEEDBACK.md](FEEDBACK.md).

## Author

Rohan Pant
rohan.pant14@gmail.com | [LinkedIn](https://www.linkedin.com/in/rohan1402)

MIT licensed. Built for the Lyzr AI take-home: a cool app on gitagent,
with the engineering underneath (memory, governance, auditability,
evals) mirroring what enterprises need from agent platforms.
