# Where Whyzr stands, and what is next

Written at the end of the Stage 1 rebuild. Read this first when picking the
project back up.

## Done and verified

Stage 1a and 1b are complete, plus six fixes from an adversarial review:

- Children are git branches (`child-<id>`) checked out as worktrees off a
  remote-stripped agent repo on the data volume. The source repo keeps its
  origin and has zero child branches.
- Age is a prompt parameter (`server/age.mjs`), not a branch. The `age-5`
  and `age-12` branches are deleted and SOUL.md is age-neutral.
- Five reasoning moves live in `skills/` with confidence frontmatter.
- The app commits skill stats itself, because gitagent's `saveSkillStats`
  is a bare `writeFile` and never commits. Without this, learning is
  invisible to `git diff` and is destroyed when a worktree is rebuilt.
- `repos.mjs` (clone-per-kid) is deleted; everything is on `worktrees.mjs`.
- 41/41 layer-1 machinery checks pass, including 9 new `stage1:` checks.

## Open, in the order worth doing

### 1. `syncTemplate()` has never worked. Production bug.

`git fetch <path> main:main` is refused by git because the agent repo has
`main` checked out. The `catch` in `server/worktrees.mjs` swallows it. The
consequence is that no redeploy ever delivers a new reasoning move, a
RULES.md amendment, or a bug fix to any existing child: the agent repo is
frozen at whatever commit it was first cloned at.

Proven fix: clone the agent repo **bare** (`git clone --bare`). Worktrees
work fine off a bare repo, and the fetch then succeeds. Verified in a
scratch dir: a new move reached a new child while an existing child's
committed confidence and clean worktree were untouched.

Delete `.whyzr-data/agent-repo` after the change so it is rebuilt bare.

### 2. README states things that are no longer true

Lyzr reviewers read this first, and one passage contradicts another:

- line ~103: "full git clone of this repo" and "age selecting the persona
  branch". Both were deleted by Stage 1.
- line ~187: "34 of 34 checks" (now 41/41) and "branch checkout swaps the
  persona", which the suite now asserts the opposite of.
- `Dockerfile:24` still says the image must contain "the age branches".
- `DEPLOY.md:3` still says the app "clones a kid repo".

### 3. Stage 1c: the learning loop is not connected

Nothing in the project reads or writes a confidence number, so
`git diff child-a child-b -- skills/` returns empty in real use. The
`.gitagent/learning/tasks.json` on this machine shows the five moves have
never been selected once; only `socratic-method` appears, and it carries
no confidence field so it competes without keeping score.

This is Stage 1c/1d in WHYZR-HANDOFF-3 section 6 (move selection via
`manifest.skills`, then the judge agent). Not started by instruction.

### 4. `maxKids` defaults to 1

So the two-child demo the README tells the reader to run cannot run on
shipped defaults. Raise it, or document the override.

### 5. `withChildLock` is never called by the server

Only the evals call it. Same-process races are covered by the promise
chain in `sessions.mjs`, but deploy overlap is real: shutdown grace is
105s, during which the old instance is still committing wrap-ups while the
new one accepts traffic on the same volume. `saveRules`/`restoreRules` also
commit off the session queue.

Also: `commitLearning` in `worktrees.mjs` is exported and never called.
`commitSession` is what runs. Delete it or wire it.

## Framework finding worth reporting upstream

gitagent's `memory` tool builds a shell string from a model-chosen commit
message and runs it through `execSync`, escaping only double quotes:

    dist/tools/memory.js:120
    execSync(`git add "${p}" && git commit -m "${msg.replace(/"/g,'\\"')}"`)

`$(...)` and backticks execute. Confirmed locally: a commit message of
`journal: puddles $(touch PROOF.txt)` created the file, and the commit
subject still read `journal: puddles`. Same pattern at
`skill-learner.js:78` and `:341`.

`hooks/guard.mjs` allow-lists `memory`, `task_tracker` and `skill_learner`
unconditionally, so the guard never inspects these arguments.

This belongs in FEEDBACK.md, which is part of the submission. It is a real
vulnerability in the framework, found by using it properly.

## Removed deliberately

A name-redaction module (`server/pseudonymity.mjs`) was built and then
removed as out of scope. Structural pseudonymity is unchanged: random
child ids, and no names in branches, paths, or any commit message the app
writes. RULES.md still instructs the tutor to write the journal
pseudonymously.
