/**
 * Tests for the live-discovery half of the plugin (index.js): watcher
 * registration/unregistration, same-layer shadowed-name promotion, and
 * watch-root reclamation at plugin unload. Drives the real apply() with a
 * fake cordis context and a fake command registry that mirrors dsh's
 * same-layer rule (register throws when the name is already held).
 */

import { rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

// Debounce (200 ms) plus scan slack; keep waits well clear of the debounce.
const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fake command registry: register throws on a duplicate name in the layer. */
function makeCommands() {
  const active = new Map()
  return {
    active,
    register(definition) {
      if (active.has(definition.name)) {
        throw new Error(`duplicate command name "${definition.name}" in layer`)
      }
      const record = { definition, disposeCalls: 0 }
      record.dispose = () => {
        record.disposeCalls += 1
        active.delete(definition.name)
      }
      active.set(definition.name, record)
      return record.dispose
    },
  }
}

/**
 * Fake cordis context: inject runs the callback with a scope exposing the
 * fake registry plus effect() (recorded for unload). `services` stands in
 * for ctx.get() lookups (e.g. 'subagents', 'llm'); 'agents' absent keeps the
 * per-agent project layer dormant.
 */
function makeCtx(commands, services = {}, { logger = { warn() {} } } = {}) {
  const unloads = []
  const ctx = {
    logger,
    inject(_deps, callback) {
      const scope = {
        commands,
        effect(execute) {
          unloads.push(execute())
          return () => {}
        },
      }
      callback(scope)
      return Promise.resolve({ dispose: async () => {} })
    },
    on() {},
    get: (name) => services[name],
    llm: services.llm,
    unload() {
      for (const dispose of [...unloads].reverse()) {
        const settled = dispose()
        if (settled?.catch !== undefined) settled.catch(() => {})
      }
      unloads.length = 0
    },
    effectCount: () => unloads.length,
  }
  return ctx
}

describe('live discovery (index.js)', () => {
  let base
  let customA
  let customB
  let previousAgentsHome

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-prompt-live-test-'))
    customA = join(base, 'custom-a')
    customB = join(base, 'custom-b')
    await mkdir(join(base, 'agents', 'prompts'), { recursive: true })
    await mkdir(customA, { recursive: true })
    await mkdir(customB, { recursive: true })
    previousAgentsHome = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = join(base, 'agents')
  })

  after(async () => {
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(base, { recursive: true, force: true })
  })

  const template = (body = 'Do $@.', frontmatter = 'description: T') =>
    `---\n${frontmatter}\n---\n${body}\n`

  // Tests share the roots; clear leftovers so each starts from an empty scan.
  const resetRoots = async () => {
    for (const dir of [customA, customB]) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir)
    }
  }

  test('new template registers live; deletion unregisters it', async () => {
    await resetRoots()
    const commands = makeCommands()
    const ctx = makeCtx(commands)
    apply(ctx, { promptDirs: [customA] })
    await settle()
    assert.equal(commands.active.size, 0)

    writeFileSync(join(customA, 'alpha.md'), template())
    await settle()
    const record = commands.active.get('alpha')
    assert.ok(record, 'alpha registered after its file appeared')

    rmSync(join(customA, 'alpha.md'))
    await settle()
    assert.ok(!commands.active.has('alpha'), 'alpha unregistered after its file was deleted')
    assert.equal(record.disposeCalls, 1)
    ctx.unload()
  })

  test('frontmatter edit re-registers with the new metadata', async () => {
    await resetRoots()
    const commands = makeCommands()
    const ctx = makeCtx(commands)
    apply(ctx, { promptDirs: [customA] })
    await settle()

    writeFileSync(join(customA, 'beta.md'), template('One.'))
    await settle()
    const first = commands.active.get('beta')
    assert.ok(first, 'beta registered')

    writeFileSync(join(customA, 'beta.md'), template('Two.', 'description: Beta v2'))
    await settle()
    assert.equal(first.disposeCalls, 1, 'old registration disposed on metadata change')
    const second = commands.active.get('beta')
    assert.ok(second && second !== first, 'beta re-registered')
    assert.equal(second.definition.description, 'Beta v2')
    ctx.unload()
  })

  test('shadowed root claims the name when the holder deletes its file', async () => {
    await resetRoots()
    const commands = makeCommands()
    const ctx = makeCtx(commands)
    apply(ctx, { promptDirs: [customA, customB] })
    await settle()

    writeFileSync(join(customA, 'dup.md'), template('A.', 'description: from A'))
    writeFileSync(join(customB, 'dup.md'), template('B.', 'description: from B'))
    await settle(900)
    const holder = commands.active.get('dup')
    assert.ok(holder, 'one /dup registered')
    assert.equal(commands.active.size, 1, 'the second copy stayed shadowed')

    rmSync(holder.definition.description === 'from A'
      ? join(customA, 'dup.md')
      : join(customB, 'dup.md'))
    await settle(900)

    const claimant = commands.active.get('dup')
    assert.ok(claimant, 'the name is still held after the holder deleted its file')
    assert.notEqual(claimant, holder, 'the shadowed copy claimed the name')
    assert.equal(claimant.definition.description,
      holder.definition.description === 'from A' ? 'from B' : 'from A')
    ctx.unload()
  })

  test('plugin unload reclaims the watchers: no further registrations', async () => {
    await resetRoots()
    const commands = makeCommands()
    const ctx = makeCtx(commands)
    apply(ctx, { promptDirs: [customA] })
    await settle()
    assert.equal(ctx.effectCount(), 1, 'watch-root reclamation effect registered')

    writeFileSync(join(customA, 'gamma.md'), template())
    await settle()
    assert.ok(commands.active.has('gamma'))

    ctx.unload()
    assert.equal(commands.active.size, 0, 'unload disposes the registered commands')

    writeFileSync(join(customA, 'delta.md'), template())
    await settle(700)
    assert.ok(!commands.active.has('delta'), 'watchers are dead after unload')
  })
})

// ============================================================================
// row config validation (boot)
// ============================================================================

describe('row config validation (boot)', () => {
  let base
  let previousAgentsHome

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-prompt-config-test-'))
    previousAgentsHome = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = join(base, 'agents')
  })

  after(async () => {
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(base, { recursive: true, force: true })
  })

  test('subagent block accepts the coarse effort field', () => {
    const ctx1 = makeCtx(makeCommands())
    assert.doesNotThrow(() => {
      apply(ctx1, { subagent: { effort: 'low' } })
      ctx1.unload()
    })
    const ctx2 = makeCtx(makeCommands())
    assert.doesNotThrow(() => {
      apply(ctx2, { subagent: { provider: 'p', model: 'm', maxTokens: 100, effort: 'high' } })
      ctx2.unload()
    })
  })

  test('subagent block rejects unknown fields and non-coarse efforts', () => {
    assert.throws(() => apply(makeCtx(makeCommands()), { subagent: { effort: 'xhigh' } }),
      (err) => err instanceof TypeError && /effort/.test(err.message))
    assert.throws(() => apply(makeCtx(makeCommands()), { subagent: { reasoningEffort: 'low' } }),
      (err) => err instanceof TypeError && /unknown field/.test(err.message))
    assert.throws(() => apply(makeCtx(makeCommands()), { subagent: { effort: 1 } }),
      (err) => err instanceof TypeError && /effort/.test(err.message))
  })
})

// ============================================================================
// subagent effort: coarse level → concrete rung at spawn (handler level)
// ============================================================================

describe('subagent effort (handler spawn)', () => {
  let base
  let prompts
  let previousAgentsHome

  // The deployment-shaped session route: no `high` rung, so `high` must
  // land on `xhigh`.
  const SESSION_ROUTE = { provider: 'llama-swap', model: 'qwen3.8-27b' }
  const LADDER = [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }]

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-prompt-effort-test-'))
    prompts = join(base, 'prompts')
    await mkdir(prompts, { recursive: true })
    previousAgentsHome = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = join(base, 'agents')
  })

  after(async () => {
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(base, { recursive: true, force: true })
  })

  /** Catalog that resolves exactly one route; everything else throws. */
  const llmCatalog = (route) => ({
    resolveModelInfo: async (provider, model) => {
      if (provider !== route.provider || model !== route.model) throw new Error(`no route ${provider}/${model}`)
      return { reasoning: { efforts: LADDER } }
    },
  })

  /** Agent handle with a logged request header carrying `route`. */
  const agentWithHeader = (route) => ({
    id: 'test-agent',
    options: {},
    session: { requestHeader: () => ({ config: route }) },
    inject() {},
    followup() {},
  })

  /**
   * Register one `task` template, invoke its handler with a fake subagents
   * service, and return the recorded spawn request(s), logged warnings, and
   * the handler outcome.
   */
  const invoke = async (config = {}, frontmatter = '', { route = SESSION_ROUTE, llmOverride, agent } = {}) => {
    await rm(prompts, { recursive: true, force: true })
    await mkdir(prompts)
    writeFileSync(join(prompts, 'task.md'), `---\ndescription: T\n${frontmatter}\n---\nDo it.\n`)

    const calls = []
    const warnings = []
    const commands = makeCommands()
    const ctx = makeCtx(commands, {
      llm: llmOverride ?? llmCatalog(route),
      subagents: {
        start: async (_kind, req) => {
          calls.push(req)
          return {
            result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
            dispose: () => {},
          }
        },
      },
    }, { logger: { warn: (message) => warnings.push(message) } })

    apply(ctx, { promptDirs: [prompts], ...config })
    await settle()
    const record = commands.active.get('task')
    assert.ok(record, 'task registered')
    const outcome = await record.definition.handler({
      agent: agent ?? agentWithHeader(route),
      rawInput: '',
      signal: new AbortController().signal,
    })
    ctx.unload()
    return { calls, warnings, outcome }
  }

  test('frontmatter effort maps onto the session route ladder', async () => {
    const { calls, outcome } = await invoke({}, 'execution: subagent\neffort: high')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].agentOptions, { reasoningEffort: 'xhigh' }, 'high → highest rung of off/low/medium/xhigh')
    assert.equal(outcome.kind, 'success')
    assert.match(outcome.text, /effort xhigh/)
  })

  test('low and medium land on the lowest and middle rungs', async () => {
    const low = await invoke({}, 'execution: subagent\neffort: low')
    assert.deepEqual(low.calls[0].agentOptions, { reasoningEffort: 'low' })
    const mid = await invoke({}, 'execution: subagent\neffort: medium')
    assert.deepEqual(mid.calls[0].agentOptions, { reasoningEffort: 'medium' })
  })

  test('no effort declared: the config route goes through unmodified', async () => {
    const { calls } = await invoke({ subagent: { provider: 'llama-swap', model: 'qwen3.8-27b', maxTokens: 4096 } },
      'execution: subagent')
    assert.deepEqual(calls[0].agentOptions, { provider: 'llama-swap', model: 'qwen3.8-27b', maxTokens: 4096 })
  })

  test('config effort applies on the config route; frontmatter wins over config', async () => {
    const other = { provider: 'other', model: 'm2' }
    const fromConfig = await invoke(
      { subagent: { provider: 'other', model: 'm2', effort: 'low' } },
      'execution: subagent',
      { route: other },
    )
    assert.deepEqual(fromConfig.calls[0].agentOptions, { provider: 'other', model: 'm2', reasoningEffort: 'low' })

    const overridden = await invoke(
      { subagent: { provider: 'other', model: 'm2', effort: 'low' } },
      'execution: subagent\neffort: high',
      { route: other },
    )
    assert.deepEqual(overridden.calls[0].agentOptions, { provider: 'other', model: 'm2', reasoningEffort: 'xhigh' })
  })

  test('before the first request: creation options supply the route', async () => {
    const agent = {
      id: 'test-agent',
      options: SESSION_ROUTE,
      session: {},
      inject() {},
      followup() {},
    }
    const { calls } = await invoke({}, 'execution: subagent\neffort: high', { agent })
    assert.deepEqual(calls[0].agentOptions, { reasoningEffort: 'xhigh' })
  })

  test('unresolvable route: effort dropped with a warning, child still spawned', async () => {
    // The catalog knows no route the session uses.
    const { calls, warnings, outcome } = await invoke({}, 'execution: subagent\neffort: high', {
      llmOverride: llmCatalog({ provider: 'someone-else', model: 'm' }),
    })
    assert.equal(calls.length, 1)
    assert.ok(warnings.some((w) => w.includes('/task') && w.includes('high') && w.includes('not applied')), 'warned about the dropped effort')
    assert.equal(calls[0].agentOptions, undefined, 'spawned without agent options')
    assert.equal(outcome.kind, 'success')
    assert.doesNotMatch(outcome.text, /effort/)
  })

  test('route without advertised reasoning: effort dropped with a warning', async () => {
    const { calls, warnings } = await invoke({}, 'execution: subagent\neffort: low', {
      llmOverride: { resolveModelInfo: async () => ({}) },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].agentOptions, undefined)
    assert.ok(warnings.some((w) => w.includes('not applied')))
  })

  test('inline template with effort: warning logged, ordinary followup still sent', async () => {
    const sent = []
    const agent = {
      ...agentWithHeader(SESSION_ROUTE),
      followup: (message) => { sent.push(message) },
    }
    const { calls, warnings, outcome } = await invoke({}, 'effort: high', { agent })
    assert.equal(calls.length, 0, 'no subagent spawned')
    assert.equal(sent.length, 1, 'the expanded prompt was sent inline')
    assert.ok(warnings.some((w) => w.includes('/task') && w.includes('high') && w.includes('inline')))
    assert.equal(outcome.kind, 'success')
    assert.equal(outcome.text, undefined)
  })
})
