/**
 * `dsh-prompt-commands`: pi-style prompt templates for dsh — markdown
 * templates discovered live from `.agents/prompts` roots and dynamically
 * registered as slash commands, one per file. Template format, default
 * roots, delivery modes (`inline` / `subagent`), and effort mapping: see
 * README.md.
 * @module dsh-prompt-commands
 */
import { statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { combineCommandOutput, runTemplateCommand } from './lib/command.js'
import { Config } from './lib/config.js'
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

/** The settings schema (lib/config.js): the loader's write gate for the
 * entry's `config:` block and the served surface the client card edits. */
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config] - the entry's `config:` block.
 *   In production every field is a volatile reference read with `.get()`
 *   (the loader commits card saves in place and emits
 *   `loader/volatile-update`); plain objects (the tests) pass through.
 *   Fields: `promptDirs` (string[]), `subagentProvider`, `subagentModel`,
 *   `subagentMaxTokens`, `subagentEffort`, `lang` — see lib/config.js.
 */
export function apply(ctx, config = {}) {
  /**
   * Read one config field through its volatile reference, or plain when the
   * caller passed literal values.
   * @param {string} field
   * @returns {unknown}
   */
  const read = (field) => {
    const value = config[field]
    return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  // Production configs carry refs: the schema (Config) is the write gate
  // there, and validateConfig is for the plain literal path.
  const hasRefs = Object.values(config).some((value) => value !== null && typeof value === 'object' && typeof value.get === 'function')
  if (!hasRefs) validateConfig(config)
  // The plugin's own copy follows the live `lang` — a card save commits the
  // field in place, so the next invocation speaks the new language.
  const strings = () => STRINGS[read('lang') ?? 'en']

  const agentsHome = resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
  const userRoot = join(agentsHome, 'prompts')
  /** The extra template roots the live `promptDirs` names, in config order. */
  const currentRoots = () => {
    const dirs = read('promptDirs')
    return (Array.isArray(dirs) ? dirs : []).map((dir) => resolve(dir))
  }

  /**
   * Resolve one coarse effort level to the concrete effort id of the route
   * the child subagent will actually run on: the config route when it names
   * provider/model, otherwise the session's latest request header (creation
   * options before the first request) — the same inheritance base the
   * subagent service merges from, so the ladder consulted is the child's.
   * Returns `undefined` when the route is unresolvable or advertises no
   * usable rung; the caller warns and spawns without an effort.
   * @param {unknown} agent - the handler's agent handle.
   * @param {'none' | 'low' | 'medium' | 'high'} coarse
   * @param {{ provider?: string, model?: string }} route - the config route (effort already split off).
   * @param {AbortSignal} signal
   * @returns {Promise<string | undefined>}
   */
  const resolveTemplateEffort = async (agent, coarse, route, signal) => {
    // `ctx.get`, not a property read: cordis context proxies only expose
    // injected services as properties (an uninjected read throws), and the
    // llm service must degrade to "no effort" when absent.
    const llm = ctx.get('llm')
    if (llm?.resolveModelInfo === undefined) return undefined
    const headerConfig = agent.session?.requestHeader?.()?.config
    const provider = route.provider ?? headerConfig?.provider ?? agent.options?.provider
    const model = route.model ?? headerConfig?.model ?? agent.options?.model
    if (provider === undefined || model === undefined) return undefined
    return resolveEffort(coarse, { provider, model, llm, signal })
  }

  /**
   * Build the invocation handler for one registered template. The captured
   * `template` is the discovery-time record (name + file path); the file is
   * re-read at each invocation for live edits.
   */
  const makeHandler = (template) => async ({ agent, rawInput, signal }) => {
    const str = strings()
    let current
    try {
      current = await loadTemplateFile(template.filePath, { source: template.source })
    } catch (error) {
      return { kind: 'error', text: str.fileInvalid(template.name, messageOf(error)) }
    }
    if (current === undefined) {
      return { kind: 'error', text: str.fileGone(template.name, template.filePath) }
    }

    const argsString = rawInput.replace(/^\s+/u, '')
    let text = expandTemplate(current, rawInput)

    // `command:` frontmatter: run the declared command with the invocation's
    // arguments as trailing argv and fold its stdout into the expanded
    // prompt ($OUTPUT / ${OUTPUT} placeholder, default body-then-output).
    // Runs for both delivery modes — it only shapes the prompt text. It runs
    // in the session's cwd (the same cwd project-root discovery uses).
    if (current.command !== undefined) {
      if (current.commandBackground && current.execution === 'subagent') {
        ctx.logger.warn(`prompt-commands: /${template.name} declares command-background with execution: subagent; the flag is ignored there — the command runs synchronously before the spawn`)
      } else if (current.commandBackground) {
        // Session-owned background child: not bound to the UI request's
        // abort signal, no start notice, the model is not involved. When
        // the child exits, the folded prompt is delivered as the agent's
        // next user message; a failure arrives as a non-waking notice.
        // With no command-timeout, it runs until it exits.
        warnInertInlineEffort(ctx.logger, current, template.name)
        void runTemplateCommand(current.command, parseCommandArgs(argsString), {
          cwd: agent.session?.header?.cwd ?? process.cwd(),
          timeoutMs: current.commandTimeout !== undefined ? current.commandTimeout : null,
        })
          .then((output) => {
            try {
              agent.followup(createUserMessage({
                content: [{ type: 'text', text: combineCommandOutput(text, output) }],
                source: { kind: 'user' },
              }))
            } catch {
              /* the session is gone; the output has nowhere to go */
            }
          })
          .catch((error) => {
            deliverNotice(agent, str.commandFailedNotice(template.name, messageOf(error)), str.failSummary(template.name, str.errorWord))
          })
        return { kind: 'success', text: str.commandStarted() }
      }
      let output
      try {
        output = await runTemplateCommand(current.command, parseCommandArgs(argsString), {
          cwd: agent.session?.header?.cwd ?? process.cwd(),
          signal,
          ...(current.commandTimeout === undefined ? {} : { timeoutMs: current.commandTimeout }),
        })
      } catch (error) {
        return { kind: 'error', text: str.commandFailed(template.name, messageOf(error)) }
      }
      text = combineCommandOutput(text, output)
    }

    if (current.execution === 'subagent') {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) {
        return { kind: 'error', text: str.noSubagents(template.name) }
      }

      // Coarse effort: template frontmatter wins over the row config
      // default. Mapped onto the resolved child route's advertised ladder;
      // an unresolvable route (or one with no usable rung) drops the effort
      // with a warning and the child runs its route default. The route and
      // effort read the live config (a card save commits without re-apply).
      const subagentRoute = {}
      const provider = read('subagentProvider')
      const model = read('subagentModel')
      const maxTokens = read('subagentMaxTokens')
      if (typeof provider === 'string' && provider.length > 0) subagentRoute.provider = provider
      if (typeof model === 'string' && model.length > 0) subagentRoute.model = model
      if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) subagentRoute.maxTokens = maxTokens
      const coarseEffort = current.effort ?? read('subagentEffort')
      let appliedEffort
      let agentOptions = subagentRoute
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
        run = await subagents.startActivation({
          provider: 'spawn',
          label: labelFor(template.name, rawInput),
          signal,
          // The plugin delivers its own localized notices; 'parent' would
          // make the harness inject a stock settlement notice on top of them.
          delivery: 'caller',
          // dsh 0.2.2 flattened the activation spec: task options live on the
          // spec itself (0.2.1 nested them under `request`).
          prompt: [{ type: 'text', text }],
          parent: agent,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        })
      } catch (error) {
        return { kind: 'error', text: str.spawnFailed(template.name, messageOf(error)) }
      }

      // The chat is free while the child works: the model is blind to
      // in-flight subagents, so tell it one is in flight (a dsh restart
      // between the two notices must not leave a dangling "running" belief).
      deliverNotice(agent, str.startedNotice(template.name, appliedEffort), labelFor(template.name, rawInput))

      // Admission is the last thing the caller signal owns; afterwards the
      // subagent manager owns the run independently, so it survives this
      // handler returning and the UI request settling.
      void run.result
        .then((result) => deliverResultNotice(str, agent, template.name, result))
        .catch((error) => deliverNotice(agent, str.failedNotice(template.name, messageOf(error)), str.failSummary(template.name, str.errorWord)))
        .finally(() => {
          // Best-effort release: a naturally settled activation releases
          // itself, so this is normally a no-op; a teardown failure must not
          // surface as an unhandled rejection.
          Promise.resolve(run.dispose?.()).catch(() => {})
        })

      return { kind: 'success', text: str.started(appliedEffort) }
    }

    // Default (inline): the expanded prompt is an ordinary user message on
    // the invoking agent — pi's semantics (the model answers in this
    // session). Queues behind a running turn, like a normal user submit.
    warnInertInlineEffort(ctx.logger, current, template.name)
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      return { kind: 'error', text: str.followupFailed(messageOf(error)) }
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
          description: commandDescription(strings(), template),
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
    // Global layer: the live `promptDirs` roots (in config order), then the
    // user root. Custom roots register FIRST so they win same-layer name
    // collisions against the user root. Same-layer name collisions: the
    // first registration holds the name and the rest are tracked as
    // shadowed; when a holder unregisters (its file is deleted), the peers
    // re-sync and a shadowed root claims the freed name.
    const register = (definition) => scope.commands.register(definition)
    /** Custom roots currently watched: dir → watchRoot handle. */
    const customRoots = new Map()
    let userRootHandle = null
    const nudgeAll = (name) => {
      for (const peer of customRoots.values()) peer.nudge(name)
      userRootHandle?.nudge(name)
    }
    /** Diff the custom roots against the live `promptDirs`: add new dirs,
     *  dispose removed ones. Editing an existing dir in place is a no-op —
     *  the watch root already tracks that directory. */
    const syncCustomRoots = () => {
      const wanted = currentRoots()
      const wantedSet = new Set(wanted)
      for (const [dir, handle] of [...customRoots]) {
        if (wantedSet.has(dir)) continue
        customRoots.delete(dir)
        try { handle.dispose() } catch { /* already reclaimed */ }
      }
      for (const dir of wanted) {
        if (customRoots.has(dir)) continue
        customRoots.set(dir, watchRoot(dir, 'custom', register, nudgeAll))
      }
    }
    syncCustomRoots()
    userRootHandle = watchRoot(userRoot, 'user', register, nudgeAll)
    // A card save commits `promptDirs` in place (volatile) — re-derive the
    // custom roots without a re-apply.
    ctx.on('loader/volatile-update', () => { syncCustomRoots() })

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
      for (const handle of customRoots.values()) {
        try { handle.dispose() } catch { /* already reclaimed */ }
      }
      customRoots.clear()
      if (userRootHandle !== null) {
        try { userRootHandle.dispose() } catch { /* already reclaimed */ }
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

/** The plugin's own user-facing copy per `lang`; template content and journal/boot strings stay as written. */
const STRINGS = {
  en: {
    errorWord: 'error',
    promptTemplate: (name) => `Prompt template: ${name}`,
    started: (effort) => effort !== undefined
      ? `Started at effort ${effort} — result will arrive as a context notice.`
      : 'Started — result will arrive as a context notice.',
    fileInvalid: (name, message) => `/${name}: the template file is now invalid: ${message}`,
    fileGone: (name, path) => `/${name}: the template file no longer exists: ${path}`,
    commandFailed: (name, message) => `/${name}: the template's command failed: ${message}`,
    noSubagents: (name) => `/${name} is declared with execution: subagent, but this deployment composes no subagents service`,
    spawnFailed: (name, message) => `Failed to start the ${name} subagent: ${message}`,
    followupFailed: (message) => `Failed to send the expanded prompt: ${message}`,
    startedNotice: (name, effort) => `A /${name} subagent has just started${effort !== undefined ? ` (effort: ${effort})` : ''}. A follow-up notice will report the outcome; do not start another /${name} for the same request in the meantime.`,
    commandStarted: () => 'Started in the background — the output will arrive as a prompt when it finishes.',
    commandFailedNotice: (name, message) => `The /${name} background command failed: ${message}`,
    failedNotice: (name, message) => `A /${name} subagent failed: ${message}`,
    notCompleted: (name, stopReason, diagnostic, output) => `A /${name} subagent did NOT complete — it ended with “${stopReason}”${diagnostic ? ` (${diagnostic})` : ''}${output ? `: ${output}` : ''}. Retry /${name} if the task should have succeeded.`,
    finished: (name, output) => `A /${name} subagent just finished. Its final output: ${output}. Do not re-report this result unless asked.`,
    noOutput: '(no output)',
    failSummary: (name, reason) => `${name} FAILED — ${reason}`,
    doneSummary: (name, firstLine) => `${name} done — ${firstLine}`,
  },
  zh: {
    errorWord: '错误',
    promptTemplate: (name) => `提示模板：${name}`,
    started: (effort) => effort !== undefined
      ? `已以 ${effort} 推理强度启动——结果将以上下文通知送达。`
      : '已启动——结果将以上下文通知送达。',
    fileInvalid: (name, message) => `/${name}：模板文件当前无效：${message}`,
    fileGone: (name, path) => `/${name}：模板文件已不存在：${path}`,
    commandFailed: (name, message) => `/${name}：模板命令运行失败：${message}`,
    noSubagents: (name) => `/${name} 声明了 execution: subagent，但当前部署未组合 subagents 服务`,
    spawnFailed: (name, message) => `无法启动 ${name} 子代理：${message}`,
    followupFailed: (message) => `发送展开后的提示失败：${message}`,
    startedNotice: (name, effort) => `/${name} 子代理刚刚启动${effort !== undefined ? `（推理强度：${effort}）` : ''}。后续通知将报告结果；在此期间请勿为同一请求再次启动 /${name}。`,
    commandStarted: () => '已在后台启动——命令输出将在结束时作为提示送达。',
    commandFailedNotice: (name, message) => `/${name} 后台命令运行失败：${message}`,
    failedNotice: (name, message) => `/${name} 子代理运行失败：${message}`,
    notCompleted: (name, stopReason, diagnostic, output) => `/${name} 子代理未正常完成——它以「${stopReason}」结束${diagnostic ? `（${diagnostic}）` : ''}${output ? `：${output}` : ''}。如果任务本应成功，请重试 /${name}。`,
    finished: (name, output) => `/${name} 子代理刚刚完成。最终输出：${output}。除非被要求，请勿再次汇报此结果。`,
    noOutput: '（无输出）',
    failSummary: (name, reason) => `${name} 失败 — ${reason}`,
    doneSummary: (name, firstLine) => `${name} 完成 — ${firstLine}`,
  },
}

/**
 * A session's reasoning effort is durable state (its request header), not a
 * per-turn dial — there is no temporary session-side application, so a
 * template that declares `effort` while running inline (including a
 * background command delivered inline) logs a warning and runs at the
 * session's effort.
 * @param {{ warn(message: string): void }} logger
 * @param {{ effort?: string }} current
 * @param {string} name
 */
function warnInertInlineEffort(logger, current, name) {
  if (current.effort !== undefined) {
    logger.warn(`prompt-commands: /${name} declares effort ${current.effort} but runs inline; session effort is durable state, so the level is ignored (use execution: subagent to apply it)`)
  }
}

/**
 * A dsh command description must be non-empty; pi allows an empty one, so
 * fall back to a stable generated line.
 * @param {{ promptTemplate(name: string): string }} str - the active language table.
 * @param {{ name: string, description: string }} template
 * @returns {string}
 */
function commandDescription(str, template) {
  return template.description.length > 0 ? template.description : str.promptTemplate(template.name)
}

/** Subagent label: the template name, plus its first argument when one was given. */
function labelFor(name, rawInput) {
  const first = parseCommandArgs(rawInput.replace(/^\s+/u, ''))[0]
  return first === undefined ? name : `${name}: ${first}`
}

/** One-line final output, for the result notice's collapsed-row summary. */
function firstLineOf(text, noOutput) {
  return text.split('\n').find((line) => line.trim()) ?? noOutput
}

/** Report a settled subagent run as a non-waking context notice. */
function deliverResultNotice(str, agent, name, result) {
  const finalText = (result.output ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (result.stopReason !== 'completed') {
    deliverNotice(
      agent,
      str.notCompleted(name, result.stopReason, result.diagnostic, finalText !== '' ? finalText : undefined),
      str.failSummary(name, result.stopReason),
    )
    return
  }
  const shown = finalText === '' ? str.noOutput : finalText.slice(0, 500) + (finalText.length > 500 ? '…' : '')
  deliverNotice(agent, str.finished(name, shown), str.doneSummary(name, firstLineOf(finalText, str.noOutput)))
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
        kind: 'plugin:prompt-commands',
        form: 'notice',
        summary: boundContextSummary(summary),
      },
    }))
  } catch {
    /* best-effort */
  }
}

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

/** Validate the plain (test-path) row config, failing loud at boot (dsh
 *  plugin convention). In production the Config schema is the write gate —
 *  apply() skips this when the config carries volatile references. */
function validateConfig(config) {
  const known = new Set(['promptDirs', 'subagentProvider', 'subagentModel', 'subagentMaxTokens', 'subagentEffort', 'lang'])
  for (const key of Object.keys(config)) {
    if (!known.has(key)) {
      throw new TypeError(`prompt-commands config has unknown field "${key}" (expected promptDirs, subagentProvider, subagentModel, subagentMaxTokens, subagentEffort, or lang)`)
    }
  }
  if (config.promptDirs !== undefined) {
    if (!Array.isArray(config.promptDirs) || config.promptDirs.some((dir) => typeof dir !== 'string' || dir.length === 0)) {
      throw new TypeError('prompt-commands config.promptDirs must be an array of non-empty directory paths')
    }
  }
  for (const key of ['subagentProvider', 'subagentModel']) {
    const value = config[key]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new TypeError(`prompt-commands config.${key} must be a non-empty string`)
    }
  }
  if (config.subagentMaxTokens !== undefined && (!Number.isSafeInteger(config.subagentMaxTokens) || config.subagentMaxTokens <= 0)) {
    throw new TypeError('prompt-commands config.subagentMaxTokens must be a positive safe integer')
  }
  if (config.subagentEffort !== undefined && (typeof config.subagentEffort !== 'string' || !EFFORT_LEVELS.includes(config.subagentEffort))) {
    throw new TypeError('prompt-commands config.subagentEffort must be "none", "low", "medium", or "high"')
  }
  if (config.lang !== undefined && config.lang !== 'en' && config.lang !== 'zh') {
    throw new TypeError('prompt-commands config.lang must be "en" or "zh"')
  }
}
