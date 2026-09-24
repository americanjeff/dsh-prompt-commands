/**
 * Tests for the pi-style prompt template core.
 *
 * The `substituteArgs` / `parseCommandArgs` / `expandTemplate` cases are
 * ported verbatim from pi's `prompt-templates.test.ts` (pi-mono
 * packages/coding-agent/test) to pin exact behavioral parity. The discovery
 * and frontmatter cases cover the dsh additions (command-name validation,
 * execution frontmatter, peff compatibility fixtures).
 */

import { statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { EFFORT_LEVELS, mapEffort, resolveEffort } from '../lib/effort.js'
import {
  COMMAND_NAME_RE,
  diffRegistrations,
  discoverTemplates,
  expandTemplate,
  findProjectRoot,
  loadTemplateFile,
  parseCommandArgs,
  parseFrontmatter,
  substituteArgs,
} from '../lib/template.js'

// ============================================================================
// substituteArgs (ported from pi prompt-templates.test.ts)
// ============================================================================

describe('substituteArgs', () => {
  test('should replace $ARGUMENTS with all args joined', () => {
    assert.equal(substituteArgs('Test: $ARGUMENTS', ['a', 'b', 'c']), 'Test: a b c')
  })

  test('should replace $@ with all args joined', () => {
    assert.equal(substituteArgs('Test: $@', ['a', 'b', 'c']), 'Test: a b c')
  })

  test('should replace $@ and $ARGUMENTS identically', () => {
    const args = ['foo', 'bar', 'baz']
    assert.equal(substituteArgs('Test: $@', args), substituteArgs('Test: $ARGUMENTS', args))
  })

  test('should NOT recursively substitute patterns in argument values', () => {
    assert.equal(substituteArgs('$ARGUMENTS', ['$1', '$ARGUMENTS']), '$1 $ARGUMENTS')
    assert.equal(substituteArgs('$@', ['$100', '$1']), '$100 $1')
    assert.equal(substituteArgs('$ARGUMENTS', ['$100', '$1']), '$100 $1')
  })

  test('should support mixed $1, $2, and $ARGUMENTS', () => {
    assert.equal(substituteArgs('$1: $ARGUMENTS', ['prefix', 'a', 'b']), 'prefix: prefix a b')
  })

  test('should support mixed $1, $2, and $@', () => {
    assert.equal(substituteArgs('$1: $@', ['prefix', 'a', 'b']), 'prefix: prefix a b')
  })

  test('should handle empty arguments array with $ARGUMENTS', () => {
    assert.equal(substituteArgs('Test: $ARGUMENTS', []), 'Test: ')
  })

  test('should handle empty arguments array with $@', () => {
    assert.equal(substituteArgs('Test: $@', []), 'Test: ')
  })

  test('should handle empty arguments array with $1', () => {
    assert.equal(substituteArgs('Test: $1', []), 'Test: ')
  })

  test('should handle multiple occurrences of $ARGUMENTS', () => {
    assert.equal(substituteArgs('$ARGUMENTS and $ARGUMENTS', ['a', 'b']), 'a b and a b')
  })

  test('should handle multiple occurrences of $@', () => {
    assert.equal(substituteArgs('$@ and $@', ['a', 'b']), 'a b and a b')
  })

  test('should handle mixed occurrences of $@ and $ARGUMENTS', () => {
    assert.equal(substituteArgs('$@ and $ARGUMENTS', ['a', 'b']), 'a b and a b')
  })

  test('should handle special characters in arguments', () => {
    assert.equal(substituteArgs('$1 $2: $ARGUMENTS', ['arg100', '@user']), 'arg100 @user: arg100 @user')
  })

  test('should handle out-of-range numbered placeholders', () => {
    assert.equal(substituteArgs('$1 $2 $3 $4 $5', ['a', 'b']), 'a b   ')
  })

  test('should handle unicode characters', () => {
    assert.equal(substituteArgs('$ARGUMENTS', ['日本語', '🎉', 'café']), '日本語 🎉 café')
  })

  test('should preserve newlines and tabs in argument values', () => {
    assert.equal(substituteArgs('$1 $2', ['line1\nline2', 'tab\tthere']), 'line1\nline2 tab\tthere')
  })

  test('should handle consecutive dollar patterns', () => {
    assert.equal(substituteArgs('$1$2', ['a', 'b']), 'ab')
  })

  test('should handle quoted arguments with spaces', () => {
    assert.equal(substituteArgs('$ARGUMENTS', ['first arg', 'second arg']), 'first arg second arg')
  })

  test('should handle single argument with $ARGUMENTS', () => {
    assert.equal(substituteArgs('Test: $ARGUMENTS', ['only']), 'Test: only')
  })

  test('should handle single argument with $@', () => {
    assert.equal(substituteArgs('Test: $@', ['only']), 'Test: only')
  })

  test('should handle $0 (zero index)', () => {
    assert.equal(substituteArgs('$0', ['a', 'b']), '')
  })

  test('should handle decimal number in pattern (only integer part matches)', () => {
    assert.equal(substituteArgs('$1.5', ['a']), 'a.5')
  })

  test('should handle $ARGUMENTS as part of word', () => {
    assert.equal(substituteArgs('pre$ARGUMENTS', ['a', 'b']), 'prea b')
  })

  test('should handle $@ as part of word', () => {
    assert.equal(substituteArgs('pre$@', ['a', 'b']), 'prea b')
  })

  test('should handle empty arguments in middle of list', () => {
    assert.equal(substituteArgs('$ARGUMENTS', ['a', '', 'c']), 'a  c')
  })

  test('should handle trailing and leading spaces in arguments', () => {
    assert.equal(substituteArgs('$ARGUMENTS', ['  leading  ', 'trailing  ']), '  leading   trailing  ')
  })

  test('should handle argument containing pattern partially', () => {
    assert.equal(substituteArgs('Prefix $ARGUMENTS suffix', ['ARGUMENTS']), 'Prefix ARGUMENTS suffix')
  })

  test('should handle non-matching patterns', () => {
    assert.equal(substituteArgs('$A $$ $ $ARGS', ['a']), '$A $$ $ $ARGS')
  })

  test('should handle case variations (case-sensitive)', () => {
    assert.equal(substituteArgs('$arguments $Arguments $ARGUMENTS', ['a', 'b']), '$arguments $Arguments a b')
  })

  test('should handle both syntaxes in same command with same result', () => {
    const args = ['x', 'y', 'z']
    const result1 = substituteArgs('$@ and $ARGUMENTS', args)
    const result2 = substituteArgs('$ARGUMENTS and $@', args)
    assert.equal(result1, result2)
    assert.equal(result1, 'x y z and x y z')
  })

  test('should handle very long argument lists', () => {
    const args = Array.from({ length: 100 }, (_, i) => `arg${i}`)
    assert.equal(substituteArgs('$ARGUMENTS', args), args.join(' '))
  })

  test('should handle numbered placeholders with single digit', () => {
    assert.equal(substituteArgs('$1 $2 $3', ['a', 'b', 'c']), 'a b c')
  })

  test('should handle numbered placeholders with multiple digits', () => {
    const args = Array.from({ length: 15 }, (_, i) => `val${i}`)
    assert.equal(substituteArgs('$10 $12 $15', args), 'val9 val11 val14')
  })

  test('should handle escaped dollar signs (literal backslash preserved)', () => {
    assert.equal(substituteArgs('Price: \\$100', []), 'Price: \\')
  })

  test('should handle mixed numbered and wildcard placeholders', () => {
    assert.equal(substituteArgs('$1: $@ ($ARGUMENTS)', ['first', 'second', 'third']),
      'first: first second third (first second third)')
  })

  test('should handle command with no placeholders', () => {
    assert.equal(substituteArgs('Just plain text', ['a', 'b']), 'Just plain text')
  })

  test('should handle command with only placeholders', () => {
    assert.equal(substituteArgs('$1 $2 $@', ['a', 'b', 'c']), 'a b a b c')
  })
})

describe('substituteArgs - array slicing', () => {
  test('should slice from index (${@:N})', () => {
    assert.equal(substituteArgs('${@:2}', ['a', 'b', 'c', 'd']), 'b c d')
    assert.equal(substituteArgs('${@:1}', ['a', 'b', 'c']), 'a b c')
    assert.equal(substituteArgs('${@:3}', ['a', 'b', 'c', 'd']), 'c d')
  })

  test('should slice with length (${@:N:L})', () => {
    assert.equal(substituteArgs('${@:2:2}', ['a', 'b', 'c', 'd']), 'b c')
    assert.equal(substituteArgs('${@:1:1}', ['a', 'b', 'c']), 'a')
    assert.equal(substituteArgs('${@:3:1}', ['a', 'b', 'c', 'd']), 'c')
    assert.equal(substituteArgs('${@:2:3}', ['a', 'b', 'c', 'd', 'e']), 'b c d')
  })

  test('should handle out of range slices', () => {
    assert.equal(substituteArgs('${@:99}', ['a', 'b']), '')
    assert.equal(substituteArgs('${@:5}', ['a', 'b']), '')
    assert.equal(substituteArgs('${@:10:5}', ['a', 'b']), '')
  })

  test('should handle zero-length slices', () => {
    assert.equal(substituteArgs('${@:2:0}', ['a', 'b', 'c']), '')
    assert.equal(substituteArgs('${@:1:0}', ['a', 'b']), '')
  })

  test('should handle length exceeding array', () => {
    assert.equal(substituteArgs('${@:2:99}', ['a', 'b', 'c']), 'b c')
    assert.equal(substituteArgs('${@:1:10}', ['a', 'b']), 'a b')
  })

  test('should process slice before simple $@', () => {
    assert.equal(substituteArgs('${@:2} vs $@', ['a', 'b', 'c']), 'b c vs a b c')
    assert.equal(substituteArgs('First: ${@:1:1}, All: $@', ['x', 'y', 'z']), 'First: x, All: x y z')
  })

  test('should not recursively substitute slice patterns in args', () => {
    assert.equal(substituteArgs('${@:1}', ['${@:2}', 'test']), '${@:2} test')
    assert.equal(substituteArgs('${@:2}', ['a', '${@:3}', 'c']), '${@:3} c')
  })

  test('should handle mixed usage with positional args', () => {
    assert.equal(substituteArgs('$1: ${@:2}', ['cmd', 'arg1', 'arg2']), 'cmd: arg1 arg2')
    assert.equal(substituteArgs('$1 $2 ${@:3}', ['a', 'b', 'c', 'd']), 'a b c d')
  })

  test('should treat ${@:0} as all args', () => {
    assert.equal(substituteArgs('${@:0}', ['a', 'b', 'c']), 'a b c')
  })

  test('should handle empty args array', () => {
    assert.equal(substituteArgs('${@:2}', []), '')
    assert.equal(substituteArgs('${@:1}', []), '')
  })

  test('should handle single arg array', () => {
    assert.equal(substituteArgs('${@:1}', ['only']), 'only')
    assert.equal(substituteArgs('${@:2}', ['only']), '')
  })

  test('should handle slice in middle of text', () => {
    assert.equal(substituteArgs('Process ${@:2} with $1', ['tool', 'file1', 'file2']),
      'Process file1 file2 with tool')
  })

  test('should handle multiple slices in one template', () => {
    assert.equal(substituteArgs('${@:1:1} and ${@:2}', ['a', 'b', 'c']), 'a and b c')
    assert.equal(substituteArgs('${@:1:2} vs ${@:3:2}', ['a', 'b', 'c', 'd', 'e']), 'a b vs c d')
  })

  test('should handle quoted arguments in slices', () => {
    assert.equal(substituteArgs('${@:2}', ['cmd', 'first arg', 'second arg']), 'first arg second arg')
  })

  test('should handle special characters in sliced args', () => {
    assert.equal(substituteArgs('${@:2}', ['cmd', '$100', '@user', '#tag']), '$100 @user #tag')
  })

  test('should handle unicode in sliced args', () => {
    assert.equal(substituteArgs('${@:1}', ['日本語', '🎉', 'café']), '日本語 🎉 café')
  })

  test('should combine positional, slice, and wildcard placeholders', () => {
    const template = 'Run $1 on ${@:2:2}, then process $@'
    const args = ['eslint', 'file1.ts', 'file2.ts', 'file3.ts']
    assert.equal(substituteArgs(template, args),
      'Run eslint on file1.ts file2.ts, then process eslint file1.ts file2.ts file3.ts')
  })

  test('should handle slice with no spacing', () => {
    assert.equal(substituteArgs('prefix${@:2}suffix', ['a', 'b', 'c']), 'prefixb csuffix')
  })

  test('should handle large slice lengths gracefully', () => {
    const args = Array.from({ length: 10 }, (_, i) => `arg${i + 1}`)
    assert.equal(substituteArgs('${@:5:100}', args), 'arg5 arg6 arg7 arg8 arg9 arg10')
  })
})

// ============================================================================
// parseCommandArgs (ported from pi prompt-templates.test.ts)
// ============================================================================

describe('parseCommandArgs', () => {
  test('should parse simple space-separated arguments', () => {
    assert.deepEqual(parseCommandArgs('a b c'), ['a', 'b', 'c'])
  })

  test('should parse quoted arguments with spaces', () => {
    assert.deepEqual(parseCommandArgs('"first arg" second'), ['first arg', 'second'])
  })

  test('should parse single-quoted arguments', () => {
    assert.deepEqual(parseCommandArgs("'first arg' second"), ['first arg', 'second'])
  })

  test('should parse mixed quote styles', () => {
    assert.deepEqual(parseCommandArgs('"double" \'single\' "double again"'), ['double', 'single', 'double again'])
  })

  test('should handle empty string', () => {
    assert.deepEqual(parseCommandArgs(''), [])
  })

  test('should handle extra spaces', () => {
    assert.deepEqual(parseCommandArgs('a  b   c'), ['a', 'b', 'c'])
  })

  test('should handle tabs as separators', () => {
    assert.deepEqual(parseCommandArgs('a\tb\tc'), ['a', 'b', 'c'])
  })

  test('should handle quoted empty string', () => {
    assert.deepEqual(parseCommandArgs('"" " "'), [' '])
  })

  test('should handle arguments with special characters', () => {
    assert.deepEqual(parseCommandArgs('$100 @user #tag'), ['$100', '@user', '#tag'])
  })

  test('should handle unicode characters', () => {
    assert.deepEqual(parseCommandArgs('日本語 🎉 café'), ['日本語', '🎉', 'café'])
  })

  test('should handle newlines in quoted arguments', () => {
    assert.deepEqual(parseCommandArgs('"line1\nline2" second'), ['line1\nline2', 'second'])
  })

  test('should treat unquoted newlines as separators', () => {
    assert.deepEqual(parseCommandArgs('label-2\n\nHere is some description #2.'),
      ['label-2', 'Here', 'is', 'some', 'description', '#2.'])
  })

  test('should collapse mixed unquoted whitespace', () => {
    assert.deepEqual(parseCommandArgs('a\n\n\tb  c'), ['a', 'b', 'c'])
  })

  test('should handle escaped quotes inside quoted strings', () => {
    assert.deepEqual(parseCommandArgs('"quoted \\"text\\""'), ['quoted \\text\\'])
  })

  test('should handle trailing spaces', () => {
    assert.deepEqual(parseCommandArgs('a b c   '), ['a', 'b', 'c'])
  })

  test('should handle leading spaces', () => {
    assert.deepEqual(parseCommandArgs('   a b c'), ['a', 'b', 'c'])
  })
})

// ============================================================================
// expandTemplate (ported from pi + dsh rawInput semantics)
// ============================================================================

describe('expandTemplate', () => {
  const make = (content) => ({ content })

  test('should split template arguments on unquoted newlines', () => {
    const result = expandTemplate(make('- arg1: $1\n- rest: ${@:2}'),
      'label-2\n\nHere is some description #2.')
    assert.equal(result, '- arg1: label-2\n- rest: Here is some description #2.')
  })

  test('should support template command separated from args by newline', () => {
    const result = expandTemplate(make('arg1: $1'), '\nlabel-2')
    assert.equal(result, 'arg1: label-2')
  })

  test('should trim the dsh separator whitespace before parsing', () => {
    assert.equal(expandTemplate(make('$@'), '   hello world'), 'hello world')
    assert.equal(expandTemplate(make('$@'), '\thello'), 'hello')
  })

  test('should leave placeholder-free content untouched', () => {
    assert.equal(expandTemplate(make('plain text'), 'anything'), 'plain text')
  })
})

// ============================================================================
// parseFrontmatter (pi parity: extraction shape, yaml 2.x values)
// ============================================================================

describe('parseFrontmatter', () => {
  test('no frontmatter: whole content is the body', () => {
    assert.deepEqual(parseFrontmatter('just text\nmore'), { frontmatter: {}, body: 'just text\nmore' })
  })

  test('extracts flat frontmatter and trims the body', () => {
    const { frontmatter, body } = parseFrontmatter('---\ndescription: hi\nargument-hint: "[x]"\n---\n\nBody text\n')
    assert.equal(frontmatter.description, 'hi')
    assert.equal(frontmatter['argument-hint'], '[x]')
    assert.equal(body, 'Body text')
  })

  test('normalizes CRLF line endings', () => {
    const { frontmatter, body } = parseFrontmatter('---\r\ndescription: hi\r\n---\r\nbody')
    assert.equal(frontmatter.description, 'hi')
    assert.equal(body, 'body')
  })

  test('no closing marker: whole content is the body', () => {
    const { frontmatter, body } = parseFrontmatter('---\ndescription: hi\nno closer')
    assert.deepEqual(frontmatter, {})
    assert.equal(body, '---\ndescription: hi\nno closer')
  })

  test('unquoted yaml scalars keep their types (yaml 2.x, like pi)', () => {
    const { frontmatter } = parseFrontmatter('---\nflag: true\ncount: 3\n---\nbody')
    assert.equal(frontmatter.flag, true)
    assert.equal(frontmatter.count, 3)
  })

  test('invalid yaml throws INVALID_FRONTMATTER', () => {
    assert.throws(() => parseFrontmatter('---\n: : bad [\n---\nbody'), (err) => err.code === 'INVALID_FRONTMATTER')
  })

  test('non-mapping yaml throws INVALID_FRONTMATTER', () => {
    assert.throws(() => parseFrontmatter('---\n- a\n- b\n---\nbody'), (err) => err.code === 'INVALID_FRONTMATTER')
  })
})

// ============================================================================
// loadTemplateFile / discoverTemplates (dsh additions)
// ============================================================================

describe('template files', () => {
  let dir
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-template-test-'))
    await mkdir(join(dir, 'prompts'), { recursive: true })
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const write = (name, content) => writeFileSync(join(dir, 'prompts', name), content)

  test('name is the basename minus .md; content is the body', async () => {
    write('commit.md', '---\ndescription: Commit\n---\nDo $@.')
    const t = await loadTemplateFile(join(dir, 'prompts', 'commit.md'), { source: 'project' })
    assert.equal(t.name, 'commit')
    assert.equal(t.description, 'Commit')
    assert.equal(t.content, 'Do $@.')
    assert.equal(t.source, 'project')
    assert.equal(t.execution, 'inline')
    assert.equal(t.argumentHint, undefined)
  })

  test('description falls back to the first non-empty line (60-char cap)', async () => {
    const longLine = 'x'.repeat(70)
    write('fallback.md', `${longLine}\n\nsecond`)
    const t = await loadTemplateFile(join(dir, 'prompts', 'fallback.md'))
    assert.equal(t.description, 'x'.repeat(60) + '...')

    write('indented-fallback.md', '   \n  later line\n')
    const t2 = await loadTemplateFile(join(dir, 'prompts', 'indented-fallback.md'))
    assert.equal(t2.description, '  later line')
  })

  test('argument-hint is parsed; empty hint is ignored', async () => {
    write('hint.md', '---\ndescription: d\nargument-hint: "[headline]"\n---\nbody')
    assert.equal((await loadTemplateFile(join(dir, 'prompts', 'hint.md'))).argumentHint, '[headline]')

    write('nohint.md', '---\ndescription: d\nargument-hint: ""\n---\nbody')
    assert.equal((await loadTemplateFile(join(dir, 'prompts', 'nohint.md'))).argumentHint, undefined)
  })

  test('execution frontmatter: inline default, subagent accepted, unknown rejected', async () => {
    write('exec1.md', '---\ndescription: d\n---\nbody')
    assert.equal((await loadTemplateFile(join(dir, 'prompts', 'exec1.md'))).execution, 'inline')

    write('exec2.md', '---\ndescription: d\nexecution: subagent\n---\nbody')
    assert.equal((await loadTemplateFile(join(dir, 'prompts', 'exec2.md'))).execution, 'subagent')

    write('bad-exec.md', '---\ndescription: d\nexecution: background\n---\nbody')
    await assert.rejects(loadTemplateFile(join(dir, 'prompts', 'bad-exec.md')),
      (err) => err.code === 'INVALID_EXECUTION')
  })

  test('effort frontmatter: coarse levels accepted, unknown values rejected', async () => {
    write('noeffort.md', '---\ndescription: d\n---\nbody')
    assert.equal((await loadTemplateFile(join(dir, 'prompts', 'noeffort.md'))).effort, undefined)

    for (const level of EFFORT_LEVELS) {
      write(`eff-${level}.md`, `---\ndescription: d\nexecution: subagent\neffort: ${level}\n---\nbody`)
      const t = await loadTemplateFile(join(dir, `prompts/eff-${level}.md`))
      assert.equal(t.effort, level)
      assert.equal(t.execution, 'subagent')
    }

    // effort is parsed for inline templates too (the handler decides it is
    // inert there).
    write('eff-inline.md', '---\ndescription: d\neffort: high\n---\nbody')
    assert.equal((await loadTemplateFile(join(dir, 'prompts/eff-inline.md'))).effort, 'high')

    write('bad-effort.md', '---\ndescription: d\neffort: critical\n---\nbody')
    await assert.rejects(loadTemplateFile(join(dir, 'prompts/bad-effort.md')),
      (err) => err.code === 'INVALID_EFFORT')

    // yaml types the field: a non-string is rejected, not coerced.
    write('typed-effort.md', '---\ndescription: d\neffort: 1\n---\nbody')
    await assert.rejects(loadTemplateFile(join(dir, 'prompts/typed-effort.md')),
      (err) => err.code === 'INVALID_EFFORT')
  })

  test('invalid yaml frontmatter rejects with INVALID_FRONTMATTER', async () => {
    write('bad.md', '---\n: : bad [\n---\nbody')
    await assert.rejects(loadTemplateFile(join(dir, 'prompts', 'bad.md')), (err) => err.code === 'INVALID_FRONTMATTER')
  })

  test('missing file resolves to undefined', async () => {
    assert.equal(await loadTemplateFile(join(dir, 'prompts', 'absent.md')), undefined)
  })

  test('discoverTemplates: non-recursive, .md only, sorted, missing dir is empty', async () => {
    const isolated = join(dir, 'isolated')
    await mkdir(isolated, { recursive: true })
    assert.deepEqual(await discoverTemplates(join(dir, 'nope')), { templates: [], problems: [] })

    writeFileSync(join(isolated, 'b.md'), 'body b')
    writeFileSync(join(isolated, 'a.md'), 'body a')
    writeFileSync(join(isolated, 'notes.txt'), 'not a template')
    await mkdir(join(isolated, 'nested'), { recursive: true })
    writeFileSync(join(isolated, 'nested', 'deep.md'), 'nested must not appear')

    const { templates, problems } = await discoverTemplates(isolated, { source: 'custom' })
    assert.deepEqual(templates.map((t) => t.name), ['a', 'b'])
    assert.equal(templates[0].source, 'custom')
    assert.deepEqual(problems, [])
  })

  test('discoverTemplates: records problems for bad names and broken symlinks', async () => {
    const isolated = join(dir, 'problems')
    await mkdir(isolated, { recursive: true })
    writeFileSync(join(isolated, 'Bad-Name.md'), 'uppercase names are not dsh command names')
    writeFileSync(join(isolated, 'ok-name.md'), 'fine')
    await symlink(join(isolated, 'missing-target.md'), join(isolated, 'link.md'))

    const { templates, problems } = await discoverTemplates(isolated)
    assert.ok(templates.some((t) => t.name === 'ok-name'))
    assert.ok(problems.some((p) => p.file.endsWith('Bad-Name.md') && p.message.includes('command name')))
    assert.ok(problems.some((p) => p.file.endsWith('link.md') && p.message === 'broken symbolic link'))
  })

  test('COMMAND_NAME_RE matches dsh command grammar', () => {
    assert.ok(COMMAND_NAME_RE.test('commit'))
    assert.ok(COMMAND_NAME_RE.test('commit-v2'))
    assert.ok(COMMAND_NAME_RE.test('commit_v2'))
    assert.ok(!COMMAND_NAME_RE.test('Commit'))
    assert.ok(!COMMAND_NAME_RE.test('1commit'))
    assert.ok(!COMMAND_NAME_RE.test('commit with space'))
    assert.ok(!COMMAND_NAME_RE.test('commit.md'))
  })
})

// ============================================================================
// effort: coarse level → concrete route rung (lib/effort.js)
// ============================================================================

describe('mapEffort (coarse level → route rung)', () => {
  test('deployment-shaped ladder: off/low/medium/xhigh (no high rung)', () => {
    const ladder = ['off', 'low', 'medium', 'xhigh']
    assert.equal(mapEffort('low', ladder), 'low')
    assert.equal(mapEffort('medium', ladder), 'medium')
    assert.equal(mapEffort('high', ladder), 'xhigh')
  })

  test('plain three-rung ladder is the identity', () => {
    assert.equal(mapEffort('low', ['low', 'medium', 'high']), 'low')
    assert.equal(mapEffort('medium', ['low', 'medium', 'high']), 'medium')
    assert.equal(mapEffort('high', ['low', 'medium', 'high']), 'high')
  })

  test('two-rung ladder: medium takes the lower rung', () => {
    assert.equal(mapEffort('low', ['low', 'high']), 'low')
    assert.equal(mapEffort('medium', ['low', 'high']), 'low')
    assert.equal(mapEffort('high', ['low', 'high']), 'high')
  })

  test('single-rung ladder: every level maps to it', () => {
    assert.equal(mapEffort('low', ['xhigh']), 'xhigh')
    assert.equal(mapEffort('medium', ['xhigh']), 'xhigh')
    assert.equal(mapEffort('high', ['xhigh']), 'xhigh')
  })

  test('reasoning-off rungs are excluded from the pool', () => {
    const ladder = ['off', 'none', 'low', 'high']
    assert.equal(mapEffort('low', ladder), 'low')
    assert.equal(mapEffort('high', ladder), 'high')
    assert.equal(mapEffort('low', ['OFF', 'low']), 'low', 'disable ids are case-insensitive')
    assert.equal(mapEffort('low', ['off']), undefined, 'a pool of only disable rungs has no usable rung')
    assert.equal(mapEffort('high', ['off', 'none']), undefined)
    assert.equal(mapEffort('medium', []), undefined)
  })
})

describe('resolveEffort (route ladder lookup)', () => {
  const LADDER = [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'xhigh', name: 'XHigh' },
  ]
  const llm = (info, error) => ({
    resolveModelInfo: async (provider, model) => {
      assert.equal(provider, 'p')
      assert.equal(model, 'm')
      if (error) throw error
      return info
    },
  })

  test('maps the coarse level onto the route\'s advertised ladder', async () => {
    assert.equal(await resolveEffort('high', { provider: 'p', model: 'm', llm: llm({ reasoning: { efforts: LADDER } }) }), 'xhigh')
    assert.equal(await resolveEffort('low', { provider: 'p', model: 'm', llm: llm({ reasoning: { efforts: LADDER } }) }), 'low')
  })

  test('route with no advertised reasoning → undefined', async () => {
    assert.equal(await resolveEffort('high', { provider: 'p', model: 'm', llm: llm({}) }), undefined)
    assert.equal(await resolveEffort('high', { provider: 'p', model: 'm', llm: llm({ reasoning: { efforts: [] } }) }), undefined)
  })

  test('unresolvable route (lookup throws) → undefined', async () => {
    assert.equal(await resolveEffort('high', { provider: 'p', model: 'm', llm: llm(undefined, new Error('NO_ADAPTER')) }), undefined)
  })
})

// ============================================================================
// peff compatibility: the real templates in $PEFF_PROMPTS_DIR load unchanged
// and expand like pi would (skipped when the env var is unset or the dir
// absent).
// ============================================================================

describe('peff compatibility', () => {
  const PEFF = process.env.PEFF_PROMPTS_DIR
  // Must be decided at definition time — node:test reads the test options
  // before the before() hooks run, so a hook-set flag would never skip.
  let skip = true
  if (PEFF) {
    try {
      skip = statSync(PEFF).isDirectory() ? false : 'PEFF_PROMPTS_DIR not a directory'
    } catch {
      skip = 'PEFF_PROMPTS_DIR absent'
    }
  }

  test('every peff template loads as a valid dsh command', { skip }, async () => {
    const { templates, problems } = await discoverTemplates(PEFF, { source: 'custom' })
    assert.deepEqual(problems, [])
    const names = templates.map((t) => t.name).sort()
    assert.deepEqual(names, ['commit', 'debug', 'design', 'execute', 'open', 'plan', 'quickplan', 'recipe', 'research'])
    for (const t of templates) {
      assert.ok(t.description.length > 0, `${t.name} has a description`)
    }
    // /commit runs in a subagent at the lowest reasoning effort; the rest
    // are inline with no effort declared.
    const commit = templates.find((t) => t.name === 'commit')
    assert.equal(commit.execution, 'subagent')
    assert.equal(commit.effort, 'low')
    for (const t of templates) {
      if (t.name === 'commit') continue
      assert.equal(t.execution, 'inline', `${t.name} defaults to inline`)
      assert.equal(t.effort, undefined, `${t.name} declares no effort`)
    }
  })

  test('peff /commit expands with a headline into $@', { skip }, async () => {
    const { templates } = await discoverTemplates(PEFF, { source: 'custom' })
    const commit = templates.find((t) => t.name === 'commit')
    assert.equal(commit.description, 'Commit current changes with jj')
    assert.equal(commit.argumentHint, '[headline]')

    const expanded = expandTemplate(commit, ' Fix the flaky test')
    assert.match(expanded, /If headline provided \(Fix the flaky test\)/)
    assert.ok(!expanded.includes('$@'), 'no placeholder remains')
  })

  test('peff /commit with no args leaves the placeholder text but no substitution', { skip }, async () => {
    const { templates } = await discoverTemplates(PEFF, { source: 'custom' })
    const commit = templates.find((t) => t.name === 'commit')
    const expanded = expandTemplate(commit, '')
    assert.match(expanded, /If headline provided \(\)/)
  })

  test('peff /plan expands the topic into $@', { skip }, async () => {
    const { templates } = await discoverTemplates(PEFF, { source: 'custom' })
    const plan = templates.find((t) => t.name === 'plan')
    const expanded = expandTemplate(plan, ' prompt templates for dsh')
    assert.equal(expanded.startsWith('Create an implementation plan for: prompt templates for dsh'), true)
  })
})

// ============================================================================
// findProjectRoot
// ============================================================================

describe('findProjectRoot', () => {
  let dir
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-root-'))
    await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(dir, 'a', '.git'), '')
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('walks up to the .git marker', async () => {
    assert.equal(await findProjectRoot(join(dir, 'a', 'b', 'c')), join(dir, 'a'))
    assert.equal(await findProjectRoot(join(dir, 'a')), join(dir, 'a'))
  })

  test('returns cwd when no marker exists upward', async () => {
    assert.equal(await findProjectRoot(join(dir, 'nowhere')), join(dir, 'nowhere'))
  })
})


// ============================================================================
// diffRegistrations (live re-discovery)
// ============================================================================

describe('diffRegistrations', () => {
  const reg = (entries) => new Map(entries)
  const t = (name, { description = `d-${name}`, argumentHint, filePath = `/p/${name}.md` } = {}) =>
    ({ name, description, argumentHint, filePath })

  test('empty registered + discovered → all toAdd', () => {
    const { toAdd, toUpdate, toRemove } = diffRegistrations(reg([]), [t('a'), t('b')])
    assert.deepEqual(toAdd.map((x) => x.name), ['a', 'b'])
    assert.equal(toUpdate.length, 0)
    assert.equal(toRemove.length, 0)
  })

  test('unchanged templates → no changes', () => {
    const current = reg([['a', t('a')], ['b', t('b')]])
    const { toAdd, toUpdate, toRemove } = diffRegistrations(current, [t('a'), t('b')])
    assert.equal(toAdd.length, 0)
    assert.equal(toUpdate.length, 0)
    assert.equal(toRemove.length, 0)
  })

  test('new template → toAdd only for it', () => {
    const current = reg([['a', t('a')]])
    const { toAdd, toUpdate, toRemove } = diffRegistrations(current, [t('a'), t('c')])
    assert.deepEqual(toAdd.map((x) => x.name), ['c'])
    assert.equal(toUpdate.length, 0)
    assert.equal(toRemove.length, 0)
  })

  test('removed template → toRemove by name', () => {
    const current = reg([['a', t('a')], ['b', t('b')]])
    const { toAdd, toUpdate, toRemove } = diffRegistrations(current, [t('a')])
    assert.equal(toAdd.length, 0)
    assert.equal(toUpdate.length, 0)
    assert.deepEqual(toRemove, ['b'])
  })

  test('description change → toUpdate', () => {
    const current = reg([['a', t('a', { description: 'old' })]])
    const { toUpdate } = diffRegistrations(current, [t('a', { description: 'new' })])
    assert.deepEqual(toUpdate.map((x) => x.name), ['a'])
  })

  test('argument-hint change (including undefined↔value) → toUpdate', () => {
    const current = reg([['a', t('a', { argumentHint: '[x]' })]])
    const { toUpdate: fromValue } = diffRegistrations(current, [t('a', { argumentHint: undefined })])
    assert.deepEqual(fromValue.map((x) => x.name), ['a'])
    const current2 = reg([['a', t('a', { argumentHint: undefined })]])
    const { toUpdate: fromUndefined } = diffRegistrations(current2, [t('a', { argumentHint: '[x]' })])
    assert.deepEqual(fromUndefined.map((x) => x.name), ['a'])
  })

  test('filePath change (rename) → toUpdate, not add+remove', () => {
    const current = reg([['a', t('a', { filePath: '/p/old.md' })]])
    const { toAdd, toUpdate, toRemove } = diffRegistrations(
      current,
      [t('a', { filePath: '/p/new.md' })],
    )
    assert.equal(toAdd.length, 0)
    assert.deepEqual(toUpdate.map((x) => x.name), ['a'])
    assert.equal(toRemove.length, 0)
  })

  test('mixed add/update/remove in one pass', () => {
    const current = reg([
      ['keep', t('keep')],
      ['upd', t('upd', { description: 'old' })],
      ['gone', t('gone')],
    ])
    const { toAdd, toUpdate, toRemove } = diffRegistrations(
      current,
      [t('keep'), t('upd', { description: 'new' }), t('fresh')],
    )
    assert.deepEqual(toAdd.map((x) => x.name), ['fresh'])
    assert.deepEqual(toUpdate.map((x) => x.name), ['upd'])
    assert.deepEqual(toRemove, ['gone'])
  })

  test('no registered → all toRemove when dir is empty', () => {
    const current = reg([['a', t('a')]])
    const { toAdd, toUpdate, toRemove } = diffRegistrations(current, [])
    assert.equal(toAdd.length, 0)
    assert.equal(toUpdate.length, 0)
    assert.deepEqual(toRemove, ['a'])
  })
})
