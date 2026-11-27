/**
 * `command:` frontmatter support: run a template-declared command with the
 * invocation's arguments as trailing argv and fold its stdout into the
 * expanded prompt (see README.md, "command"). Kept out of lib/template.js —
 * that module stays the pure pi port; this one owns the child process.
 *
 * The command string is split with the same bash-style parser as template
 * arguments and spawned WITHOUT a shell, so the invocation arguments are
 * passed as real argv — no quoting or injection surface. No shell features
 * (pipes, redirection, globs) are available.
 *
 * @module dsh-prompt-commands/lib/command
 */

import { spawn } from 'node:child_process'
import { parseCommandArgs, substituteArgs } from './template.js'

/** How long a template command may run before it is killed. */
export const COMMAND_TIMEOUT_MS = 10_000

/**
 * The argument placeholders the template body supports; when the command
 * string references any of them, the arguments are substituted into it and
 * not appended as trailing argv.
 */
const COMMAND_PLACEHOLDER_RE = /\$\d+|\$ARGUMENTS|\$@|\$\{@:\d+(?::\d+)?\}/u

/**
 * Run one template command and return its stdout.
 *
 * @param {string} command - the frontmatter `command` value (executable plus
 *   optional fixed arguments, bash-style quoted). The body's argument
 *   placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`) are substituted into
 *   it first; a command string without placeholders receives the arguments
 *   appended as trailing argv.
 * @param {string[]} args - the invocation's parsed arguments.
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number | null }} [options]
 *   - `cwd`: working directory for the child (the session's cwd).
 *   - `signal`: the handler's abort signal; aborting kills the child.
 *   - `timeoutMs`: kill the child after this long (default
 *     {@link COMMAND_TIMEOUT_MS}); `null` runs it until the child exits or
 *     the signal aborts.
 * @returns {Promise<string>} stdout with trailing whitespace trimmed.
 * @throws {Error} when the executable is missing, the child exits nonzero,
 *   is killed by a signal, or hits the timeout — the message carries the
 *   child's stderr (truncated) when it produced any.
 */
export function runTemplateCommand(command, args, { cwd, signal, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const interpolated = COMMAND_PLACEHOLDER_RE.test(command) ? substituteArgs(command, args) : command
  const argv = [...parseCommandArgs(interpolated), ...(interpolated === command ? args : [])]
  const child = spawn(argv[0], argv.slice(1), {
    ...(cwd === undefined ? {} : { cwd }),
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  let timedOut = false
  let timer = null
  if (timeoutMs !== null) {
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()
  }

  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      const errText = Buffer.concat(stderr).toString('utf-8').trim()
      const detail = errText === '' ? '' : `: ${truncated(errText)}`
      if (timedOut) {
        reject(new Error(`command did not finish within ${timeoutMs}ms${detail}`))
      } else if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf-8').trimEnd())
      } else {
        reject(new Error(`command exited with ${code === null ? `signal ${child.signalCode ?? 'unknown'}` : `code ${code}`}${detail}`))
      }
    })
  }).finally(() => { if (timer !== null) clearTimeout(timer) })
}

/**
 * Fold a command's output into the expanded template body. When the body
 * references the `$OUTPUT` / `${OUTPUT}` placeholder, the output replaces
 * each occurrence (the replacement itself is never re-scanned for
 * placeholders); otherwise the output is appended after the body.
 *
 * @param {string} body - the expanded template body (arguments already
 *   substituted — output text is never argument-substituted).
 * @param {string} output - the command's stdout (may be empty).
 * @returns {string} the final prompt text.
 */
export function combineCommandOutput(body, output) {
  if (!body.includes('${OUTPUT}') && !body.includes('$OUTPUT')) {
    if (output === '') return body
    return body === '' ? output : `${body}\n\n${output}`
  }
  // Replace ${OUTPUT} before $OUTPUT — the bare form is a substring of the
  // braced form. split/join, not replace: `$`-sequences in the output must
  // stay literal ($&, $', … are special in replacement strings).
  return body.split('${OUTPUT}').join(output).split('$OUTPUT').join(output)
}

/** Bound an embedded error detail to keep the failure text one-readable. */
function truncated(text, max = 500) {
  return text.length > max ? text.slice(0, max) + '…' : text
}