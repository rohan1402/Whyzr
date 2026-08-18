# Submission email

Draft. Rohan's voice, not a press release. Read it once out loud before
sending: if a sentence sounds like marketing, cut it.

**To:** product@lyzr.ai
**Cc:** Siva Surendira, Shreyas Kapale
**Subject:** Whyzr, built on gitagent, plus 22 findings from using it hard

---

Hi Siva, Shreyas,

You asked me to build something cool with gitagent and share it. Here it is.

**Whyzr** is a Socratic tutor for children's "why" questions. It never gives
the answer. It asks the question that gets the child to it, keeps a growth
journal of how they reason, and lets a parent edit the rules the AI must
follow.

Repo: https://github.com/rohan1402/Whyzr

There is no demo video on purpose. It runs locally in about a minute, and
seeing the git history move under your own hands makes the point better
than watching me do it:

```bash
git clone https://github.com/rohan1402/Whyzr.git && cd Whyzr
npm ci
cp .env.example .env      # ANTHROPIC_API_KEY for the tutor,
                          # GOOGLE_API_KEY for the judge (both needed)
npm run dev               # http://localhost:3456
```

Node 24, because npm 10 rejects the lockfile. The parent view is at
/parent behind the PIN you choose at signup.

**The one command worth your time:**

```bash
git -C .whyzr-data/agent-repo diff child-<id-a> child-<id-b> -- skills/
```

(the ids are printed by `git -C .whyzr-data/agent-repo branch`, one per
child you set up)

Two children, one tutor, and the diff is what each of them taught it.
Whyzr keeps five interchangeable reasoning moves (predict first, bridge an
analogy, decompose, observe and recall, flip it) and learns which ones
actually get a specific child to an answer. Each child is a git branch,
checked out as a worktree, so the evidence for one child cannot contaminate
another and there is no isolation code doing it. Git already does that.

Four things I would point at:

**1. The scoring is not the model marking its own homework.** gitagent's
reinforcement takes the outcome from the model itself. So Whyzr adds a
separate judge, in a different model family, which derives an
age-appropriate target answer before any tutoring happens, freezes it, and
then grades blind: it sees the question, the target, and the child's final
answer, never the conversation. The tutor decides *when* a child is done and
calls the judge as a tool. It never learns the verdict, so it cannot learn
to steer toward an easier one.

**2. A parent editing RULES.md is an audit trail, for free.** They change a
rule in a browser, it commits, and the tutor's next reply obeys it. Swap the
parent for a compliance officer and the tutor for a claims agent and that is
the governance story your customers ask for, except nobody built it. It is
git.

**3. A real child used it.** My own, not a scripted transcript. That is the
one thing the repo cannot show you, and it is where several of the sharper
rules came from: a tutor that lectures instead of asking, a give-up button
that promised an answer and then refused to give one, a session that hung
up on a child mid-thought.

**4. I have been honest about what does not work.** The README carries the
limits with numbers attached: selection finds *a* move that works for a
child reliably, but does not reliably rank that child's two best moves
against each other, and there is a simulation in there saying why. An early
result did not replicate when I re-ran it, so both runs are published. The
seeded numbers are labelled as seeded in the README, because they
demonstrate the machinery and are not evidence that children learn.

**FEEDBACK.md is the part I would actually read first.** 22 findings from
building on gitagent 2.0.2, each with what happens, why it matters, our
workaround, and a suggested fix. The ones I would prioritise:

- **Item 21, security.** The `memory` and `skill_learner` tools build a shell
  command from a model-chosen commit message and run it through `execSync`,
  escaping only the double quote. A commit message containing `$(...)` is
  arbitrary command execution in the host process. I reproduced it: the
  payload ran and the commit subject still looked normal afterwards. Any
  agent handling untrusted input is exposed, and a `pre_tool_use` hook that
  allow-lists `memory` by name never inspects the argument. One-line fix:
  `execFile` with an argv array instead of building a string.
- **Item 12.** `saveSkillStats` writes but never commits, in a framework
  whose whole pitch is git. Learning sits as an uncommitted working-tree
  change, so `git diff agent-a agent-b -- skills/` returns nothing and a
  worktree rebuild destroys it. The memory tool already commits; skills
  could too, and then the best demo gitagent has works out of the box.
- **Item 15.** `formatSkillsForPrompt` injects every skill and tells the
  model to pick, so an application doing its own selection is silently
  overridden and its confidence data ends up attached to the wrong skill.
  `manifest.skills` is the fix and is undocumented.
- **Item 20.** `adjustConfidence` and friends are not exported from the
  package entry, so an application supplying the external signal the
  framework asks for has to reach into `dist/`.
- **Item 22, the one that cost me the most time.** Skills are marked FIRST
  PRIORITY (MANDATORY) and the model is told it MUST read a matching
  skill's body. Measured across six tutoring sessions with a skill
  described "check this before tutoring on any topic", it read it in three.
  Another run: none of six. So a skill body is present about half the time
  and which half is invisible, which is a hard thing to build on. I moved
  safety-critical wording back into the always-present files and added an
  eval that records which skills were actually read.

I built on the framework rather than around it: SOUL.md, RULES.md, the
memory tool, hooks, declarative tools, skills with confidence, branches and
worktrees are all load-bearing. Where I worked around something, FEEDBACK.md
says so and says why.

Happy to walk through any of it, and happier still to talk about the
learning loop, which is the part I would build differently a second time.

Rohan

---

## Before sending, check

- [x] No demo video. The README runs it in a minute, verified from a fresh
      clone of the public repo: npm ci, npm run dev, 89/89 machinery evals.
- [x] Repo is public, `main` only, zero child branches on GitHub.
- [x] `SAVE_TRANSCRIPTS` off by default, no transcripts stored.
- [x] No keys or access codes in any tracked file.
- [ ] Read the email out loud once. If a sentence sounds like marketing,
      cut it.
