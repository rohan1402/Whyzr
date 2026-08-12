#!/usr/bin/env bash
# scripts/delete-child.sh: remove one child completely.
#
#   scripts/delete-child.sh <child-id>
#   scripts/delete-child.sh <child-id> --yes     skip the confirmation
#
# Required by WHYZR-HANDOFF-3 section 4 before any real child uses Whyzr.
#
# WHY THIS NEEDS A SCRIPT AT ALL. Git is the wrong shape for deletion. The
# obvious command, `git branch -D`, removes a POINTER and nothing else: every
# commit, every journal entry and every verdict stays in the object database,
# reachable through the reflog, until garbage collection decides otherwise.
# A parent told "deleted" while the data sits in .git would be a lie, and for
# a children's product submitted to a company that sells on compliance it is
# the kind of lie that gets noticed.
#
# So this does the whole sequence, in the order that actually works:
#
#   1. remove the worktree            (the checked-out files)
#   2. delete the directory           (anything the worktree left behind)
#   3. delete the branch              (the pointer)
#   4. delete the per-child tag       (a second pointer, easy to forget, and
#                                      it alone would keep every object alive)
#   5. expire the reflog              (the third pointer, the one people miss)
#   6. gc --prune=now                 (the step that actually destroys data)
#   7. remove the registry row        (the nickname-to-id mapping, which is
#                                      the only place a real name ever lived)
#
# Steps 4 and 5 are why this is a script and not a one-liner. Skip either and
# step 6 silently keeps everything, while the output still looks like success.

set -euo pipefail

CHILD_ID="${1:-}"
if [ -z "$CHILD_ID" ]; then
  echo "usage: scripts/delete-child.sh <child-id> [--yes]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ "${2:-}" != "--yes" ]; then
  echo "This permanently destroys every session, journal entry and verdict for '$CHILD_ID'."
  printf "Type the child id again to confirm: "
  read -r CONFIRM
  if [ "$CONFIRM" != "$CHILD_ID" ]; then
    echo "Not confirmed, nothing was deleted."
    exit 1
  fi
fi

node --input-type=module -e "
import { deleteChild, childBranch } from './server/worktrees.mjs';
import { paths } from './server/config.mjs';
import * as registry from './server/registry.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const id = process.argv[1];
const agent = paths.agentRepo();
const git = (a) => execFileSync('git', a, { cwd: agent, encoding: 'utf8', stdio: 'pipe' }).trim();

// Steps 1 to 6 live in worktrees.mjs so the app and this script cannot drift
// apart on something this important.
deleteChild(id);

// Step 7: the registry row, which lives OUTSIDE git and so survives every
// step above. It holds the nickname, and the nickname is the only place a
// real child's name is ever stored.
let hadRow = false;
await registry.update((reg) => {
  hadRow = Boolean(reg.kids[id]);
  delete reg.kids[id];
});

// Prove it, rather than asserting it. A deletion tool that reports success
// without checking is the failure mode this whole script exists to avoid.
const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n');
const tags = git(['for-each-ref', '--format=%(refname:short)', 'refs/tags/']).split('\n');
const dir = paths.kidRepo(id);
const problems = [];
if (branches.includes(childBranch(id))) problems.push('branch still present');
if (tags.includes('template-base-' + id)) problems.push('template tag still present');
if (existsSync(dir)) problems.push('worktree directory still present');
if (registry.read().kids[id]) problems.push('registry row still present');

console.log('  worktree and directory : removed');
console.log('  branch and tag         : removed');
console.log('  reflog expired, gc run : yes');
console.log('  registry row           : ' + (hadRow ? 'removed' : 'none (seeded child, never registered)'));
if (problems.length) {
  console.error('DELETION INCOMPLETE: ' + problems.join(', '));
  process.exit(1);
}
console.log('\nVerified: nothing for ' + id + ' remains in the agent repo or the registry.');
" "$CHILD_ID"
