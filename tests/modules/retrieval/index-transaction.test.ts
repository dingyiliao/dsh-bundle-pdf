import assert from 'node:assert/strict'
import test from 'node:test'
import { isIndexGenerationRetained, retainIndexGeneration, withIndexTransaction } from '../../../src/modules/retrieval/index-transaction.ts'
import type { RetrievalCache } from '../../../src/modules/retrieval/types.ts'

const signal = () => new AbortController().signal
const store = (): RetrievalCache => ({ async get() { return undefined }, async set() {} })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('generation pins are reference-counted and repeated release cannot unpin another cached snapshot', () => {
  const cache = store()
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), false)
  const first = retainIndexGeneration(cache, 'head', 'generation')
  const second = retainIndexGeneration(cache, 'head', 'generation')
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), true)
  first(); first()
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), true)
  second()
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), false)
  const replacement = retainIndexGeneration(cache, 'head', 'generation')
  first(); second()
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), true, 'old cleanup callbacks cannot release a later snapshot')
  replacement()
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), false)
})

test('different cache objects, source keys and generation IDs have independent pins', () => {
  const cache = store(), other = store()
  const first = retainIndexGeneration(cache, 'source-a', 'generation-a')
  const second = retainIndexGeneration(cache, 'source-a', 'generation-b')
  const third = retainIndexGeneration(cache, 'source-b', 'generation-a')
  const fourth = retainIndexGeneration(other, 'source-a', 'generation-a')
  first()
  assert.equal(isIndexGenerationRetained(cache, 'source-a', 'generation-a'), false)
  assert.equal(isIndexGenerationRetained(cache, 'source-a', 'generation-b'), true)
  assert.equal(isIndexGenerationRetained(cache, 'source-b', 'generation-a'), true)
  assert.equal(isIndexGenerationRetained(other, 'source-a', 'generation-a'), true)
  second(); third()
  assert.equal(isIndexGenerationRetained(cache, 'source-a', 'generation-b'), false)
  assert.equal(isIndexGenerationRetained(cache, 'source-b', 'generation-a'), false)
  assert.equal(isIndexGenerationRetained(other, 'source-a', 'generation-a'), true)
  fourth()
})

test('aborting a queued head transaction never releases an independently retained generation', async () => {
  const cache = store(), gate = deferred(), entered = deferred(), controller = new AbortController()
  const release = retainIndexGeneration(cache, 'head', 'generation')
  const owner = withIndexTransaction(cache, 'head', signal(), async () => { entered.resolve(); await gate.promise })
  await entered.promise
  const waiting = withIndexTransaction(cache, 'head', controller.signal, async () => assert.fail('cancelled transaction executed'))
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  controller.abort(); await rejected
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), true)
  gate.resolve(); await owner
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), true)
  release()
  assert.equal(isIndexGenerationRetained(cache, 'head', 'generation'), false)
})

test('same-key owners execute in admission order and read-modify-write without losing another head change', async () => {
  const cache = store(), gate = deferred(), entered = deferred(), events: string[] = []
  let head = 0
  const first = withIndexTransaction(cache, 'source', signal(), async () => {
    events.push('first-entered'); entered.resolve()
    const before = head
    await gate.promise
    head = before + 1; events.push('first-committed')
    return 'first'
  })
  await entered.promise
  const second = withIndexTransaction(cache, 'source', signal(), async () => {
    events.push('second-entered'); head++; return 'second'
  })
  await turn()
  assert.deepEqual(events, ['first-entered'])
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.equal(head, 2)
  assert.deepEqual(events, ['first-entered', 'first-committed', 'second-entered'])
})

test('transaction failures release their slot and never poison a later operation', async () => {
  const cache = store(), error = new Error('storage failed'), events: string[] = []
  const failed = withIndexTransaction(cache, 'head', signal(), async () => { events.push('failed'); throw error })
  const succeeded = withIndexTransaction(cache, 'head', signal(), async () => { events.push('next'); return 42 })
  await assert.rejects(failed, value => value === error)
  assert.equal(await succeeded, 42)
  await turn()
  assert.equal(await withIndexTransaction(cache, 'head', signal(), async () => 7), 7)
  assert.deepEqual(events, ['failed', 'next'])
})

test('aborting a waiting owner rejects promptly but cannot let a third caller bypass the active writer', async () => {
  const cache = store(), gate = deferred(), entered = deferred(), events: string[] = []
  const first = withIndexTransaction(cache, 'head', signal(), async () => {
    events.push('first'); entered.resolve(); await gate.promise; events.push('first-finished')
  })
  await entered.promise
  const controller = new AbortController(), reason = new Error('queued caller cancelled')
  const waiting = withIndexTransaction(cache, 'head', controller.signal, async () => { events.push('must-not-execute') })
  const rejected = assert.rejects(waiting, value => value === reason)
  controller.abort(reason)
  await rejected
  const third = withIndexTransaction(cache, 'head', signal(), async () => { events.push('third'); return 3 })
  await turn()
  assert.deepEqual(events, ['first'], 'cancelled queue cleanup must retain the preceding I/O barrier')
  gate.resolve()
  await first
  assert.equal(await third, 3)
  assert.deepEqual(events, ['first', 'first-finished', 'third'])
})

test('pre-aborted calls never touch storage or execute and do not block a later owner', async () => {
  const cache = store(), controller = new AbortController()
  controller.abort()
  let executed = false
  await assert.rejects(withIndexTransaction(cache, 'head', controller.signal, async () => { executed = true }), { name: 'AbortError' })
  assert.equal(executed, false)
  assert.equal(await withIndexTransaction(cache, 'head', signal(), async () => 'accepted'), 'accepted')
})

test('different keys and different store objects can perform independent transactions concurrently', async () => {
  const firstStore = store(), secondStore = store(), firstGate = deferred(), firstEntered = deferred()
  const events: string[] = []
  const first = withIndexTransaction(firstStore, 'same-key', signal(), async () => {
    events.push('blocked-owner'); firstEntered.resolve(); await firstGate.promise
  })
  await firstEntered.promise
  assert.equal(await withIndexTransaction(firstStore, 'other-key', signal(), async () => { events.push('other-key'); return 1 }), 1)
  assert.equal(await withIndexTransaction(secondStore, 'same-key', signal(), async () => { events.push('other-store'); return 2 }), 2)
  assert.deepEqual(events, ['blocked-owner', 'other-key', 'other-store'])
  firstGate.resolve(); await first
})

test('cancelling a running operation does not pretend its pending I/O has completed or release its lock', async () => {
  const cache = store(), gate = deferred(), entered = deferred(), controller = new AbortController()
  const reason = new Error('running operation cancelled'), events: string[] = []
  let settled = false
  const first = withIndexTransaction(cache, 'head', controller.signal, async () => {
    entered.resolve(); await gate.promise; events.push('I/O completed'); return 'discarded result'
  })
  const result = assert.rejects(first, value => value === reason).then(() => { settled = true })
  await entered.promise
  controller.abort(reason)
  const second = withIndexTransaction(cache, 'head', signal(), async () => { events.push('second writer') })
  await turn()
  assert.equal(settled, false)
  assert.deepEqual(events, [])
  gate.resolve()
  await result; await second
  assert.deepEqual(events, ['I/O completed', 'second writer'])
})

test('cancellation immediately after admission still checks before executing the queued operation', async () => {
  const cache = store(), controller = new AbortController()
  let executions = 0
  const task = withIndexTransaction(cache, 'head', controller.signal, async () => { executions++ })
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(executions, 0)
  await turn()
  await withIndexTransaction(cache, 'head', signal(), async () => { executions++ })
  assert.equal(executions, 1)
})
