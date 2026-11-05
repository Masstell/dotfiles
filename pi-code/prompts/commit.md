---
description: Stage and commit the current changes with a good message
argument-hint: "[extra context for the message]"
---
Commit the current work.

1. Run `git status` and `git diff HEAD` to see what changed. If unrelated changes are mixed together, stop and ask me how to split them.
2. Write the message in this repo's style (check `git log --oneline -15`): a short summary line, imperative mood, prefixed with the area when the log does that (e.g. `pi.sh: ...`). Add a body only when the why isn't obvious, wrapped at about 72 columns.
3. No AI attribution of any kind: no Co-Authored-By trailer, no "generated with" line, no session links.
4. Stage only the files that belong to this change, by name (not `git add -A`), then commit. Do not push.

$@
