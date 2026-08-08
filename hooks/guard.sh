# pre_tool_use guard. gitagent runs this with sh, cwd = agent dir, and pipes
# the hook context JSON on stdin. The real policy lives in guard.mjs (node is
# guaranteed present: gitagent itself runs on node). Keep this wrapper dumb.
#
# NOTE: gitagent treats a hook that crashes as "allow" (fail-open), so
# guard.mjs is written to never crash and to BLOCK when input is unparseable.
exec node hooks/guard.mjs
