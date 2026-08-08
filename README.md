# whyAI

A Socratic tutor for kids, built on [gitagent](https://www.gitagent.sh/).
It helps children use AI without offloading their thinking: it never
gives direct answers, asks one guiding question at a time, and keeps a
growth journal of what the child figured out, committed to git.

Status: under construction. This README will grow with the project.

## Quick start

```bash
npm install -g @open-gitagent/gitagent
cp .env.example .env   # add your ANTHROPIC_API_KEY
cd whyAI               # always run gitagent inside the project folder
gitagent
```

## How it works (gitagent primitives, not prompts)

- SOUL.md is the tutor's persona. Age modes are git branches: checking
  out `age-5` or `age-12` changes the tutor's vocabulary and ladder size.
- RULES.md is the constitution: never answer directly, one question per
  turn, hints only after three stuck turns. Parents edit it like a
  policy file, and git history is the change log.
- memory/MEMORY.md is the growth journal. The agent saves an entry at
  the end of each session via the memory tool, which creates a git
  commit. `git log` becomes a months-long record of the child's
  reasoning development.
- hooks/ enforce child safety in code, not prompts: a pre_tool_use hook
  blocks off-limits tool use before it executes.
- evals/ prove the behavior with scripted scenarios and an LLM judge.

More to come: safety hooks, age branches, eval results, interface.
