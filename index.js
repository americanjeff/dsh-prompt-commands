/**
 * `dsh-prompt-commands`: pi-style prompt templates for dsh.
 *
 * Markdown prompt templates (pi's `.pi/prompts/*.md` format: YAML
 * frontmatter `description` / `argument-hint`, a body with `$1…$N`, `$@`,
 * `$ARGUMENTS`, `${@:N}`, `${@:N:L}` placeholders) are DISCOVERED at boot and
 * DYNAMICALLY REGISTERED as slash commands — one command per template,
 * named after the file. Templates compatible with pi load unchanged
 * (peff's `src/prompts/*.md` included).
 *
 * Default template roots (mirroring where dsh finds skills):
 *
 * - PROJECT (per agent, registered agent-scoped so each session sees its
 *   own project's templates, shadowing globals):
 *   `<projectRoot>/.agents/prompts` — projectRoot is the nearest `.git`
 *   marker at or above the session's cwd, exactly like the skill provider.
 * - USER (global): `~/.agents/prompts` (`$DSH_AGENTS_HOME/prompts` when set).
 * - CUSTOM (global, from the row config `promptDirs`): explicit directories;
 *   registered BEFORE the user root so explicit config wins name collisions.
 *
 * Delivery per invocation (frontmatter `execution` selects; default
 * `inline`):
 *
 * - `inline` — the expanded template is sent to the INVOKING agent via
 *   `agent.followup()` as an ordinary user message (pi-faithful: the model
 *   sees the expanded prompt as a user prompt and answers in the session).
 * - `subagent` — the expanded template runs in a fresh one-shot subagent
 *   (`subagents.start('spawn', …)`); the command settles as "started"
 *   immediately, a non-waking "started" notice is injected at admission,
 *   and a follow-up "result" notice arrives when the child settles. The
 *   child's model route is the row config `subagent: {provider, model,
 *   maxTokens}` when present, otherwise the session's route.
 *
 * Coarse reasoning effort (frontmatter `effort: low | medium | high`, with
 * the row config `subagent.effort` as deployment default): at spawn the
 * level maps onto the resolved child route's advertised effort ladder —
 * low → lowest rung, medium → middle rung, high → highest rung, reasoning-off
 * rungs excluded. A route that cannot be resolved, or that advertises no
 * usable rung, drops the effort with a logged warning (the child runs its
 * route default). On `inline` templates the field is inert and logged: a
 * session's reasoning effort is durable state (its request header), not a
 * per-turn dial, so there is no temporary session-side application.
 *
 * Discovery is LIVE: every template directory is watched (fs.watch, with a
 * poll fallback while the directory is absent), and new/changed/removed
 * templates are registered/unregistered in the command registry as they
 * happen — no server restart and no new session needed. Editing a template's
 * BODY or its `effort` needs nothing (the file is re-read at each
 * invocation); editing its frontmatter (description / argument-hint)
 * re-registers the command so the slash popup stays current.
 *
 * Host half: a plain namespace cordis plugin (`name`/`apply`); there is no
 * browser half (templates appear in the web slash-popup through the
 * command registry's own discovery, which notifies clients of changes).
 * @module dsh-prompt-commands
 */
import { statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { EFFORT_LEVELS, resolveEffort } from './lib/effort.js'
import {
  diffRegistrations,
  discoverTemplates,
  expandTemplate,
  findProjectRoot,
  loadTemplateFile,
  parseCommandArgs,
} from './lib/template.js'

export const name = 'prompt-commands'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ promptDirs?: string[], subagent?: { provider?: string, model?: string, maxTokens?: number, effort?: 'low' | 'medium' | 'high' } }} [config]
 *   - `promptDirs`: extra template directories (files only, non-recursive),
 *     scanned before the user root so they win name collisions.
 *   - `subagent`: default model route and coarse effort for
 *     `execution: subagent` templates; absent fields inherit the session's
 *     route / apply no effort (frontmatter `effort` wins over the config).
 */
export function apply(ctx, config = {}) {
  validateConfig(config)

  const agentsHome = resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
  const userRoot = join(agentsHome, 'prompts')
  const customRoots = (config.promptDirs ?? []).map((dir) => resolve(dir))
  // `effort` is a coarse level the handler maps onto a route's ladder at
  // spawn — it is never forwarded as a child agent option itself.
  const { effort: configEffort, ...subagentRoute } = config.subagent ?? {}

  /**
   * Resolve one coarse effort level to the concrete effort id of the route
   * the child subagent will actually run on: the config route when it names
   * provider/model, otherwise the session's latest request header (creation
   * options before the first request) — the same inheritance base the
   * subagent service merges from, so the ladder consulted is the child's.
   * Returns `undefined` when the route is unresolvable or advertises no
   * usable rung; the caller warns and spawns without an effort.
   * @param {unknown} agent - the handler's agent handle.
   * @param {'low' | 'medium' | 'high'} coarse
   * @param {{ provider?: string, model?: string }} route - the config route (effort already split off).
   * @param {AbortSignal} signal
   * @returns {Promise<string | undefined>}
   */
  const resolveTemplateEffort = async (agent, coarse, route, signal) => {
    if (ctx.llm?.resolveModelInfo === undefined) return undefined
    const headerConfig = agent.session?.requestHeader?.()?.config
    const provider = route.provider ?? headerConfig?.provider ?? agent.options?.provider
    const model = route.model ?? headerConfig?.model ?? agent.options?.model
    if (provider === undefined || model === undefined) return undefined
    return resolveEffort(coarse, { provider, model, llm: ctx.llm, signal })
  }

  /**
   * Build the invocation handler for one registered template. The captured
   * `template` is the discovery-time record (name + file path); the file is
   * re-read at each invocation for live edits.
   */
  const makeHandler = (template) => async ({ agent, rawInput, signal }) => {
    let current
    try {
      current = await loadTemplateFile(template.filePath, { source: template.source })
    } catch (error) {
      return { kind: 'error', text: `/${template.name}: the template file is now invalid: ${messageOf(error)}` }
    }
    if (current === undefined) {
      return { kind: 'error', text: `/${template.name}: the template file no longer exists: ${template.filePath}` }
    }

    const text = expandTemplate(current, rawInput)

    if (current.execution === 'subagent') {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) {
        return { kind: 'error', text: `/${template.name} is declared with execution: subagent, but this deployment composes no subagents service` }
      }

      // Coarse effort: template frontmatter wins over the row config
      // default. Mapped onto the resolved child route's advertised ladder;
      // an unresolvable route (or one with no usable rung) drops the effort
      // with a warning and the child runs its route default.
      const coarseEffort = current.effort ?? configEffort
      let agentOptions = subagentRoute
      let appliedEffort
      if (coarseEffort !== undefined) {
        appliedEffort = await resolveTemplateEffort(agent, coarseEffort, subagentRoute, signal)
        if (appliedEffort === undefined) {
          ctx.logger.warn(`prompt-commands: /${template.name} effort ${coarseEffort} not applied — the child route could not be resolved or advertises no reasoning rungs; the child runs its route default`)
        } else {
          agentOptions = { ...subagentRoute, reasoningEffort: appliedEffort }
        }
      }

      let run
      try {
        run = await subagents.start('spawn', {
          prompt: [{ type: 'text', text }],
          parent: agent,
          signal,
          label: labelFor(template.name, rawInput),
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        })
      } catch (error) {
        return { kind: 'error', text: `Failed to start the ${template.name} subagent: ${messageOf(error)}` }
      }

      // The chat is free while the child works: the model is blind to
      // in-flight subagents, so tell it one is in flight (a dsh restart
      // between the two notices must not leave a dangling "running" belief).
      deliverNotice(
        agent,
        `A /${template.name} subagent has just started${appliedEffort !== undefined ? ` (effort: ${appliedEffort})` : ''}. A follow-up notice will report the outcome; do not start another /${template.name} for the same request in the meantime.`,
        labelFor(template.name, rawInput),
      )

      // Admission is the last thing the caller signal owns; afterwards the
      // subagent manager owns the run independently, so it survives this
      // handler returning and the UI request settling.
      void run.result
        .then((result) => deliverResultNotice(agent, template.name, result))
        .catch((error) => deliverNotice(agent, `A /${template.name} subagent failed: ${messageOf(error)}`, `${template.name} FAILED — error`))
        .finally(() => {
          try { run.dispose?.() } catch { /* best-effort release */ }
        })

      return {
        kind: 'success',
        text: appliedEffort !== undefined
          ? `Started at effort ${appliedEffort} — result will arrive as a context notice.`
          : 'Started — result will arrive as a context notice.',
      }
    }

    // Default (inline): the expanded prompt is an ordinary user message on
    // the invoking agent — pi's semantics (the model answers in this
    // session). Queues behind a running turn, like a normal user submit.
    if (current.effort !== undefined) {
      // A session's reasoning effort is durable state (its request header),
      // not a per-turn dial — there is no temporary session-side
      // application, so the declared level is ignored here.
      ctx.logger.warn(`prompt-commands: /${template.name} declares effort ${current.effort} but runs inline; session effort is durable state, so the level is ignored (use execution: subagent to apply it)`)
    }
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      return { kind: 'error', text: `Failed to send the expanded prompt: ${messageOf(error)}` }
    }
    return { kind: 'success' }
  }

  /**
   * Watch one template directory and keep the command registry in sync with
   * it (live discovery): new templates register, removed ones unregister,
   * and frontmatter changes re-register (body-only edits need nothing — the
   * handler re-reads the file per invocation).
   *
   * `register` must be a registration function for the target layer — the
   * root ctx's for global roots, an agent ctx's for that agent's project
   * root — and must return the disposer `commands.register()` returns.
   * When it throws (a same-layer name collision), the template is recorded
   * as shadowed and claimed once the holder releases the name.
   *
   * @param {string} dir - absolute template directory.
   * @param {string} source - 'custom' | 'user' | 'project'.
   * @param {(definition: object) => () => void} register
   * @param {(name: string) => void} [onRelease] - called with a command name when this root unregisters one it owned; the global layer wires it to re-sync the peer roots so a shadowed copy can claim the freed name.
   * @returns {{ dispose: () => void, nudge: (name: string) => void }}
   */
  const watchRoot = (dir, source, register, onRelease = () => {}) => {
    /** name → { description, argumentHint, filePath, disposer } — disposer is null while the name is shadowed by a same-layer peer. */
    const registered = new Map()
    /** Names a peer released that this root should claim on its next sync pass. */
    const pendingClaims = new Set()
    let lastProblemsSig = ''
    let watcher = null
    let pollTimer = null
    let debounceTimer = null
    let disposed = false

    const registerOne = (template, { quiet = false } = {}) => {
      try {
        const disposer = register({
          name: template.name,
          description: commandDescription(template),
          ...(template.argumentHint === undefined ? {} : { input: { hint: template.argumentHint } }),
          handler: makeHandler(template),
        })
        registered.set(template.name, {
          description: template.description,
          argumentHint: template.argumentHint,
          filePath: template.filePath,
          disposer,
        })
      } catch (error) {
        // A same-layer peer already holds the name: record the template as
        // shadowed so the claim pass re-registers it once the peer releases
        // the name.
        registered.set(template.name, {
          description: template.description,
          argumentHint: template.argumentHint,
          filePath: template.filePath,
          disposer: null,
        })
        if (!quiet) {
          ctx.logger.warn(`prompt-commands: /${template.name} not registered: ${messageOf(error)}`)
        }
      }
    }

    let syncing = false
    let syncQueued = false

    const sync = async () => {
      if (disposed) return
      // A change landing while a scan is in flight is not dropped: it queues
      // one more pass (run-until-quiet), so the final state always wins.
      if (syncing) {
        syncQueued = true
        return
      }
      syncing = true
      try {
        for (;;) {
          await syncInner()
          if (!syncQueued || disposed) break
          syncQueued = false
        }
      } finally {
        syncing = false
      }
    }

    const syncInner = async () => {
      let found
      try {
        found = await discoverTemplates(dir, { source })
      } catch (error) {
        ctx.logger.warn(`prompt-commands: failed to scan ${dir}: ${messageOf(error)}`)
        return
      }
      // Log discovery problems only when they change (not on every save).
      const problemsSig = JSON.stringify(found.problems)
      if (problemsSig !== lastProblemsSig) {
        lastProblemsSig = problemsSig
        for (const problem of found.problems) {
          ctx.logger.warn(`prompt-commands: ${problem.file} skipped: ${problem.message}`)
        }
      }

      const { toAdd, toUpdate, toRemove } = diffRegistrations(registered, found.templates)
      for (const name of toRemove) {
        const entry = registered.get(name)
        if (entry === undefined) continue
        if (entry.disposer !== null) {
          try { entry.disposer() } catch { /* already reclaimed */ }
          // We held the name; a shadowed peer can now claim it.
          onRelease(name)
        } else {
          pendingClaims.delete(name)
        }
        registered.delete(name)
      }
      for (const template of toUpdate) {
        const entry = registered.get(template.name)
        entry?.disposer?.()
        registered.delete(template.name)
        registerOne(template, { quiet: entry?.disposer === null })
      }
      for (const template of toAdd) registerOne(template)
      // Names a peer released that are still on disk here: claim them. A
      // failed claim (another peer got there first) stays shadowed until the
      // next release.
      for (const template of found.templates) {
        const entry = registered.get(template.name)
        if (entry === undefined || entry.disposer !== null || !pendingClaims.has(template.name)) continue
        pendingClaims.delete(template.name)
        registerOne(template, { quiet: true })
      }
    }

    const scheduleSync = () => {
      if (disposed) return
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void sync()
      }, 200)
      debounceTimer.unref?.()
    }

    const stopWatcher = () => {
      if (watcher !== null) {
        watcher.removeAllListeners()
        try { watcher.close() } catch { /* already closed */ }
        watcher = null
      }
    }

    const startWatcher = () => {
      if (disposed) return
      stopPoller()
      try {
        watcher = watch(dir, { persistent: false }, scheduleSync)
      } catch {
        startPoller()
        return
      }
      // The directory went away (or the watch is otherwise broken): fall
      // back to polling for its return.
      watcher.on('error', () => {
        stopWatcher()
        if (!disposed) startPoller()
      })
      void sync() // initial population
    }

    const stopPoller = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const startPoller = () => {
      if (disposed || pollTimer !== null) return
      pollTimer = setInterval(() => {
        try {
          if (statSync(dir).isDirectory()) startWatcher()
        } catch {
          // still absent — keep polling
        }
      }, 2000)
      pollTimer.unref?.()
      void sync() // reflect the absent directory (unregisters its templates)
    }

    try {
      if (statSync(dir).isDirectory()) startWatcher()
      else startPoller()
    } catch {
      startPoller()
    }

    /** Mark a released name as claimable and re-sync; no-op after dispose. */
    const nudge = (name) => {
      if (disposed) return
      pendingClaims.add(name)
      scheduleSync()
    }

    return {
      dispose: () => {
        disposed = true
        stopPoller()
        stopWatcher()
        if (debounceTimer !== null) clearTimeout(debounceTimer)
        for (const entry of registered.values()) {
          try { entry.disposer?.() } catch { /* already reclaimed */ }
        }
        registered.clear()
      },
      nudge,
    }
  }

  ctx.inject(['commands'], (scope) => {
    // Global layer: explicit config roots (in listed order), then the user
    // root. Same-layer name collisions: the first registration holds the
    // name and the rest are tracked as shadowed; when a holder unregisters
    // (its file is deleted), the peers re-sync and a shadowed root claims
    // the freed name.
    const globalRoots = []
    for (const [root, source] of [...customRoots.map((dir) => [dir, 'custom']), [userRoot, 'user']]) {
      globalRoots.push(watchRoot(root, source, (definition) => scope.commands.register(definition),
        (name) => { for (const peer of globalRoots) peer.nudge(name) }))
    }

    // Per-agent layer: the project `.agents/prompts` next to the session's
    // skills. Registered through `agent.ctx`, so the definitions are
    // agent-scoped (they shadow same-named globals for that agent only) and
    // are reclaimed automatically when the agent scope unloads.
    /** @type {Map<object, { disposed: boolean, root: { dispose(): void } | null, fiber: { dispose(): void } | null }>} */
    const agentRoots = new Map()

    const installProjectCommands = (agent) => {
      if (agentRoots.has(agent)) return
      const state = { disposed: false, root: null, fiber: null }
      agentRoots.set(agent, state)
      void (async () => {
        const cwd = agent.session?.header?.cwd ?? process.cwd()
        const projectRoot = await findProjectRoot(cwd)
        const root = join(projectRoot, '.agents', 'prompts')
        // Capture the agent-bound registration function; the fiber is
        // awaited so the callback (which sets `register`) has run.
        let register = null
        const fiber = await agent.ctx.inject(['commands'], (projectScope) => {
          register = (definition) => projectScope.commands.register(definition)
        })
        if (state.disposed) {
          try { fiber.dispose() } catch { /* already gone */ }
          return
        }
        state.fiber = fiber
        state.root = watchRoot(root, 'project', register)
      })().catch((error) => {
        ctx.logger.warn(`prompt-commands: project template discovery failed for agent ${agent.id}: ${messageOf(error)}`)
      })
    }

    const uninstallProjectCommands = (agent) => {
      const state = agentRoots.get(agent)
      if (state === undefined) return
      agentRoots.delete(agent)
      state.disposed = true
      state.root?.dispose()
      try { state.fiber?.dispose() } catch { /* already gone */ }
    }

    // Agents already live when the plugin loaded (HMR reload case):
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      for (const agent of agents.list()) installProjectCommands(agent)
    }
    ctx.on('agent/created', ({ agent }) => { installProjectCommands(agent) })
    ctx.on('agent/disposed', ({ agent }) => { uninstallProjectCommands(agent) })

    // Reclaim every watch root when the plugin unloads (HMR reload): the
    // per-agent roots also unwind at agent disposal, but plugin unload
    // reaches only this effect.
    scope.effect(() => () => {
      for (const handle of globalRoots) {
        try { handle.dispose() } catch { /* already reclaimed */ }
      }
      for (const state of agentRoots.values()) {
        state.disposed = true
        try { state.root?.dispose() } catch { /* already reclaimed */ }
        try { state.fiber?.dispose() } catch { /* already gone */ }
      }
      agentRoots.clear()
    }, 'prompt-commands: watch roots')
  })
}

// ── command metadata and notices ─────────────────────────────────────────────

/**
 * A dsh command description must be non-empty; pi allows an empty one, so
 * fall back to a stable generated line.
 * @param {{ name: string, description: string }} template
 * @returns {string}
 */
function commandDescription(template) {
  return template.description.length > 0 ? template.description : `Prompt template: ${template.name}`
}

/** Subagent label: the template name, plus its first argument when one was given. */
function labelFor(name, rawInput) {
  const first = parseCommandArgs(rawInput.replace(/^\s+/u, ''))[0]
  return first === undefined ? name : `${name}: ${first}`
}

/** One-line final output, for the result notice's collapsed-row summary. */
function firstLineOf(text) {
  return text.split('\n').find((line) => line.trim()) ?? '(no output)'
}

/** Report a settled subagent run as a non-waking context notice. */
function deliverResultNotice(agent, name, result) {
  const finalText = (result.output ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (result.stopReason !== 'completed') {
    const diagnostic = result.diagnostic ? ` (${result.diagnostic})` : ''
    deliverNotice(
      agent,
      `A /${name} subagent did NOT complete — it ended with “${result.stopReason}”${diagnostic}` +
        (finalText ? `: ${finalText}` : '') +
        `. Retry /${name} if the task should have succeeded.`,
      `${name} FAILED — ${result.stopReason}`,
    )
    return
  }
  deliverNotice(
    agent,
    `A /${name} subagent just finished. Its final output: ${finalText === '' ? '(no output)' : finalText.slice(0, 500)}` +
      (finalText.length > 500 ? '…' : '') +
      '. Do not re-report this result unless asked.',
    `${name} done — ${firstLineOf(finalText)}`,
  )
}

/**
 * Inject one non-waking user-role notice sourced from this plugin. Best
 * effort: the session may be gone or not injectable when a detached notice
 * is delivered.
 * @param {unknown} agent - the handler's agent handle (closure-captured).
 * @param {string} text - the notice body.
 * @param {string} summary - one line for the collapsed UI row (bounded here).
 */
function deliverNotice(agent, text, summary) {
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'prompt-commands',
        form: 'notice',
        summary: boundContextSummary(summary),
      },
    }))
  } catch {
    /* session gone or not injectable — best-effort delivery */
  }
}

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

/** Validate the row config, failing loud at boot (dsh plugin convention). */
function validateConfig(config) {
  if (config.promptDirs !== undefined) {
    if (!Array.isArray(config.promptDirs) || config.promptDirs.some((dir) => typeof dir !== 'string' || dir.length === 0)) {
      throw new TypeError('prompt-commands config.promptDirs must be an array of non-empty directory paths')
    }
  }
  if (config.subagent !== undefined) {
    if (typeof config.subagent !== 'object' || config.subagent === null || Array.isArray(config.subagent)) {
      throw new TypeError('prompt-commands config.subagent must be an object')
    }
    for (const [key, value] of Object.entries(config.subagent)) {
      if (key === 'maxTokens') {
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new TypeError('prompt-commands config.subagent.maxTokens must be a positive safe integer')
        }
      } else if (key === 'provider' || key === 'model') {
        if (typeof value !== 'string' || value.length === 0) {
          throw new TypeError(`prompt-commands config.subagent.${key} must be a non-empty string`)
        }
      } else if (key === 'effort') {
        if (typeof value !== 'string' || !EFFORT_LEVELS.includes(value)) {
          throw new TypeError('prompt-commands config.subagent.effort must be "low", "medium", or "high"')
        }
      } else {
        throw new TypeError(`prompt-commands config.subagent has unknown field "${key}" (expected provider, model, maxTokens, or effort)`)
      }
    }
  }
}
