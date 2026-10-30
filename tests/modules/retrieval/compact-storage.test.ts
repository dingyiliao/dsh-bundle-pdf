import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { compactRetrievalVector } from '../../../src/modules/retrieval/vector.ts'
import { cosineSimilarity, rankVectors } from '../../../src/modules/retrieval/ranking.ts'
import { chunkPage, tokenizeRetrievalText } from '../../../src/modules/retrieval/text.ts'
import type { RetrievalEmbedding, RetrievalPorts } from '../../../src/modules/retrieval/types.ts'
import { createRetrievalCache, type RetrievalCacheRecord } from '../../../src/adapters/host/storage/retrieval-cache.ts'

function fixture(text: string[], options: { dimensions?: number; limits?: RetrievalPorts['limits']; cache?: boolean } = {}) {
  const dimensions = options.dimensions ?? 1024
  const calls: Array<{ purpose: string; texts: string[] }> = []
  const cached = new Map<string, unknown>()
  const provider: RetrievalEmbedding = {
    fingerprint: 'compact-fixture-v1', dimensions, maxBatchSize: 16, maxInputCharacters: 1200,
    async embed(texts, purpose) {
      calls.push({ purpose, texts: [...texts] })
      return texts.map(value => {
        const vector = new Array<number>(dimensions).fill(0)
        vector[purpose === 'query' || value.includes('needle-target') ? 0 : 1] = 1
        return vector
      })
    },
  }
  const ports: RetrievalPorts = {
    documents: { snapshot: () => ({ id: 'doc', path: '/compact-synthetic.pdf', sourceDigest: 'source',
      contentVersion: 'source', pageCount: text.length }) },
    pages: { async read(_session, _document, page) { return { text: text[page - 1]!, source: 'pdf-text' } } },
    embedding: { select: () => provider }, limits: options.limits,
    ...(options.cache ? { cache: { async get(key: string) { return cached.get(key) },
      async set(key: string, value: unknown) { cached.set(key, structuredClone(value)) } } } : {}),
  }
  return { service: createRetrievalService(ports), ports, provider, calls, cached }
}

test('compact normalized vectors preserve cosine geometry for finite values at both numeric extremes', () => {
  for (const input of [[1e308, -1e308, 1e307], [1e-308, -1e-308, 1e-309], [Number.MIN_VALUE, -Number.MIN_VALUE, 0]]) {
    const before = [...input], stored = compactRetrievalVector(input)
    assert.ok(stored instanceof Float32Array)
    assert.equal(stored.byteLength, input.length * 4)
    assert.ok([...stored].every(Number.isFinite))
    assert.ok([...stored].some(value => value !== 0))
    assert.ok(Math.abs(cosineSimilarity(input, stored) - 1) < 1e-7)
    assert.deepEqual(input, before)
    assert.equal(rankVectors(input, [{ chunkId: 'same', vector: stored },
      { chunkId: 'opposite', vector: Float32Array.from(stored, value => -value) }], 1)[0]!.chunkId, 'same')
  }
  for (const invalid of [[], [0, 0], [Infinity, 1], [NaN, 1]]) assert.throws(() => compactRetrievalVector(invalid))
})

test('lexical accounting charges repeated terms once while preserving genuine memory protection', async () => {
  const f = fixture(['cat '.repeat(200)], { dimensions: 2, limits: { maxMemoryBytes: 4096 } })
  f.ports.embedding = undefined
  try {
    const result = await f.service.search('session', { documentId: 'doc', query: 'cat', mode: 'lexical' })
    assert.equal(result.status, 'complete')
    assert.equal(result.chunks.length, 1)
    assert.ok(result.chunks[0]!.score > 0)
  } finally { await f.service.dispose() }
  const oversized = fixture([Array.from({ length: 100 }, (_, index) => `term${index}`).join(' ')],
    { dimensions: 2, limits: { maxMemoryBytes: 4096 } })
  try { await assert.rejects(oversized.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-budget' }) }
  finally { await oversized.service.dispose() }
})

test('equal text shares compact vectors across steps and cache hits without losing per-chunk coverage', async () => {
  const text = 'A repeated heading describes the same feature representation.', pages = 8
  const chunk = chunkPage(1, text)[0]!
  const pageBytes = 128 + chunk.text.length * 2 + 320 + new Set(tokenizeRetrievalText(chunk.text)).size * 96
  const budget = pageBytes * pages + 1024 * 4 + 512
  const f = fixture(new Array<string>(pages).fill(text), { cache: true,
    limits: { pagesPerStep: 1, maxMemoryBytes: budget } })
  try {
    await f.service.prepare('session', { documentId: 'doc' })
    assert.equal(f.calls.filter(call => call.purpose === 'document').flatMap(call => call.texts).length, 1)
    const result = await f.service.search('session', { documentId: 'doc', query: 'repeated heading', mode: 'semantic', topK: 20 })
    assert.equal(result.status, 'complete')
    assert.equal(result.coverage.embeddedChunks, pages)
    assert.equal(result.chunks.length, pages)
    assert.equal(new Set(result.chunks.map(chunk => chunk.page)).size, pages)
    const vectorRecords = [...f.cached.values()].filter((value): value is { encoding: string; dimensions: number } =>
      Boolean(value && typeof value === 'object' && 'encoding' in value && value.encoding === 'float32-le-base64'))
    assert.equal(vectorRecords.length, 1)
    assert.equal(vectorRecords[0]!.dimensions, 1024, 'persistent vectors keep the complete Float32 dimensions')
    const restored = createRetrievalService(f.ports)
    const before = f.calls.filter(call => call.purpose === 'document').length
    try {
      await restored.prepare('session', { documentId: 'doc' })
      assert.equal(f.calls.filter(call => call.purpose === 'document').length, before)
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
  const limited = fixture([text], { limits: { maxMemoryBytes: pageBytes + 1024 * 4 - 1 } })
  try { await assert.rejects(limited.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-budget' }) }
  finally { await limited.service.dispose() }
})

test('dense vectors survive bounded persistent-cache recreation without rereading pages or calling embedding', async () => {
  const text = Array.from({ length: 128 }, (_, index) => `Passage ${index + 1}: a distinct page of a synthetic long book.`)
  const data = new Map<string, RetrievalCacheRecord>()
  const table = { get: (key: string) => data.get(key), entries: () => data.entries(),
    put: async (key: string, value: RetrievalCacheRecord) => { data.set(key, value) },
    delete: async (key: string) => data.delete(key) }
  // Scaled-down disk budget reproduces the long-book failure: JSON arrays for
  // these dense vectors exceed this budget, while complete Float32 data fits.
  const options = { maxBytes: 1024 * 1024, maxRecords: 512, now: () => 1 }
  const firstCache = createRetrievalCache(table, options), f = fixture(text)
  f.ports.cache = firstCache
  f.provider.embed = async (texts, purpose) => {
    f.calls.push({ purpose, texts: [...texts] })
    return texts.map(() => Array.from({ length: 1024 }, (_, index) => Math.sin(index + 0.25)))
  }
  try {
    await f.service.prepare('session', { documentId: 'doc' })
    assert.equal(f.calls.flatMap(call => call.texts).length, text.length)
    assert.equal(data.size, text.length * 2, 'all page and vector records must survive the bounded cache')
    const bytes = [...data.values()].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
    assert.ok(bytes < options.maxBytes)
    await f.service.dispose(); await firstCache.dispose()
    const restoredCache = createRetrievalCache(table, options)
    f.ports.cache = restoredCache
    f.ports.pages.read = async () => { throw new Error('A restored page must not reread its source') }
    f.provider.embed = async () => { throw new Error('A restored vector must not contact the embedding service') }
    const restored = createRetrievalService(f.ports)
    try {
      await restored.prepare('new-session', { documentId: 'doc' })
      assert.equal(data.size, text.length * 2)
      assert.equal(f.calls.flatMap(call => call.texts).length, text.length)
    } finally { await restored.dispose(); await restoredCache.dispose() }
  } finally { await f.service.dispose(); await firstCache.dispose() }
})

test('a 1151-page 6677-chunk book prepares under the unchanged memory budget and searches the final page', async () => {
  const totalChunks = 6677, pages = 1151, text: string[] = []
  let ordinal = 0
  for (let page = 0; page < pages; page++) {
    const count = Math.floor(totalChunks / pages) + (page < totalChunks % pages ? 1 : 0)
    text.push(Array.from({ length: count }, () => `Passage ${++ordinal}. `
      + 'Neural networks learn useful features through gradient descent and attention. Every layer transforms an input representation with learned weights to predict an observed target. '.repeat(3)
      + (ordinal === totalChunks ? 'needle-target' : '')).join('\n\n'))
  }
  const f = fixture(text)
  try {
    await f.service.prepare('session', { documentId: 'doc' })
    assert.equal(f.calls.filter(call => call.purpose === 'query').length, 0)
    assert.equal(f.calls.filter(call => call.purpose === 'document').flatMap(call => call.texts).length, totalChunks)
    const before = f.calls.length
    const result = await f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    assert.equal(result.status, 'complete')
    assert.equal(result.coverage.indexedPages, pages)
    assert.equal(result.coverage.embeddedChunks, totalChunks)
    assert.equal(result.chunks[0]!.page, pages)
    assert.ok(result.chunks[0]!.text.includes('needle-target'))
    assert.deepEqual(f.calls.slice(before).map(call => call.purpose), ['query'])
  } finally { await f.service.dispose() }
})
