import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const { planNpmRelease, confirmCurrentMainRelease } = await import(new URL('../scripts/release-gate.mjs', import.meta.url).href)
const main = 'refs/heads/main'
const zero = '0'.repeat(40)
const command = (root: string, ...args: string[]) => execFileSync('git', args,
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const push = (before: string, after: string) => ({ eventName: 'push', ref: main, sha: after, event: { ref: main, before, after } })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-gate-'))
  command(root, 'init', '-q', '-b', 'main')
  command(root, 'config', 'user.name', 'Release fixture')
  command(root, 'config', 'user.email', 'release@example.invalid')
  command(root, 'config', 'core.autocrlf', 'false')
  const commit = async (version: string, extra: Record<string, unknown> = {}) => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@fixture/pdf', version, ...extra }))
    command(root, 'add', '--', 'package.json')
    command(root, 'commit', '--allow-empty', '-qm', 'Update fixture')
    return command(root, 'rev-parse', 'HEAD')
  }
  return { root, commit, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('untrusted events, non-main refs and unrequested manual runs cannot inspect or publish a checkout', () => {
  const unavailable = '/no-such-release-checkout'
  for (const context of [
    { eventName: 'pull_request', ref: main, sha: 'untrusted', event: { inputs: { publish: true } } },
    { eventName: 'pull_request_target', ref: main, sha: 'untrusted', event: { inputs: { publish: true } } },
    { ...push(zero, 'untrusted'), ref: 'refs/heads/feature' },
    { eventName: 'workflow_dispatch', ref: main, sha: 'untrusted', event: { inputs: { publish: 'false' } } },
  ]) assert.equal(planNpmRelease(context, unavailable).publish, false)
})

test('the whole push range detects an earlier version bump and skips ordinary or reverted version changes', async () => {
  const f = await fixture()
  try {
    const before = await f.commit('0.1.0')
    await f.commit('0.2.0')
    const after = await f.commit('0.2.0')
    assert.equal(planNpmRelease(push(before, after), f.root).version, '0.2.0')
    const ordinary = await f.commit('0.2.0')
    assert.equal(planNpmRelease(push(after, ordinary), f.root).publish, false)
    const reverted = await f.commit('0.1.0')
    assert.equal(planNpmRelease(push(before, reverted), f.root).publish, false,
      'an intermediate bump that was reverted is not a release')
  } finally { await f.dispose() }
})

test('an initial main push has no automatic baseline but an explicit manual release can bootstrap or retry', async () => {
  const f = await fixture()
  try {
    const sha = await f.commit('0.1.0')
    assert.equal(planNpmRelease(push(zero, sha), f.root).publish, false)
    for (const publish of [true, 'true']) {
      assert.deepEqual(planNpmRelease({ eventName: 'workflow_dispatch', ref: main, sha, event: { inputs: { publish } } }, f.root),
        { publish: true, version: '0.1.0', reason: 'Explicit main release or retry.' })
    }
  } finally { await f.dispose() }
})

test('invalid boundaries, unknown baselines, private packages and automatic downgrades fail closed', async () => {
  const f = await fixture()
  try {
    const before = await f.commit('0.2.0'), after = await f.commit('0.1.9')
    assert.throws(() => planNpmRelease(push(before, after), f.root), /version increase/)
    assert.throws(() => planNpmRelease(push(before, before), f.root), /checkout does not match/)
    assert.throws(() => planNpmRelease({ ...push(before, after), event: { ref: main, before, after: before } }, f.root), /boundaries/)
    assert.throws(() => planNpmRelease(push('--upload-pack=unsafe', after), f.root), /boundaries/)
    assert.throws(() => planNpmRelease(push('f'.repeat(40), after), f.root), /Cannot obtain the previous main commit/)
    const privateCommit = await f.commit('0.3.0', { private: true })
    assert.throws(() => planNpmRelease(push(after, privateCommit), f.root), /private package/)
    const invalid = await f.commit('01.3.0')
    assert.throws(() => planNpmRelease(push(privateCommit, invalid), f.root), /exact semantic version/)
  } finally { await f.dispose() }
})

test('prereleases cannot silently replace latest and graduation to the matching stable version is an increase', async () => {
  const f = await fixture()
  try {
    const before = await f.commit('0.1.0'), prerelease = await f.commit('0.2.0-rc.1')
    assert.equal(planNpmRelease(push(before, prerelease), f.root).publish, false)
    assert.equal(planNpmRelease({ eventName: 'workflow_dispatch', ref: main, sha: prerelease,
      event: { inputs: { publish: true } } }, f.root).publish, false)
    const stable = await f.commit('0.2.0')
    assert.equal(planNpmRelease(push(prerelease, stable), f.root).publish, true)
  } finally { await f.dispose() }
})

test('a missing historical commit is fetched from the local origin instead of guessing the latest parent', async () => {
  const f = await fixture(), clone = await mkdtemp(join(tmpdir(), 'dsh-release-shallow-'))
  try {
    const before = await f.commit('0.1.0')
    await f.commit('0.2.0')
    const after = await f.commit('0.2.0')
    command(f.root, 'clone', '--quiet', '--depth=1', pathToFileURL(f.root).href, clone)
    assert.throws(() => command(clone, 'cat-file', '-e', `${before}^{commit}`))
    assert.equal(planNpmRelease(push(before, after), clone).publish, true)
    assert.equal(command(clone, 'show', `${before}:package.json`), JSON.stringify({ name: '@fixture/pdf', version: '0.1.0' }))
  } finally { await rm(clone, { recursive: true, force: true }); await f.dispose() }
})

test('the publishing lock rejects superseded versions but permits a same-version main retry', async () => {
  const f = await fixture(), clone = await mkdtemp(join(tmpdir(), 'dsh-release-current-'))
  try {
    const before = await f.commit('0.1.0'), after = await f.commit('0.2.0')
    command(f.root, 'clone', '--quiet', pathToFileURL(f.root).href, clone)
    const plan = planNpmRelease(push(before, after), clone)
    await f.commit('0.2.0')
    assert.equal(confirmCurrentMainRelease(plan, clone).publish, true, 'same-version code updates retain integrity-checked retries')
    await f.commit('0.3.0')
    assert.equal(confirmCurrentMainRelease(plan, clone).publish, false, 'an old run must not move latest behind a newer main version')
    command(clone, 'remote', 'remove', 'origin')
    assert.throws(() => confirmCurrentMainRelease(plan, clone), /git fetch/,
      'a failed main-version check cannot authorize registry writes')
  } finally { await rm(clone, { recursive: true, force: true }); await f.dispose() }
})

test('the Actions entrypoint writes only a verified release decision to its output file', async () => {
  const f = await fixture()
  try {
    const before = await f.commit('0.1.0'), after = await f.commit('0.2.0')
    const eventPath = join(f.root, 'event.json'), output = join(f.root, 'output.txt')
    await writeFile(eventPath, JSON.stringify(push(before, after).event))
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/release-gate.mjs', import.meta.url))], {
      cwd: f.root, stdio: 'pipe', env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: main, GITHUB_SHA: after,
        GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
    })
    assert.equal(await readFile(output, 'utf8'), 'publish=true\nversion=0.2.0\n')
  } finally { await f.dispose() }
})
