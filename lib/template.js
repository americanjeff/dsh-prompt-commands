/**
 * pi-style prompt template core: frontmatter, directory discovery, and
 * argument parsing/substitution — a verbatim behavioral port of pi's
 * `prompt-templates.ts` (pi-mono packages/coding-agent/src/core), so any
 * template pi accepts (peff's `src/prompts/*.md` included) loads and
 * expands identically here.
 *
 * This module is pure: node:fs, node:path, and the `yaml` package only.
 * The dsh plugin half (index.js) owns command registration and delivery.
 *
 * @module dsh-prompt-commands/lib/template
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { EFFORT_LEVELS } from './effort.js'

/**
 * dsh command-name grammar (dsh-commands): lowercase, then alphanumerics,
 * underscore, hyphen. pi template names (filename minus `.md`) must satisfy
 * this to become slash commands; other files are skipped with a problem.
 */
export const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/u

/**
 * Parse command arguments respecting quoted strings (bash-style).
 * Ported verbatim from pi's `parseCommandArgs`.
 *
 * @param {string} argsString - raw argument text after the command name.
 * @returns {string[]} the parsed arguments.
 */
export function parseCommandArgs(argsString) {
  const args = []
  let current = ''
  let inQuote = null

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i]

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
    } else if (char === '"' || char === "'") {
      inQuote = char
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    args.push(current)
  }

  return args
}

/**
 * Substitute argument placeholders in template content.
 * Ported verbatim from pi's `substituteArgs`.
 * Supports:
 * - `$1`, `$2`, ... for positional args (missing = empty string)
 * - `$@` and `$ARGUMENTS` for all args (space-joined)
 * - `${@:N}` for args from Nth onwards (bash-style slicing)
 * - `${@:N:L}` for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like `$1`, `$@`, or `$ARGUMENTS` are NOT recursively
 * substituted (each pass scans the string it was given, never its own
 * replacements).
 *
 * @param {string} content - template body.
 * @param {string[]} args - parsed argument values.
 * @returns {string} the expanded text.
 */
export function substituteArgs(content, args) {
  let result = content

  // Replace $1, $2, etc. with positional args FIRST (before wildcards)
  // This prevents wildcard replacement values containing $<digit> patterns
  // from being re-substituted
  result = result.replace(/\$(\d+)/gu, (_, num) => {
    const index = parseInt(num, 10) - 1
    return args[index] ?? ''
  })

  // Replace ${@:start} or ${@:start:length} with sliced args (bash-style)
  // Process BEFORE simple $@ to avoid conflicts
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/gu, (_, startStr, lengthStr) => {
    let start = parseInt(startStr, 10) - 1 // Convert to 0-indexed (user provides 1-indexed)
    // Treat 0 as 1 (bash convention: args start at 1)
    if (start < 0) start = 0

    if (lengthStr) {
      const length = parseInt(lengthStr, 10)
      return args.slice(start, start + length).join(' ')
    }
    return args.slice(start).join(' ')
  })

  // Pre-compute all args joined (optimization)
  const allArgs = args.join(' ')

  // Replace $ARGUMENTS with all args joined (new syntax, aligns with
  // Claude, Codex, OpenCode)
  result = result.replace(/\$ARGUMENTS/gu, allArgs)

  // Replace $@ with all args joined (existing syntax)
  result = result.replace(/\$@/gu, allArgs)

  return result
}

/**
 * Extract YAML frontmatter from raw template content.
 *
 * Ported from pi's `extractFrontmatter` (yaml 2.x via the `yaml` package,
 * like pi). Content without a leading `---` marker (or without a closing
 * `---` line) has no frontmatter: the whole (newline-normalized) content is
 * the body.
 *
 * @param {string} raw - file content.
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  if (!normalized.startsWith('---')) {
    return { frontmatter: {}, body: normalized }
  }

  const endIndex = normalized.indexOf('\n---', 3)
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized }
  }

  const yamlString = normalized.slice(4, endIndex)
  const body = normalized.slice(endIndex + 4).trim()

  let parsed
  try {
    parsed = parseYaml(yamlString)
  } catch (error) {
    const err = new Error(`invalid YAML frontmatter: ${error.message}`, { cause: error })
    err.code = 'INVALID_FRONTMATTER'
    throw err
  }
  if (parsed !== null && typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('invalid YAML frontmatter: expected a mapping of key: value')
    err.code = 'INVALID_FRONTMATTER'
    throw err
  }

  return { frontmatter: (parsed ?? {}) /** @type {Record<string, unknown>} */ , body }
}

/**
 * The valid `execution` frontmatter values. `inline` (the default) sends the
 * expanded prompt to the invoking agent as a user message; `subagent` runs
 * it in a fresh one-shot subagent with a result notice.
 */
export const EXECUTION_MODES = Object.freeze(['inline', 'subagent'])

/**
 * Load one template file (name = basename minus `.md`).
 *
 * @param {string} filePath - absolute path to a `.md` file.
 * @param {{ source?: 'user' | 'project' | 'custom' }} [options]
 * @returns {Promise<import('../index.js').PromptTemplate | undefined>} the
 *   template, or `undefined` when the file is absent or unreadable.
 * @throws when the frontmatter is invalid YAML, `execution` names an
 *   unknown mode, or `effort` names an unknown level (the caller records a
 *   problem and skips the file).
 */
export async function loadTemplateFile(filePath, options = {}) {
  let rawContent
  try {
    rawContent = await readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }

  const { frontmatter, body } = parseFrontmatter(rawContent)
  const name = basename(filePath).replace(/\.md$/u, '')

  // Description from frontmatter or first non-empty line (pi behavior:
  // truncate at 60 characters with an ellipsis).
  let description = ''
  if (typeof frontmatter.description === 'string' && frontmatter.description.length > 0) {
    description = frontmatter.description
  } else {
    const firstLine = body.split('\n').find((line) => line.trim())
    if (firstLine) {
      description = firstLine.slice(0, 60)
      if (firstLine.length > 60) description += '...'
    }
  }

  let argumentHint
  if (typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint'].length > 0) {
    argumentHint = frontmatter['argument-hint']
  }

  let execution = 'inline'
  if (frontmatter.execution !== undefined) {
    if (typeof frontmatter.execution !== 'string' || !EXECUTION_MODES.includes(frontmatter.execution)) {
      const err = new Error(`invalid execution frontmatter: ${JSON.stringify(frontmatter.execution)} (expected "inline" or "subagent")`)
      err.code = 'INVALID_EXECUTION'
      throw err
    }
    execution = frontmatter.execution
  }

  // Coarse reasoning effort (subagent delivery maps it onto the child
  // route's ladder at spawn; inert for inline templates).
  let effort
  if (frontmatter.effort !== undefined) {
    if (typeof frontmatter.effort !== 'string' || !EFFORT_LEVELS.includes(frontmatter.effort)) {
      const err = new Error(`invalid effort frontmatter: ${JSON.stringify(frontmatter.effort)} (expected "low", "medium", or "high")`)
      err.code = 'INVALID_EFFORT'
      throw err
    }
    effort = frontmatter.effort
  }

  return {
    name,
    description,
    ...(argumentHint === undefined ? {} : { argumentHint }),
    execution,
    ...(effort === undefined ? {} : { effort }),
    content: body,
    filePath,
    ...(options.source === undefined ? {} : { source: options.source }),
    root: dirname(filePath),
  }
}

/**
 * Scan a directory (non-recursive) for `.md` template files, pi-style.
 *
 * @param {string} dir - directory to scan; a missing directory yields an
 *   empty result (not an error).
 * @param {{ source?: 'user' | 'project' | 'custom' }} [options]
 * @returns {Promise<{ templates: Array, problems: Array<{ file: string, message: string }> }>}
 *   templates sorted by name; `problems` records files skipped with a reason
 *   (invalid name, invalid frontmatter, read failure) so the caller can log.
 */
export async function discoverTemplates(dir, options = {}) {
  const templates = []
  const problems = []

  if (!isAbsolute(dir)) {
    const err = new Error(`discoverTemplates: directory must be absolute: ${dir}`)
    err.code = 'INVALID_ROOT'
    throw err
  }

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { templates, problems } // missing directory: no templates
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name)

    // For symlinks, check if they point to a file (pi behavior).
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const stats = await stat(fullPath)
        isFile = stats.isFile()
      } catch {
        problems.push({ file: fullPath, message: 'broken symbolic link' })
        continue
      }
    }

    if (!isFile || !entry.name.endsWith('.md')) continue

    const file = fullPath
    try {
      const template = await loadTemplateFile(file, options)
      if (template === undefined) continue
      if (!COMMAND_NAME_RE.test(template.name)) {
        problems.push({ file, message: `name "${template.name}" is not a valid dsh command name (expected ${COMMAND_NAME_RE})` })
        continue
      }
      templates.push(template)
    } catch (error) {
      problems.push({ file, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return { templates, problems }
}

/**
 * Expand one template's content with the exact argument text a command
 * handler received (`rawInput` in dsh: everything after the command name,
 * including the separator whitespace, which is trimmed like pi's own
 * leading-whitespace-consuming match).
 *
 * @param {{ content: string }} template - a loaded template (content only is read).
 * @param {string} rawInput - text following the command name.
 * @returns {string} the expanded prompt text.
 */
export function expandTemplate(template, rawInput) {
  const argsString = rawInput.replace(/^\s+/u, '')
  return substituteArgs(template.content, parseCommandArgs(argsString))
}

/**
 * Walk up from `cwd` to the nearest directory containing a `.git` entry
 * (the same project-root marker dsh's skill-filesystem uses), returning
 * `cwd` itself when no marker is found.
 *
 * @param {string} cwd - starting directory.
 * @returns {Promise<string>} the project root.
 */
export async function findProjectRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    try {
      await stat(join(current, '.git'))
      return current
    } catch {
      // not here: keep walking
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

/**
 * Diff a set of registered command descriptors against a fresh discovery
 * result, producing the minimal registration changes (live re-discovery).
 *
 * A template counts as CHANGED when any user-visible registration metadata
 * moved: the command description (slash-popup line), the input hint, or the
 * backing file. Body-only edits are NOT changes — the handler re-reads the
 * file at each invocation, so no re-registration is needed for them.
 *
 * @param {Map<string, { description: string, argumentHint: string|undefined, filePath: string }>} registered - current registrations keyed by command name.
 * @param {{ name: string, description: string, argumentHint: string|undefined, filePath: string }[]} templates - fresh discovery output.
 * @returns {{ toAdd: object[], toUpdate: object[], toRemove: string[] }}
 *   - `toAdd`: templates with no registration yet (register them).
 *   - `toUpdate`: templates whose registration metadata changed (re-register).
 *   - `toRemove`: command names that are no longer on disk (unregister).
 */
export function diffRegistrations(registered, templates) {
  const toAdd = []
  const toUpdate = []
  const toRemove = []

  for (const template of templates) {
    const existing = registered.get(template.name)
    if (existing === undefined) {
      toAdd.push(template)
      continue
    }
    const changed =
      existing.description !== template.description ||
      existing.argumentHint !== template.argumentHint ||
      existing.filePath !== template.filePath
    if (changed) toUpdate.push(template)
  }

  for (const name of registered.keys()) {
    if (!templates.some((template) => template.name === name)) toRemove.push(name)
  }

  return { toAdd, toUpdate, toRemove }
}
