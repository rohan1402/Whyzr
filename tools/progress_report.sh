# progress_report: parent-facing summary built from the growth journal
# (memory/MEMORY.md) and its git history. Receives JSON args on stdin,
# prints the report to stdout. Run by gitagent with cwd = agent dir.

ENTRIES=$(node -e '
let d = "";
process.stdin.on("data", c => d += c).on("end", () => {
  try { const n = Number(JSON.parse(d).entries); console.log(Number.isFinite(n) && n > 0 ? Math.floor(n) : 3); }
  catch { console.log(3); }
});
')

JOURNAL="memory/MEMORY.md"
[ -f "$JOURNAL" ] || { echo "No growth journal yet. After the first session, entries will appear here."; exit 0; }

TOTAL=$(grep -c '^## ' "$JOURNAL" 2>/dev/null || echo 0)

echo "# whyAI progress report"
echo
echo "Journal sessions recorded: $TOTAL"
echo

echo "## Journal history (git)"
git log --oneline --date=short --pretty=format:'- %ad  %s' -- "$JOURNAL" 2>/dev/null | head -15
echo
echo

if [ "$TOTAL" -gt 0 ]; then
  echo "## Thinking moves observed"
  grep -h '^\*\*Thinking moves used:\*\*' "$JOURNAL" \
    | sed 's/^\*\*Thinking moves used:\*\* //; s/\.$//' \
    | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' \
    | sort | uniq -c | sort -rn | sed 's/^ *\([0-9]*\) \(.*\)/- \2 (x\1)/'
  echo

  echo "## Open sparks (mysteries the child wants to chase)"
  grep -h '^\*\*Sparks for next time:\*\*' "$JOURNAL" | sed 's/^\*\*Sparks for next time:\*\* /- /' | tail -5
  echo

  echo "## Most recent entries"
  node -e '
const fs = require("fs");
const n = Number(process.argv[1]) || 3;
const txt = fs.readFileSync("memory/MEMORY.md", "utf8");
const parts = txt.split(/\n(?=## )/).filter(s => s.startsWith("## "));
console.log(parts.slice(-n).join("\n"));
' "$ENTRIES"
fi
