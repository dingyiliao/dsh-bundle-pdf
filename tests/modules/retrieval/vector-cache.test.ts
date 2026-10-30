import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encodeCachedVector, readCachedVector } from '../../../src/modules/retrieval/cache.ts'
import { cosineSimilarity } from '../../../src/modules/retrieval/ranking.ts'
import type { RetrievalCache } from '../../../src/modules/retrieval/types.ts'

function cacheWith(value: unknown) {
  const stored = new Map<string, unknown>([['vector', structuredClone(value)]])
  let writes = 0
  const cache: RetrievalCache = { async get(key) { return structuredClone(stored.get(key)) },
    async set(key, record) { writes++; stored.set(key, structuredClone(record)) } }
  return { cache, stored, writes: () => writes }
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('compact vectors round-trip through JSON in explicit little-endian Float32 format without changing ranking', async () => {
  const input = [3, 4], record = encodeCachedVector(input)
  assert.deepEqual(input, [3, 4])
  assert.deepEqual(record, { version: 1, encoding: 'float32-le-base64', dimensions: 2,
    data: Buffer.from('9a99193fcdcc4c3f', 'hex').toString('base64'),
    sha256: digest(Buffer.from('9a99193fcdcc4c3f', 'hex')) })
  const f = cacheWith(JSON.parse(JSON.stringify(record)))
  const restored = await readCachedVector(f.cache, 'vector', 2)
  assert.deepEqual(restored, [Math.fround(0.6), Math.fround(0.8)])
  assert.ok(Math.abs(cosineSimilarity(input, restored!) - 1) < 1e-7)
  assert.equal(f.writes(), 0, 'current-format cache hits need no disk rewrite')
  restored![0] = -1
  assert.deepEqual(await readCachedVector(f.cache, 'vector', 2), [Math.fround(0.6), Math.fround(0.8)])
})

test('normalization before serialization preserves finite very large and subnormal vectors', async () => {
  for (const input of [[1e308, -1e308, 1e307], [1e-308, -1e-308, 1e-309], [Number.MIN_VALUE, -Number.MIN_VALUE, 0]]) {
    const f = cacheWith(encodeCachedVector(input)), restored = await readCachedVector(f.cache, 'vector', input.length)
    assert.ok(restored)
    assert.ok(restored.every(Number.isFinite))
    assert.ok(Math.abs(cosineSimilarity(input, restored) - 1) < 1e-7)
  }
  for (const invalid of [[], [0, 0], [NaN, 1], [Infinity, 1]]) assert.throws(() => encodeCachedVector(invalid))
})

test('valid legacy arrays migrate to compact records without any embedding call or mutating the caller', async () => {
  const input = [3, 4], f = cacheWith(input)
  assert.deepEqual(await readCachedVector(f.cache, 'vector', 2), input)
  assert.deepEqual(input, [3, 4])
  assert.deepEqual(f.stored.get('vector'), encodeCachedVector(input))
  assert.equal(f.writes(), 1)
  const restored = await readCachedVector(f.cache, 'vector', 2)
  assert.ok(restored)
  assert.ok(Math.abs(cosineSimilarity(input, restored) - 1) < 1e-7)
  assert.equal(f.writes(), 1, 'the same entry is migrated once')
})

test('cache failures are misses and a failed best-effort migration does not discard a usable vector', async () => {
  assert.equal(await readCachedVector(undefined, 'vector', 2), undefined)
  assert.equal(await readCachedVector({ async get() { throw new Error('offline') }, async set() {} }, 'vector', 2), undefined)
  assert.deepEqual(await readCachedVector({ async get() { return [3, 4] }, async set() { throw new Error('full') } }, 'vector', 2), [3, 4])
})

test('corrupt vector records, unknown formats and dimension mismatches are safe misses', async () => {
  const good = encodeCachedVector([3, 4])
  const invalid: unknown[] = [null, [], [0, 0], [Infinity, 1], ['1', 0], [1, 0, 0],
    { ...good, version: 2 }, { ...good, encoding: 'float32-be-base64' }, { ...good, dimensions: 3 },
    { ...good, extra: true }, { ...good, sha256: '0'.repeat(64) }, { ...good, data: good.data.slice(0, -1) },
    { ...good, data: `!${good.data.slice(1)}` }, { ...good, data: `${good.data}\n` },
  ]
  // Recompute checksums too: structural validation must not trust arbitrary
  // finite bytes merely because their digest is well formed.
  for (const values of [[0, 0], [NaN, 1], [Infinity, 0], [0.2, 0.2]]) {
    const bytes = Buffer.alloc(8)
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4))
    invalid.push({ ...good, data: bytes.toString('base64'), sha256: digest(bytes) })
  }
  // A finite bit flip that would pass numeric validation is caught by checksum.
  const changed = Buffer.from(good.data, 'base64'); changed[0] ^= 1
  invalid.push({ ...good, data: changed.toString('base64') })
  for (const value of invalid) {
    const f = cacheWith(value)
    assert.equal(await readCachedVector(f.cache, 'vector', 2), undefined)
    assert.equal(f.writes(), 0)
  }
  for (const dimensions of [0, 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await readCachedVector(cacheWith(good).cache, 'vector', dimensions), undefined)
  }
})

test('1024-dimensional dense vectors fit a 6677-chunk book within the existing disk budget', () => {
  const input = Array.from({ length: 1024 }, (_, index) => Math.sin(index + 0.25) / Math.sqrt(512))
  const legacyBytes = Buffer.byteLength(JSON.stringify({ createdAt: 1, payload: input }))
  const compactBytes = Buffer.byteLength(JSON.stringify({ createdAt: 1, payload: encodeCachedVector(input) }))
  assert.ok(compactBytes < legacyBytes * 0.3, `${legacyBytes} -> ${compactBytes} serialized bytes per vector`)
  assert.ok(legacyBytes * 6677 > 64 * 1024 * 1024)
  assert.ok(compactBytes * 6677 < 40 * 1024 * 1024, 'leave space for page text inside the unchanged 64 MiB cache')
})
