import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const assertion = 'ASSERTION_CI_EXPECTED_81_RECEIVED_14'
async function fixture(mode: 'fail' | 'pass' | 'zero' | 'missing' | 'malformed') {
  const root = await mkdtemp(join(tmpdir(), 'pdf-web-runner-'))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'node_modules', 'vitest'), { recursive: true })
  await copyFile(new URL('../scripts/run-web-tests.mjs', import.meta.url), join(root, 'scripts', 'run-web-tests.mjs'))
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ mode, assertion }))
  await writeFile(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const config = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'))
const args = process.argv.slice(2), name = 'fixture group > case [atomic]', file = join(root, 'fixture.e2e.ts')
await appendFile(join(root, 'invocations.jsonl'), JSON.stringify(args) + '\\n')
if (args[0] === 'list') {
  await writeFile(args.find(arg => arg.startsWith('--json=')).slice(7), JSON.stringify([{ name, file }]))
} else {
  const output = args.find(arg => arg.startsWith('--outputFile=')).slice(13)
  if (config.mode === 'malformed') await writeFile(output, '{incomplete')
  else if (config.mode !== 'missing') await writeFile(output, JSON.stringify({
    success: config.mode !== 'fail', numPassedTests: config.mode === 'pass' ? 1 : 0,
    numFailedTests: config.mode === 'fail' ? 1 : 0,
    testResults: [{ name: file, assertionResults: config.mode === 'zero' ? [] : [{
      ancestorTitles: ['fixture group'], title: 'case [atomic]', fullName: name,
      status: config.mode === 'pass' ? 'passed' : 'failed',
      failureMessages: config.mode === 'fail' ? [config.assertion + '\\nExpected 81, received 14.'] : [],
    }] }],
  }))
  console.log('JSON report written to ' + output)
  process.exitCode = ['pass', 'zero'].includes(config.mode) ? 0 : 1
}
`)
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'run-web-tests.mjs'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 10_000 })
  const invocations = async () => (await readFile(join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  return { root, run, invocations, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('a failing isolated case prints its JSON assertion details and keeps the parent nonzero without retrying', async () => {
  const f = await fixture('fail')
  try {
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(assertion))
    assert.match(result.stderr, /fixture group > case \[atomic\]/)
    assert.match(result.stderr, /failed \(exit 1\)/)
    assert.deepEqual((await f.invocations()).map(args => args[0]), ['list', 'run'])
    assert.doesNotMatch(result.stdout, /1\/1 passed/)
  } finally { await f.dispose() }
})

test('missing and malformed case reports preserve the original subprocess failure', async () => {
  for (const mode of ['missing', 'malformed'] as const) {
    const f = await fixture(mode)
    try {
      const result = f.run()
      assert.equal(result.status, 1)
      assert.match(result.stderr, /failed \(exit 1\)/)
      assert.doesNotMatch(result.stderr, /Vitest failure details|SyntaxError|ENOENT/)
      assert.equal((await f.invocations()).length, 2)
    } finally { await f.dispose() }
  }
})

test('successful reports retain exact execution checks and the requested discovery filters', async () => {
  const f = await fixture('pass')
  try {
    const result = f.run('fixture.e2e.ts', '-t', 'case \\[atomic\\]')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Web tests: 1\/1 passed/)
    const calls = await f.invocations()
    assert.deepEqual(calls[0]!.slice(-3), ['fixture.e2e.ts', '--testNamePattern', 'case \\[atomic\\]'])
    assert.equal(calls[1]!.includes('--allowOnly=false'), true)
    assert.equal(calls[1]![calls[1]!.indexOf('--testNamePattern') + 1],
      '^(?:fixture group > case \\[atomic\\]|fixture group case \\[atomic\\])$')
  } finally { await f.dispose() }
})

test('a zero-execution success report still fails validation instead of passing the selected case', async () => {
  const f = await fixture('zero')
  try {
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Expected exactly one passing execution/)
    assert.doesNotMatch(result.stdout, /1\/1 passed/)
  } finally { await f.dispose() }
})
