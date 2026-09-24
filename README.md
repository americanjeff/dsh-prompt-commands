# dsh-prompt-commands

pi-style prompt templates for dsh: markdown templates **registered as slash
commands** — one command per template file, named after the file. New, edited,
and deleted templates take effect in existing sessions without a restart. Any
template pi accepts (`.pi/prompts/*.md` format) loads unchanged.

Changelog: [CHANGELOG.md](CHANGELOG.md) · [Releases](https://github.com/americanjeff/dsh-prompt-commands/releases)

## Install

```sh
dsh --profile <name> plugin add dsh-prompt-commands
```

Working from a checkout instead: `dsh --profile <name> plugin add link:$PWD`.

Row config (all optional):

```yaml
config:
  promptDirs: [dir, ...]      # extra template dirs (non-recursive, .md files only)
  subagent:                   # defaults for `execution: subagent` templates
    provider: llama-swap      #   route fields left absent inherit the session's route
    model: qwen3.8-27b
    maxTokens: 8192
    effort: high              #   coarse effort default (low | medium | high); see `effort`
```

## Where templates live

| Root | Applies to |
|---|---|
| `<projectRoot>/.agents/prompts` — projectRoot is the nearest `.git` at or above the session's cwd | that project's sessions only; shadows same-named globals |
| `~/.agents/prompts` (or `$DSH_AGENTS_HOME/prompts`) | all sessions |
| each `config.promptDirs` entry | all sessions |

Non-recursive, `.md` files only. Same-named templates across roots: the first
registered holds the command; delete its file and a remaining copy picks the
name up (live, no restart). Bad names, invalid YAML, unknown `execution`
values, and unknown `effort` values are logged and skipped — never fatal.

Templates live under `.agents` (where dsh finds skills), not pi's `.pi`
directories — share files with pi via symlinks or `promptDirs`.

## Template format

```markdown
---
description: One-line summary shown in the slash popup
argument-hint: "[topic]"
execution: inline            # optional: inline (default) | subagent
effort: low                  # optional: low | medium | high — subagent templates only
---
Template body with placeholders:

- `$1`, `$2`, … — positional arguments (missing = empty string)
- `$@` / `$ARGUMENTS` — all arguments, space-joined
- `${@:N}` — arguments from N onward (1-based, bash-style)
- `${@:N:L}` — L arguments starting at N
```

- The **command name is the filename** minus `.md` (lowercase, digits, `_`,
  `-`, starting with a letter).
- With no `description`, the first non-empty body line is used (truncated at
  60 characters).
- Argument values are never re-scanned for placeholders (pi semantics).

### `execution`

- `inline` (default) — the expanded template is sent to the invoking session
  as an ordinary user message; the model answers in that session.
- `subagent` — the expanded template runs in a fresh one-shot subagent. The
  command settles immediately, and a notice reports the outcome when the child
  settles. The child's model route is the row config `subagent` block when
  present, otherwise the session's route.

### `effort`

Coarse reasoning effort for `execution: subagent` templates: `low`, `medium`,
or `high`. At spawn the level maps onto one concrete rung of the child
route's advertised effort ladder — `low` → lowest rung, `medium` → middle
rung, `high` → highest rung, rungs that switch reasoning off (`off`, `none`,
…) excluded. Routes expose different ladders (`off·low·medium·xhigh`,
`low·high`, …), so templates never name a concrete id — on a route whose top
rung is `xhigh`, `effort: high` spawns at `xhigh`.

- **Precedence**: template frontmatter `effort` > row config
  `subagent.effort` > no effort (the child runs its route's default).
- **Route**: the ladder is read from the child's actual route — the config
  `subagent` route when it names provider/model, otherwise the session's
  current route.
- **Degrades safely**: a route that cannot be resolved, or that advertises no
  reasoning rungs, drops the effort with a logged warning; the child still
  runs, at its route default.
- **Inert on `inline` templates**: a session's reasoning effort is durable
  state (its request header), not a per-turn dial — dsh has no temporary
  session-side effort switch — so an `inline` template that declares `effort`
  logs a warning and runs at the session's effort.

## Behavior

`/plan prompt templates` → the command row settles → the template's body with
its arguments substituted becomes the session's next user prompt (`inline`),
or a background subagent task with a result notice (`subagent`).

## Tests

```sh
pnpm install
pnpm test                # node --test
python3 e2e/e2e-web.py   # live e2e against a scratch web profile (optional)
```
