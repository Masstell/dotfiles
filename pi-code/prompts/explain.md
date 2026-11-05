---
description: Walk through how a file, module or feature works
argument-hint: "<path or feature>"
---
Explain how $@ works, for someone about to change it.

Read the code first (follow imports and callers as far as needed). Then cover:
- what it is for, in two or three sentences;
- the main flow, step by step, with `file:line` references;
- the important data structures or state;
- where it connects to the rest of the codebase (who calls it, what it calls);
- anything surprising: gotchas, hidden assumptions, dead code.

Keep it concrete and skip what is obvious from the names. Do not change any files.
