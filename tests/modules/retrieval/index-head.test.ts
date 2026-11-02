import assert from 'node:assert/strict'
import test from 'node:test'
import { openIndexHead, promoteIndexHead } from '../../../src/modules/retrieval/index-head.ts'
import { isIndexGenerationRetained, retainIndexGeneration } from '../../../src/modules/retrieval/index-transaction.ts'
import { storedIndexHeadKey, storedIndexPageKey, type StoredIndexHead } from '../../../src/modules/retrieval/stored-index.ts'
import type { RetrievalCache } from '../../../src/modules/retrieval/types.ts'

const key = 'a'.repeat(64)
const id = (index: number) => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
function fixture() {
  const values = new Map<string, unknown>(), deleted: string[] = [], writes: string[] = []
  const cache: RetrievalCache = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { writes.push(key); values.set(key, structuredClone(value)) },
    async delete(key) { deleted.push(key); values.delete(key) },
  }
  const options = { key, fromPage: 2, toPage: 3, signal: new AbortController().signal, check() {} }
  const headKey = storedIndexHeadKey(key)
  return { values, deleted, writes, cache, options, headKey,
    head: () => values.get(headKey) as StoredIndexHead }
}

test('opening creates and pins one pending generation, resumes it, and permits selecting the ready head', async () => {
  const f = fixture()
  const first = await openIndexHead(f.cache, f.options)
  assert.equal(first.created, true)
  assert.equal(f.head().pending!.id, first.selected.id)
  assert.equal(isIndexGenerationRetained(f.cache, key, first.selected.id), true)
  const resumed = await openIndexHead(f.cache, f.options)
  assert.equal(resumed.created, false); assert.equal(resumed.selected.id, first.selected.id)
  first.release(); first.release()
  assert.equal(isIndexGenerationRetained(f.cache, key, first.selected.id), true)
  resumed.release()
  assert.equal(isIndexGenerationRetained(f.cache, key, first.selected.id), false)
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, pending: { id: id(2) } })
  const ready = await openIndexHead(f.cache, { ...f.options, preferReady: true })
  assert.equal(ready.selected.id, id(1)); ready.release()
  const pending = await openIndexHead(f.cache, f.options)
  assert.equal(pending.selected.id, id(2)); pending.release()
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) } })
  const active = await openIndexHead(f.cache, f.options)
  assert.equal(active.selected.id, id(1)); active.release()
})

test('forced opens reuse their token and retain bounded distinct seed metadata', async () => {
  const f = fixture()
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, pending: { id: id(2) },
    seeds: Array.from({ length: 8 }, (_, index) => ({ id: id(index + 2) })) })
  const first = await openIndexHead(f.cache, { ...f.options, rebuildToken: 'force-one' })
  assert.equal(first.created, true)
  assert.equal(first.head.seeds!.length, 8)
  assert.equal(new Set(first.head.seeds!.map(seed => seed.id)).size, 8)
  assert.deepEqual(first.head.retired, [{ id: id(9) }])
  const resumed = await openIndexHead(f.cache, { ...f.options, rebuildToken: 'force-one' })
  assert.equal(resumed.created, false); assert.equal(resumed.selected.id, first.selected.id)
  first.release(); resumed.release()
  f.values.set(f.headKey, { version: 1, key, active: { id: id(10), rebuildToken: 'already-active' } })
  const accepted = await openIndexHead(f.cache, { ...f.options, rebuildToken: 'already-active' })
  assert.equal(accepted.created, false); assert.equal(accepted.selected.id, id(10)); accepted.release()
})

test('corrupt head repair is explicit and other storage failures cannot masquerade as absent metadata', async () => {
  const f = fixture()
  f.values.set(f.headKey, { damaged: true })
  await assert.rejects(openIndexHead(f.cache, f.options), { code: 'pdf/index-storage-corrupt' })
  const repaired = await openIndexHead(f.cache, { ...f.options, rebuildToken: 'repair' })
  assert.equal(repaired.created, true); assert.equal(repaired.selected.rebuildToken, 'repair'); repaired.release()
  const error = Object.assign(new Error('storage refused'), { code: 'pdf/index-storage-read-failed' })
  f.cache.get = async () => { throw error }
  await assert.rejects(openIndexHead(f.cache, { ...f.options, rebuildToken: 'cannot-hide-failure' }), value => value === error)
})

test('retired collection skips referenced and pinned generations and removes only unowned shards in the index range', async () => {
  const f = fixture(), release = retainIndexGeneration(f.cache, key, id(4))
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, pending: { id: id(2) }, seeds: [{ id: id(3) }],
    retired: [1, 2, 3, 4, 5].map(index => ({ id: id(index) })) })
  const opened = await openIndexHead(f.cache, f.options)
  assert.deepEqual(f.deleted, [storedIndexPageKey(key, id(5), 2), storedIndexPageKey(key, id(5), 3)])
  assert.deepEqual(opened.head.retired!.map(value => value.id), [1, 2, 3, 4].map(id))
  opened.release(); release()
  const next = await openIndexHead(f.cache, f.options)
  assert.ok(f.deleted.includes(storedIndexPageKey(key, id(4), 2)))
  assert.deepEqual(next.head.retired!.map(value => value.id), [1, 2, 3].map(id))
  next.release()
})

test('cleanup failures retain durable retry markers and isolate diagnostic callback failures', async () => {
  for (const observer of ['success', 'sync-error', 'async-error', 'absent'] as const) {
    const f = fixture(), failure = new Error('delete failed'), observed: unknown[] = []
    f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, retired: [{ id: id(2) }] })
    f.cache.delete = async () => { throw failure }
    const onFailure = observer === 'absent' ? undefined : (error: unknown) => {
      observed.push(error)
      if (observer === 'sync-error') throw new Error('observer failed')
      if (observer === 'async-error') return Promise.reject(new Error('observer failed asynchronously'))
    }
    const opened = await openIndexHead(f.cache, { ...f.options, onFailure })
    assert.deepEqual(opened.head.retired, [{ id: id(2) }])
    assert.equal(observed.length, observer === 'absent' ? 0 : 1)
    opened.release()
  }
  const f = fixture()
  const original: StoredIndexHead = { version: 1, key, active: { id: id(1) }, retired: [{ id: id(2) }] }
  f.values.set(f.headKey, original)
  f.cache.set = async () => { throw new Error('cleanup marker update failed') }
  const retained = await openIndexHead(f.cache, f.options)
  assert.deepEqual(retained.head, original)
  retained.release()
  f.cache.delete = undefined
  const unsupported = await openIndexHead(f.cache, f.options)
  assert.deepEqual(unsupported.head, original)
  unsupported.release()
})

test('cancellation during cleanup propagates and cancellation after pinning releases the selected generation', async () => {
  const f = fixture(), controller = new AbortController(), reason = new Error('caller closed')
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, retired: [{ id: id(2) }] })
  f.cache.delete = async () => { controller.abort(reason) }
  await assert.rejects(openIndexHead(f.cache, { ...f.options, signal: controller.signal }), error => error === reason)
  assert.equal(isIndexGenerationRetained(f.cache, key, id(1)), false)
  const selected = fixture(), close = new AbortController()
  let checks = 0
  await assert.rejects(openIndexHead(selected.cache, { ...selected.options, signal: close.signal, check() {
    if (++checks === 2) queueMicrotask(() => close.abort(reason))
  } }), error => error === reason)
  assert.equal(isIndexGenerationRetained(selected.cache, key, selected.head().pending!.id), false)
})

test('uncollectable retired metadata cannot grow beyond its explicit head limit', async () => {
  const f = fixture()
  f.cache.delete = undefined
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, pending: { id: id(2) },
    seeds: Array.from({ length: 8 }, (_, index) => ({ id: id(index + 3) })),
    retired: Array.from({ length: 1024 }, (_, index) => ({ id: id(index + 100) })) })
  await assert.rejects(openIndexHead(f.cache, { ...f.options, rebuildToken: 'overflow' }), { code: 'pdf/index-storage-limit' })
  assert.equal(f.writes.length, 0)
  await assert.rejects(promoteIndexHead(f.cache, { key, generation: id(2), range: f.options,
    signal: f.options.signal, check() {} }), { code: 'pdf/index-storage-limit' })
  assert.equal(f.writes.length, 0, 'promotion must preserve the valid pending head when cleanup capacity is exhausted')
})

test('promotion retains newer pending work, retires unused snapshots, and refuses unrelated generations', async () => {
  const f = fixture()
  const options = { key, generation: id(2), range: { fromPage: 2, toPage: 3 }, signal: f.options.signal, check() {} }
  await assert.rejects(promoteIndexHead(f.cache, options), { code: 'pdf/stale-reader' })
  f.values.set(f.headKey, { version: 1, key, active: { id: id(1) }, pending: { id: id(3) }, seeds: [{ id: id(2) }] })
  const accepted = await promoteIndexHead(f.cache, options)
  assert.equal(accepted.active!.id, id(2)); assert.equal(accepted.pending!.id, id(3))
  assert.deepEqual(accepted.seeds, [{ id: id(2) }])
  assert.ok(f.deleted.includes(storedIndexPageKey(key, id(1), 2)))
  const writes = f.writes.length
  assert.deepEqual(await promoteIndexHead(f.cache, options), accepted)
  assert.equal(f.writes.length, writes)
  await assert.rejects(promoteIndexHead(f.cache, { ...options, generation: id(99) }), { code: 'pdf/stale-reader' })
  const current = await promoteIndexHead(f.cache, { ...options, generation: id(3) })
  assert.equal(current.active!.id, id(3)); assert.equal(current.pending, undefined)
  assert.equal(current.seeds, undefined)
})

test('promotion publishes only after storage succeeds and retains authority fences around the write', async () => {
  const f = fixture(), failure = new Error('head publication failed')
  f.values.set(f.headKey, { version: 1, key, pending: { id: id(1) } })
  f.cache.set = async () => { throw failure }
  const options = { key, generation: id(1), range: { fromPage: 2, toPage: 3 }, signal: f.options.signal, check() {} }
  await assert.rejects(promoteIndexHead(f.cache, options), error => error === failure)
  assert.equal(f.head().active, undefined)
  const g = fixture(), controller = new AbortController(), reason = new Error('source retired')
  g.values.set(g.headKey, { version: 1, key, pending: { id: id(1) } })
  g.cache.set = async (key, value) => { g.values.set(key, value); controller.abort(reason) }
  await assert.rejects(promoteIndexHead(g.cache, { ...options, signal: controller.signal }), error => error === reason)
})
