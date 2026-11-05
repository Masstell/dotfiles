---
description: Review uncommitted changes (or a given ref range) for bugs
argument-hint: "[git range or focus]"
---
Review the code changes for real problems. Scope: ${1:-the uncommitted changes (`git diff HEAD`, plus untracked files from `git status`)}.

Read the surrounding code, not just the diff, before judging a change. Look for:
- bugs: wrong logic, off-by-one, unhandled errors or edge cases, broken callers;
- security: injection, secrets in code, unsafe input handling;
- anything that breaks existing behaviour or tests.

Skip style nitpicks and personal preferences. For each finding give `file:line`, what goes wrong and when (a concrete input or situation), and a suggested fix. Order by severity. If you find nothing real, say so plainly: an empty review is a fine result. Do not change any files.
