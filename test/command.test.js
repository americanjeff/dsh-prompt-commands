/**
 * Tests for the `command:` frontmatter support: frontmatter validation,
 * running the template command (args as trailing argv, timeout, nonzero
 * exit), and folding its stdout into the expanded body ($OUTPUT /
 * ${OUTPUT} placeholder, default body-then-output).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { COMMAND_TIMEOUT_MS, combineCommandOutput, runTemplateCommand } from '../lib/command.js'
import { loadTemplateFile } from '../lib/template.js'

// The test child is always node itself (no shell is spawned, so builtins
// like `echo` are unavailable). Scripts read their trailing argv.
const node = (script) => `${process.execPath} -e ${script}`

describe('loadTemplateFile: command frontmatter', () => {
  let base

  before(async () => { base = await mkdtemp(join(tmpdir(), 'dsh-prompt-command-test-')) })
  after(async () => { await rm(base, { recursive: true, force: true }) })

  const write = (name, content) => writeFile(join(base, name), content, 'utf-8')

  test('a non-empty string is accepted and trimmed', async () => {
    await write('ok.md', '---\ncommand:  node -e "console.log(1)" \n---\nBody.\n')
    const template = await loadTemplateFile(join(base, 'ok.md'))
    assert.equal(template.command, 'node -e "console.log(1)"')
  })

  test('command is optional — absent stays off the record', async () => {
    await write('plain.md', '---\ndescription: T\n---\nBody.\n')
    const template = await loadTemplateFile(join(base, 'plain.md'))
    assert.equal(template.command, undefined)
  })

  test('non-string and empty values are rejected with INVALID_COMMAND', async () => {
    await write('num.md', '---\ncommand: 42\n---\nBody.\n')
    await assert.rejects(loadTemplateFile(join(base, 'num.md')),
      (err) => err.code === 'INVALID_COMMAND' && /non-empty string/.test(err.message))
    await write('empty.md', '---\ncommand: "   "\n---\nBody.\n')
    await assert.rejects(loadTemplateFile(join(base, 'empty.md')),
      (err) => err.code === 'INVALID_COMMAND')
    await write('list.md', '---\ncommand: [a, b]\n---\nBody.\n')
    await assert.rejects(loadTemplateFile(join(base, 'list.md')),
      (err) => err.code === 'INVALID_COMMAND')
  })
})

describe('loadTemplateFile: command-timeout frontmatter', () => {
  let base

  before(async () => { base = await mkdtemp(join(tmpdir(), 'dsh-prompt-cmdtimeout-test-')) })
  after(async () => { await rm(base, { recursive: true, force: true }) })

  const load = async (content, name = 't.md') => {
    await writeFile(join(base, name), content, 'utf-8')
    return loadTemplateFile(join(base, name))
  }

  test('millisecond numbers and duration strings parse to milliseconds', async () => {
    assert.equal((await load('---\ncommand: x\ncommand-timeout: 300\n---\nB.\n')).commandTimeout, 300)
    assert.equal((await load('---\ncommand: x\ncommand-timeout: "90s"\n---\nB.\n')).commandTimeout, 90_000)
    assert.equal((await load('---\ncommand: x\ncommand-timeout: 5m\n---\nB.\n')).commandTimeout, 300_000)
    assert.equal((await load('---\ncommand: x\ncommand-timeout: 1.5h\n---\nB.\n')).commandTimeout, 5_400_000)
    assert.equal((await load('---\ncommand: x\ncommand-timeout: 250ms\n---\nB.\n')).commandTimeout, 250)
  })

  test('"none" means no timeout (null)', async () => {
    assert.equal((await load('---\ncommand: x\ncommand-timeout: none\n---\nB.\n')).commandTimeout, null)
  })

  test('absent stays undefined (the 10s default applies at the handler)', async () => {
    assert.equal((await load('---\ncommand: x\n---\nB.\n')).commandTimeout, undefined)
  })

  test('invalid values are rejected with INVALID_COMMAND_TIMEOUT', async () => {
    for (const value of ['10x', '0', '-5', true, [60]]) {
      const name = `bad-${Math.random().toString(36).slice(2)}.md`
      await assert.rejects(
        load(`---\ncommand: x\ncommand-timeout: ${typeof value === 'string' ? value : JSON.stringify(value)}\n---\nB.\n`, name),
        (err) => err.code === 'INVALID_COMMAND_TIMEOUT',
        `value ${JSON.stringify(value)} should be rejected`,
      )
    }
  })
})

describe('loadTemplateFile: command-background frontmatter', () => {
  let base

  before(async () => { base = await mkdtemp(join(tmpdir(), 'dsh-prompt-cmdbg-test-')) })
  after(async () => { await rm(base, { recursive: true, force: true }) })

  const load = async (content, name = 't.md') => {
    await writeFile(join(base, name), content, 'utf-8')
    return loadTemplateFile(join(base, name))
  }

  test('true is recorded; false and absent leave it unset', async () => {
    assert.equal((await load('---\ncommand: x\ncommand-background: true\n---\nB.\n')).commandBackground, true)
    assert.equal((await load('---\ncommand: x\ncommand-background: false\n---\nB.\n')).commandBackground, undefined)
    assert.equal((await load('---\ncommand: x\n---\nB.\n')).commandBackground, undefined)
  })

  test('non-boolean values are rejected with INVALID_COMMAND_BACKGROUND', async () => {
    for (const value of ['yes', 1, [true]]) {
      const name = `bad-${Math.random().toString(36).slice(2)}.md`
      await assert.rejects(
        load(`---\ncommand: x\ncommand-background: ${typeof value === 'string' ? value : JSON.stringify(value)}\n---\nB.\n`, name),
        (err) => err.code === 'INVALID_COMMAND_BACKGROUND',
        `value ${JSON.stringify(value)} should be rejected`,
      )
    }
  })
})

describe('runTemplateCommand', () => {
  test('invocation arguments arrive as trailing argv', async () => {
    const output = await runTemplateCommand(
      node("'console.log(\"out:\" + process.argv.slice(1).join(\",\"))'"),
      ['hello', 'two words'],
    )
    assert.equal(output, 'out:hello,two words')
  })

  test('placeholders in the command string consume the arguments', async () => {
    // `"$@"` interpolates the joined arguments as one quoted argv element;
    // nothing is appended.
    const output = await runTemplateCommand(
      node("'console.log(JSON.stringify(process.argv.slice(1)))'") + ' "$@"',
      ['a b', 'c'],
    )
    assert.equal(output, '["a b c"]')
  })

  test('$1 lands mid-command; referencing a placeholder suppresses the append', async () => {
    const output = await runTemplateCommand(
      node("'console.log(JSON.stringify(process.argv.slice(1)))'") + ' id=$1 tail',
      ['7', 'extra'],
    )
    assert.equal(output, '["id=7","tail"]')
  })

  test('a command string without placeholders keeps the trailing append', async () => {
    const output = await runTemplateCommand(
      node("'console.log(JSON.stringify(process.argv.slice(1)))'") + ' fixed',
      ['x'],
    )
    assert.equal(output, '["fixed","x"]')
  })

  test('$ARGUMENTS interpolates like in the body', async () => {
    const output = await runTemplateCommand(
      node("'console.log(JSON.stringify(process.argv.slice(1)))'") + ' sep $ARGUMENTS',
      ['one', 'two'],
    )
    assert.equal(output, '["sep","one","two"]')
  })

  test('quoted words in the command string stay one argv element', async () => {
    const output = await runTemplateCommand(
      node("'console.log(JSON.stringify(process.argv.slice(1)))'") + ' "a b"',
      [],
    )
    assert.equal(output, '["a b"]')
  })

  test('cwd is honored', async () => {
    const output = await runTemplateCommand(
      node("'console.log(process.cwd().split(\"/\").pop())'"),
      [],
      { cwd: tmpdir() },
    )
    assert.equal(output, tmpdir().split('/').pop())
  })

  test('nonzero exit rejects with the child stderr', async () => {
    await assert.rejects(
      runTemplateCommand(node("'console.error(\"boom\"); process.exit(3)'"), []),
      (err) => /code 3/.test(err.message) && /boom/.test(err.message),
    )
  })

  test('a missing executable rejects', async () => {
    await assert.rejects(
      runTemplateCommand('definitely-not-a-real-executable-xyz', []),
      (err) => /definitely-not-a-real-executable-xyz/.test(err.message),
    )
  })

  test('the child is killed at the timeout', async () => {
    await assert.rejects(
      runTemplateCommand(node("'setTimeout(() => {}, 60_000)'"), [], { timeoutMs: 50 }),
      (err) => /did not finish within 50ms/.test(err.message),
    )
  })

  test('the default timeout is 10 seconds', () => {
    assert.equal(COMMAND_TIMEOUT_MS, 10_000)
  })

  test('timeoutMs: null runs the child to completion', async () => {
    const output = await runTemplateCommand(
      node("'setTimeout(() => console.log(\"done\"), 300)'"),
      [],
      { timeoutMs: null },
    )
    assert.equal(output, 'done')
  })
})

describe('combineCommandOutput', () => {
  test('default: body first, output appended after a blank line', () => {
    assert.equal(combineCommandOutput('Body text.', 'output line'), 'Body text.\n\noutput line')
  })

  test('empty output appends nothing', () => {
    assert.equal(combineCommandOutput('Body text.', ''), 'Body text.')
  })

  test('$OUTPUT is replaced wherever it appears', () => {
    assert.equal(
      combineCommandOutput('Before $OUTPUT after.\nDo $OUTPUT now.', 'out'),
      'Before out after.\nDo out now.',
    )
  })

  test('${OUTPUT} (braced) is replaced too', () => {
    assert.equal(combineCommandOutput('Context: ${OUTPUT}\nTask.', 'out'), 'Context: out\nTask.')
  })

  test('an empty body with no placeholder becomes the output', () => {
    assert.equal(combineCommandOutput('', 'out'), 'out')
  })

  test('the replacement itself is never re-scanned for placeholders', () => {
    assert.equal(
      combineCommandOutput('Arg: $1\nContext: $OUTPUT', '$1 $OUTPUT'),
      'Arg: $1\nContext: $1 $OUTPUT',
    )
  })

  test('$-sequences in the output stay literal', () => {
    assert.equal(combineCommandOutput('Body $OUTPUT.', "a $& b $' c"), 'Body a $& b $\' c.')
  })
})