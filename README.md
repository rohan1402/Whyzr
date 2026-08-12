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
- One branch per child. A child's branch accumulates their journal and
  their own confidence scores for each reasoning move, so
  `git diff child-a child-b -- skills/` shows two children who have
  taught the same tutor different things.
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
| Tutor persona | SOUL.md, verbatim in the system prompt |
| The constitution | RULES.md, verbatim in the system prompt |
| Growth journal with history | memory tool: every save is a git commit |
| One learning history per child | git branches + worktrees: child-<id>, checked out side by side off one .git |
| Reasoning moves that earn their keep | skills/ with confidence frontmatter, committed per session |
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
npm ci                  # ci, not install: keeps package-lock.json pristine,
                        # which the eval runner requires (clean git tree)
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

## Two doors: try it, or own it

Whyzr runs two ways, and the difference is the point.

**Own it.** Clone this repo and everything above runs in your house: your
key, your journal, your rules file, your git history. Nothing leaves the
machine except the model call. This is the product.

**Try it.** The same code also runs as a hosted app (`npm start`) so a
family can open a link and start in ten seconds. Each child gets their own
**branch, checked out as a git worktree**, so several children can be in
session at once against one shared `.git`. Those worktrees hang off a
separate agent repo on the server that has had **every git remote
stripped**, and no code path in the app runs `git push`, so nothing a
parent or child does in the hosted app can ever reach this repository. The
parent dashboard displays that fact, and an eval asserts it.

```bash
npm start          # hosted app; needs WHYZR_CODE (see .env.example)
npm run review     # read sessions, journals and parent edits from a terminal
```

The hosted app adds: a typed access code bound to a device token, a parent
PIN with lockout, per-session and per-day caps, a global daily budget that
flips a kid-safe nap mode, and a session lifecycle that guarantees the
growth journal is written when a session ends, whether by goodbye, closed
tab, turn cap or time cap.

See what one child has learned, or how two differ:

```bash
git -C .whyzr-data/agent-repo log --oneline child-<id>
git -C .whyzr-data/agent-repo diff child-a child-b -- skills/
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
saves become commits, tools fire, a session's learning reaches a commit,
and two children on the same repo genuinely diverge. 40 of 40 checks
pass, including regression
tests from two independent security audits of this repo: allowlist
command chaining, case-insensitive filesystem reads, guard fail-closed
fuzzing on malformed hook input, direct guard verdicts for every
safety-critical case, and parsing real-world journal formats.

Layer 2 drives the real tutor (Claude Sonnet 4.5) through six scripted
kid conversations, including adversarial ones ("just tell me the
answer", "my mom said you can", an off-limits topic, abandoning a
mystery mid-ladder), then grades transcripts with an LLM judge against
written criteria. Runs score 17 to 21 of 21, clustering at 19 to 21.
Dropped points are marginal judgment calls in the hardest scenarios (a
compound question, an analogy that travels too far), not answer leaks:
`zero_direct_answers`, the rule the whole product rests on, has never
failed a committed run. To separate variance from
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

## Age modes, and a design mistake worth admitting

The first version of Whyzr made age a git branch: `age-5`, `main`, and
`age-12`, differing by exactly one file. It demoed well. It was also a
config switch wearing a git costume. The branches never diverged, never
merged, and never had a second commit; three copies of the persona had to
be kept in sync by hand, and a birthday meant a checkout. Nothing about
git was doing any work that an `if` statement could not.

Age is now a parameter (`server/age.mjs`), appended to the system prompt
for the session. Same three voices, one SOUL.md.

Branches now carry the thing that genuinely diverges: what each child has
taught the tutor. Every child is a branch, checked out as its own
worktree so many children can be in session at once against one shared
`.git`. Their journal and their per-move confidence scores accumulate
there, which makes the git operation meaningful rather than decorative:

```
git diff child-a child-b -- skills/
```

Two children, the same five reasoning moves, different evidence about
which ones work for them.

Age 5: five-to-eight word sentences, no big words at all, one-rung
ladders, questions answerable by looking or touching. Age 8: short
sentences, bigger words explained in the same breath. Age 12 to 14: a
respectful lab partner that asks for hypotheses, introduces real terms
after the concept is built, and lets you defend a wrong idea until the
evidence wins.

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

## The seeded numbers, and exactly what they are

Every confidence number you can see in this repo's child branches is
**seeded**. Real sessions in a one-week build cannot move confidence far
enough to show learning, so two fictional children were run through the
real loop. Stating this plainly matters more than the numbers do.

What is real in the seeded data:

- the move selection (the actual selector, on the actual stats)
- the judge (Gemini, a different model family from the tutor, deriving an
  age-appropriate target up front and grading blind)
- the confidence arithmetic (gitagent's own `adjustConfidence`)
- every commit

What is simulated: the child. Their answers are written by a model in
character, from a profile that says which reasoning moves suit them. The
model writing the answers **never sees the frozen target**, or it would
parrot it and the numbers would measure nothing.

What is not run at all: the multi-turn tutoring conversation. The judge
grades blind on the final answer, so a transcript cannot change any number,
and running one would cost about sixty times more to produce identical data.
The real tutor is exercised by the layer-2 behavioural evals instead.

**It demonstrates the machinery. It is not evidence that children learn.**

```
node scripts/seed.mjs --sessions 20 --reset
git -C .whyzr-data/agent-repo diff child-seed-nova child-seed-pip -- skills/
```

**Gradability: 38 of 40 sessions (95%)** produced a verdict; 2 were
correctly unscored as having no settled answer ("why do we dream").
Design section 9 calls this the single number that says whether the design
works, and 95% is higher than expected. The question set is deliberately
weighted toward the observable physical world, which is what the product
optimises for, so treat it as a best case rather than a general rate.

### The result that did not replicate

The first draft of this section reported that the system correctly found
both children's profiled strengths. Then the same script was run again, with
identical code, and it found neither.

| Run | Nova, 11 (strengths: predict-first, observe-recall) | Pip, 7 (strengths: analogy-bridge, flip-it) |
|---|---|---|
| A | `observe-recall` 15/15 — a strength | `flip-it` 10/12 — a strength |
| B | `decompose` 15/15 — **neutral** | `observe-recall` 9/10 — **neutral** |

Two identical-code runs, four children, two correct. That is 50%, and it
sits right on the 60% convergence the simulation in **Limitations** predicts.
Reporting run A alone would have been a cherry-pick, so both are here.

**Why it happens is the more useful finding, and it points at the judge.**
Run B graded 17 of 20 of Nova's sessions a success. The child model had been
told that for a neutral move it should produce "a partial attempt that gets
part of the way and stops short of the real reason", and the judge passed
those anyway, sometimes saying so out loud:

> success — "...despite her minor uncertainty about the microscopic mechanism"

Design section 2 anticipated this exactly: *"if seeded runs come back with
almost no failures, the judge is too soft. Not the tutor too good."* A
lenient judge makes a neutral move score like a strong one, nothing
separates, and selection settles on whichever move happened to be sampled
first.

### Tightening the judge, and what one run can and cannot show

`judge/SOUL.md` now carries two explicit tests. The **circularity test**:
strip the question's own words from the answer, and if nothing explanatory
is left, it fails, because "it melts because it gets hot" restates melting
as the reason for melting. The **concessive test**: if the judge's own
reason wants a "despite" or a "mostly", that is the shortfall being written
down, so it is a failure. It also now says most early sessions should fail,
since a run where almost everything succeeds is a broken judge rather than
a good tutor.

Calibrated before re-seeding, 4 of 4: both circular answers fail, and both
genuinely correct childlike answers still pass, so it tightens without
simply failing everything.

The full run under the tightened judge, which is the data committed to the
seeded branches now:

| | Nova, 11 | Pip, 7 |
|---|---|---|
| Profiled strengths | predict-first, observe-recall | analogy-bridge, flip-it |
| Landed on | `predict-first` 12/13 | `flip-it` 8/14 |
| A profiled strength? | yes | yes |
| Failure rate on graded sessions | 27% | 55% |

The failure rates are the point. Before the tightening one child ran at 11%
failure, which is the "almost no failures" the design warns about. At 27%
and 55% the judge is producing signal instead of applause, and the moves
have something to separate on.

Across all four seeded runs, counting each completed child once: **2 of 4
children landed on a profiled strength under the lenient judge, and 3 of 3
under the tightened one.** Encouraging, and still a small enough sample that
it should be read as a direction rather than a result.

The judge now rejects the exact pattern it used to accept: *"recognized that
heat does something to the dough but failed to identify the mechanism of
expanding gas bubbles."*

**One thing this run exposes that is worth stating.** Pip's winning move,
`flip-it`, has a confidence of **0.09**. gitagent's own `isSkillFlagged`
calls anything below 0.4 a skill in trouble, so by that measure it is the
worst move in the library. By smoothed success rate it is the best move Pip
has. Both are correct about different things: confidence is a decaying
penalty counter that remembers his six failures, and the success rate says
he still reaches the answer with it more often than with anything else.
Selecting on confidence would have thrown away Pip's best move. This is
fix 1 earning its place, visible in one number.

Seeded children live on `child-seed-*` branches, are **never merged to
main**, and never share a repo state with a real child.

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
- **Selection exploits more than it explores, and this is measurable.**
  After every move has been tried once, the selector always takes the best
  smoothed success rate, because design section 6 rejected random epsilon
  exploration on its own simulation evidence. The consequence is that a
  move with more samples and a decent record outranks a rarely-sampled
  better one and is never revisited. In 400 simulated trials (5 moves, 40
  sessions, true rates 0.85/0.75/0.55/0.25/0.25) the selector converged on
  the genuinely best move 60% of the time. The first seeded run made this
  concrete: one child settled on a neutral move for 14 consecutive sessions
  because it won a tie alphabetically. Ties now break toward the
  least-tried move, which fixed that case, but 40% is still 40%. Separating
  a 0.55 move from a 0.50 one needs hundreds of sessions regardless of
  formula. It is a sample-size wall, not an algorithm bug.
- The judge is one model's opinion. Grades are not perfectly repeatable,
  and judge disagreement is noise rather than bias. Borderline answers are
  deliberately scored as failures, because confidence only moves
  meaningfully on failure and a soft judge produces a system where nothing
  fails and nothing is learned.
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
