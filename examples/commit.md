---
description: Commit current changes with jj
argument-hint: "[headline]"
execution: subagent
effort: none
---
Commit all changes using jj.

Run `jj diff --git` to see what changed. Write a concise commit message:

- If headline provided ($@), use it as the first line.
- List the changed files or logical groups of changes.
- Keep it brief — don't analyze or explain the changes in depth.

Run: `jj commit -m $'<description>'`
`jj commit` will report the working copy as `(empty) (no description set)` — this is normal jj behavior (not an error). The task is done. Do not verify the result, run follow-up commands, or announce anything.
