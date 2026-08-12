# Demo script

Four beats, in this order, roughly six minutes. Each one is something the
previous version of Whyzr could not show.

Record with two windows side by side: a terminal, and a browser on the kid
app. Resist narrating the architecture. Show the thing, then say the one
sentence that explains why it matters.

---

## Setup, before recording

```bash
# The two seeded children, already on their branches
git -C .whyzr-data/agent-repo for-each-ref --format='%(refname:short)' refs/heads/

# A real child for the live beats
MAX_KIDS=2 WHYZR_CODE=<the code> npm start
```

Have the parent dashboard open on a second tab, already past the PIN.

---

## Beat 1: the thesis, in one command (90 seconds)

**Show:**

```bash
git -C .whyzr-data/agent-repo diff child-seed-nova child-seed-pip -- skills/
```

Two children. The same five reasoning moves. Different numbers on every one.

**Say:** "These are two forks of the same agent. Nova reasons from things she
has seen, so `observe-recall` is at 12 of 13 for her. Pip thinks in
analogies, so his branch says the opposite. Nobody wrote that down. It was
measured, one session at a time, and git is the database."

**Do not** skip past the fact that these are seeded. Say it in the same
breath: "These two are fictional children, run through the real loop to have
something to show. The machinery is real, the children are not."

That sentence costs four seconds and buys the rest of the demo its
credibility.

---

## Beat 2: the move travels, the evidence does not (60 seconds)

**Show:** cherry-pick a reasoning move from one child's branch to another.

```bash
cd .whyzr-data/agent-repo
git checkout child-seed-pip
git cherry-pick <a commit from child-seed-nova that improved a move>
```

It conflicts. On the confidence line, specifically.

**Say:** "That conflict is the feature. The improvement to the move should
travel between children. The evidence should not, because it was earned with
a different child. Git refuses to merge one child's track record into
another's, and it refuses in exactly the right place."

Then show the sanctioned direction:

```bash
node scripts/promote-move.mjs --child seed-pip --move analogy-bridge --dry
```

**Say:** "Promoting a move to the shared playbook strips the numbers and
keeps the prose. New children inherit the improvement and none of the
history."

---

## Beat 3: the parent edits the constitution, live (2 minutes)

**Show, in the kid window:** ask a why-question, get a Socratic reply.

**Show, in the parent dashboard:** the Rules tab. Add a line to RULES.md, for
example a topic to steer away from, and save.

**Show:** the History tab. The edit is a commit, with a hash and a diff.

**Show, back in the kid window:** start a new adventure and hit the same
topic. The tutor now behaves differently.

**Say the enterprise translation out loud, because this is the beat that
lands with a company that sells governance:** "Swap the parent for a
compliance officer and the tutor for a claims agent. A non-technical person
changed the rules an AI must follow, it took effect immediately, and there is
a signed, diffable, revertible record of who changed what and when. That is
not a feature I added. That is git, doing what git does."

---

## Beat 4: what the parent actually reads (90 seconds)

**Show:** the "What works" tab. Which moves reach the answer for this child,
in plain language, with the raw counts beside them.

**Show:** the verdict list underneath. Each score movement has the question
that caused it and the judge's one-line reason.

**Say:** "A confidence number a parent cannot interrogate is magic. This is
what it was built from. And it was graded by a different model family that
never saw the conversation, only the question and the child's final answer,
so the tutor is not marking its own homework."

**Close on the honest note.** Show the Limitations section of the README on
screen for three seconds while saying: "Selection finds a move that works for
a child reliably. It does not reliably rank that child's two best moves
against each other, and I can show you the simulation that says why. That
limit is in the README, not buried."

---

## If crystallization fires

`skill_learner crystallize` can write a brand new SKILL.md during a real
session, and the agent committing its own new skill is worth showing if it
happens.

**If it does not fire, do not stage it.** Say it did not fire and that this
is FEEDBACK item 18: it only crystallizes from successes, so it extends a
library and cannot bootstrap one. A framework limitation, honestly reported,
reads better than a demo that quietly cheats.

---

## What not to do

- Do not run the seeding script live. It takes six minutes and shows nothing
  that beat 1 does not.
- Do not show the code. Every beat above is a command or a click.
- Do not claim the seeded numbers are evidence that children learn. They are
  evidence the machinery works.
