import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalCache, type RetrievalCacheRecord } from '../../../../src/adapters/host/storage/retrieval-cache.ts'

test('derived cache survives adapter recreation, expires and evicts within its budget', async () => {
  const data = new Map<string, RetrievalCacheRecord>()
  const table = { get: (key: string) => data.get(key), entries: () => data.entries(),
    put: async (key: string, value: RetrievalCacheRecord) => { data.set(key, value) },
    delete: async (key: string) => data.delete(key) }
  let time = 1
  const options = { maxBytes: 1000, maxRecords: 2, maxAgeMs: 10, now: () => time }
  const cache = createRetrievalCache(table, options)
  await cache.set('a', [1, 2]); time++
  await cache.set('b', [3, 4]); time++
  assert.deepEqual(await cache.get('a'), [1, 2]); time++
  await cache.set('c', [5, 6])
  assert.equal(await cache.get('b'), undefined)
  const reopened = createRetrievalCache(table, options)
  assert.deepEqual(await reopened.get('c'), [5, 6])
  time = 30
  assert.equal(await reopened.get('c'), undefined)
  await reopened.set('d', 'new')
  assert.deepEqual([...data.keys()], ['d'])
  await reopened.set('oversized', 'x'.repeat(1001))
  assert.equal(await reopened.get('oversized'), undefined)
  await reopened.dispose()
})

test('a read-only restored cache prunes expired and over-budget records before returning a hit', async () => {
  const data = new Map<string, RetrievalCacheRecord>([
    ['expired', { createdAt: 1, payload: 'old' }],
    ['oldest-live', { createdAt: 12, payload: 'old live value' }],
    ['middle', { createdAt: 14, payload: 'middle value' }],
    ['newest', { createdAt: 16, payload: 'new value' }],
  ])
  const table = { get: (key: string) => data.get(key), entries: () => data.entries(),
    put: async (key: string, value: RetrievalCacheRecord) => { data.set(key, value) },
    delete: async (key: string) => data.delete(key) }
  const cache = createRetrievalCache(table, { maxBytes: 1000, maxRecords: 2, maxAgeMs: 10, now: () => 20 })
  assert.equal(await cache.get('newest'), 'new value')
  assert.deepEqual([...data.keys()], ['middle', 'newest'])
  assert.equal(await cache.get('expired'), undefined)
  await cache.dispose()
})

test('clear serializes with writes and deletes restored records across adapter recreation', async () => {
  const data = new Map<string, RetrievalCacheRecord>([['restored', { createdAt: 1, payload: 'old page' }]])
  let completeWrite!: () => void, writeStarted!: () => void
  const waiting = new Promise<void>(resolve => { completeWrite = resolve })
  const started = new Promise<void>(resolve => { writeStarted = resolve })
  const table = { get: (key: string) => data.get(key), entries: () => data.entries(),
    put: async (key: string, value: RetrievalCacheRecord) => {
      if (key === 'pending') { writeStarted(); await waiting }
      data.set(key, value)
    }, delete: async (key: string) => data.delete(key) }
  const cache = createRetrievalCache(table)
  const write = cache.set('pending', 'old vector')
  await started
  const clearing = cache.clear()
  const subsequent = cache.set('fresh', 'new vector')
  completeWrite()
  await Promise.all([write, clearing, subsequent])
  assert.deepEqual([...data.keys()], ['fresh'])
  const restored = createRetrievalCache(table)
  assert.equal(await restored.get('restored'), undefined)
  assert.equal(await restored.get('pending'), undefined)
  assert.equal(await restored.get('fresh'), 'new vector')
  await restored.clear()
  await restored.clear()
  assert.equal(data.size, 0)
  await cache.dispose(); await restored.dispose()
})

test('a failed deletion is observable and a later clear retries remaining records', async () => {
  const data = new Map<string, RetrievalCacheRecord>([['a', { createdAt: Date.now(), payload: 'page' }],
    ['b', { createdAt: Date.now(), payload: [1, 0] }]])
  let fail = true
  const cache = createRetrievalCache({ get: (key: string) => data.get(key), entries: () => data.entries(),
    put: async (key: string, value: RetrievalCacheRecord) => { data.set(key, value) },
    delete: async (key: string) => { if (key === 'b' && fail) throw new Error('delete failed'); return data.delete(key) } })
  await assert.rejects(cache.clear(), /delete failed/)
  assert.deepEqual([...data.keys()], ['b'])
  fail = false
  await cache.clear()
  assert.equal(data.size, 0)
  await cache.set('c', 'new')
  assert.equal(await cache.get('c'), 'new')
  await cache.dispose()
})
