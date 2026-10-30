import assert from 'node:assert/strict'
import test from 'node:test'
import { createReaderFormCommits } from '../../../src/modules/viewer/controllers/reader-form-commits.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('blur and a global command join one serialized form commit before acting', async () => {
  const gate = deferred<boolean>(), calls: string[] = []
  const owner = createReaderFormCommits(async (id, value) => {
    calls.push(`${id}:${value}`)
    return id === 'first' ? gate.promise : true
  }, error => { assert.fail(String(error)) })
  owner.stage('first', 'new', 'old')
  const blur = owner.commit('first')
  owner.stage('second', true, false)
  const second = owner.commit('second')
  const command = owner.flush().then(ok => { if (ok) calls.push('save'); return ok })
  await Promise.resolve()
  assert.deepEqual(calls, ['first:new'])
  assert.equal(owner.getSnapshot(), true)
  gate.resolve(true)
  assert.equal(await blur, true)
  assert.equal(await second, true)
  assert.equal(await command, true)
  assert.deepEqual(calls, ['first:new', 'second:true', 'save'])
  assert.equal(owner.getSnapshot(), false)
})

test('failed widget submission retains its draft and blocks the following action', async () => {
  const gate = deferred<boolean>(), calls: string[] = []
  let succeed = false
  const owner = createReaderFormCommits(async (_id, value) => {
    calls.push(String(value))
    return succeed ? true : gate.promise
  }, error => { assert.fail(String(error)) })
  owner.stage('text', 'edited', 'source')
  const blur = owner.commit('text')
  const command = owner.flush().then(ok => { if (ok) calls.push('navigate'); return ok })
  gate.resolve(false)
  assert.equal(await blur, false)
  assert.equal(await command, false)
  assert.deepEqual(calls, ['edited'])
  assert.equal(owner.value('text'), 'edited')
  assert.equal(owner.getSnapshot(), true)
  succeed = true
  assert.equal(await owner.flush(), true)
  assert.deepEqual(calls, ['edited', 'edited'])
})

test('a focused text draft and edits made during its write are both flushed', async () => {
  const gate = deferred<boolean>(), calls: string[] = []
  const owner = createReaderFormCommits(async (_id, value) => {
    calls.push(String(value))
    return calls.length === 1 ? gate.promise : true
  }, error => { assert.fail(String(error)) })
  owner.stage('text', 'first', 'original')
  const command = owner.flush()
  await Promise.resolve()
  owner.stage('text', 'latest', 'original')
  gate.resolve(true)
  assert.equal(await command, true)
  assert.deepEqual(calls, ['first', 'latest'])
  assert.equal(owner.getSnapshot(), false)
})

test('reverting an unsubmitted field removes its draft and disposal fences queued writes', async () => {
  const gate = deferred<boolean>(), calls: string[] = []
  const errors: unknown[] = []
  const owner = createReaderFormCommits(async (id) => { calls.push(id); return gate.promise }, error => { errors.push(error) })
  owner.stage('text', 'edit', 'original')
  owner.stage('text', 'original', 'original')
  assert.equal(owner.getSnapshot(), false)
  owner.stage('a', true, false)
  owner.stage('b', true, false)
  const a = owner.commit('a'), b = owner.commit('b')
  await Promise.resolve()
  owner.dispose()
  gate.resolve(true)
  assert.equal(await a, false)
  assert.equal(await b, false)
  assert.equal(await owner.flush(), false)
  assert.deepEqual(calls, ['a'])
  assert.deepEqual(errors, [])
})

test('a rejected mutation blocks commands and reports the existing input error', async () => {
  const error = new Error('source changed'), errors: unknown[] = []
  const owner = createReaderFormCommits(async () => { throw error }, value => { errors.push(value) })
  owner.stage('text', 'edit', 'original')
  assert.equal(await owner.flush(), false)
  assert.deepEqual(errors, [error])
  assert.equal(owner.value('text'), 'edit')
})
