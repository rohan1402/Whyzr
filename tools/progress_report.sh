# progress_report: thin wrapper; the parser lives in progress_report.mjs
# (node is guaranteed present: gitagent itself runs on node). Args pass
# through on stdin; cwd is the agent dir.
exec node tools/progress_report.mjs
