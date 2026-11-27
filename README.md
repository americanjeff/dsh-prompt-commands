[![npm version](https://img.shields.io/npm/v/dsh-prompt-commands)](https://www.npmjs.com/package/dsh-prompt-commands)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

# <img src="assets/icon-inline.svg" height="24" alt="dsh-prompt-commands icon"> dsh-prompt-commands

pi-style prompt templates for dsh: markdown templates **registered as slash
commands** — one command per template file, named after the file. New, edited,
and deleted templates take effect in existing sessions without a restart. Any
template pi accepts (`.pi/prompts/*.md` format) loads unchanged.

Changelog: [CHANGELOG.md](CHANGELOG.md) · [Releases](https://github.com/americanjeff/dsh-prompt-commands/releases)

## Install

```sh
dsh --profile <name> plugin add dsh-prompt-commands
```

Row config (all optional) is edited on the plugin's **settings card** —
dsh's Settings → the plugin's bundle page: extra template directories, the
subagent route (provider, model, max tokens, effort), and the plugin copy
language. Every field commits live: a save applies without a restart
(`promptDirs` re-syncs the watch roots; the route and language are read at
the next invocation). Equivalently, the entry's `config:` block in a profile
patch layer takes the same flat keys — `promptDirs`, `subagentProvider`,
`subagentModel`, `subagentMaxTokens`, `subagentEffort`, `lang` (the schema:
lib/config.js).

`lang` sets the language of the plugin's fixed strings — the fallback
command description, the "started" result text, and the subagent notices.
Template content is yours and unaffected: write templates in any language.
Upstream error text embedded in those strings (dsh / `yaml` messages) keeps
its original language.

The row title/description shown in dsh's Settings plugin inventory is
localized separately through dsh's first-party convention: `locale/en.json`
and `locale/zh.json` (a `meta.title` / `meta.description` per file), which
follow the browser's locale setting — no row config needed.

## Where templates live

| Root | Applies to |
|---|---|
| `<projectRoot>/.agents/prompts` — projectRoot is the nearest `.git` at or above the session's cwd | that project's sessions only; shadows same-named globals |
| `~/.agents/prompts` (or `$DSH_AGENTS_HOME/prompts`) | all sessions |
| each `config.promptDirs` entry | all sessions |

## Template format

```markdown
---
description: One-line summary shown in the slash popup
argument-hint: "[topic]"
command: <command>                   # run at invocation, stdout folds into the prompt
execution: inline | subagent         # default inline
command-background: true | false     # default false
command-timeout: <ms> | 30s/5m/1h | none   # default 10s
effort: none | low | medium | high   # subagent templates only
---
Template body with placeholders:

- `$1`, `$2`, … — positional arguments (missing = empty string)
- `$@` / `$ARGUMENTS` — all arguments, space-joined
- `${@:N}` — arguments from N onward (1-based, bash-style)
- `${@:N:L}` — L arguments starting at N
- `$OUTPUT` / `${OUTPUT}` — the `command` stdout (only read when `command` is set)
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
  settles. The child's model route is the row config `subagentProvider` /
  `subagentModel` (with `subagentMaxTokens`) when present, otherwise the
  session's route.

### `command`

Run a command when the template is invoked and fold its stdout into the
expanded prompt (in addition to the body). The value is an executable plus
optional fixed arguments, split bash-style — it runs the command with the
provided arguments, spawned without a shell in the session's cwd. The body's
argument placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`) work in the
command string too: when any is present, the arguments are substituted there
instead of appended.

- Command output is combined with the prompt body by replacing each
  `$OUTPUT` / `${OUTPUT}` occurrence. If there is no such occurrence the
  output is appended to the body.
- Failure or timeout: the invocation returns an error carrying the child's
  stderr and nothing is delivered to the session.
- `command-timeout:` bounds the run — the default is 10 seconds; give a
  millisecond number, a duration (`30s`, `5m`, `1h`), or `none` to let the
  command run until it exits or the invocation is aborted.
- `command-background: true` runs the command as a session-owned background
  without giving the agent a turn. When the command completes the resulting
  prompt is delivered as the next user message.

### `effort`

Coarse reasoning effort for `execution: subagent` templates: `none`, `low`,
`medium`, or `high`. At spawn the level maps onto one concrete rung of the
child route's advertised effort ladder — `none` → the rung that switches
reasoning off (when the route advertises one; otherwise the lowest rung),
`low` → lowest rung, `medium` → middle rung, `high` → highest rung. Routes
expose different ladders (`off·low·medium·xhigh`, `low·high`, …), so
templates never name a concrete id — on a route whose top rung is `xhigh`,
`effort: high` spawns at `xhigh`, and `effort: none` on a route whose off
rung is `off` spawns at `off`.

- **Precedence**: template frontmatter `effort` > row config
  `subagentEffort` > no effort (the child runs its route's default).
- **Route**: the ladder is read from the child's actual route — the config
  `subagentProvider`/`subagentModel` route when both are present, otherwise
  the session's
  current route.
- **Degrades safely**: a route that cannot be resolved drops the effort with
  a logged warning; the child still runs, at its route default. A `none` on a
  route without an off rung takes the lowest reasoning rung — the spawn
  confirmation always reports the rung the child actually runs at.
- **Inert on `inline` templates**: a session's reasoning effort is durable
  state (its request header), not a per-turn dial — dsh has no temporary
  session-side effort switch — so an `inline` template that declares `effort`
  logs a warning and runs at the session's effort.

## Example prompts

 - [`/crit`](./examples/crit.md) review the files or changes with [Crit](https://github.com/tomasz-tomczyk/crit).
 - [`/init`](./examples/init.md) init current directory with [jj](https://github.com/jj-vcs/jj).
 - [`/commit`](./examples/commit.md) commit the working copy.

## Tests

```sh
pnpm install
pnpm test                # node --test
python3 e2e/e2e-web.py   # live e2e against a scratch web profile (optional)
```
