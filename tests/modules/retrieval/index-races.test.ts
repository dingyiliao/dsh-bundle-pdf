import assert from 'node:assert/strict'
import { buildIndexPageEntries } from '../../../src/modules/retrieval/stored-index.ts'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { encodeCachedVector } from '../../../src/modules/retrieval/cache.ts'
import { chunkRetrievalPage } from '../../../src/modules/retrieval/text.ts'
import type { StoredIndexPage } from '../../../src/modules/retrieval/stored-index.ts'
import type { RetrievalCache, RetrievalEmbedding, RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function fixture(overrides: {
  get?(key: string, value: unknown): Promise<unknown>
  set?(key: string, value: unknown): Promise<void>
  embed?: RetrievalEmbedding['embed']
  read?: RetrievalPorts['pages']['read']
} = {}) {
  const records = new Map<string, unknown>()
  let reads = 0
  const cache: RetrievalCache = {
    async get(key) {
      const value = structuredClone(records.get(key))
      return overrides.get ? overrides.get(key, value) : value
    },
    async set(key, value) {
      records.set(key, structuredClone(value))
      await overrides.set?.(key, value)
    },
  }
  const provider: RetrievalEmbedding = { fingerprint: 'shared-race-model', dimensions: 2, maxBatchSize: 8,
    embed: overrides.embed ?? (async texts => texts.map(() => [1, 0])),
  }
  const ports: RetrievalPorts = { cache,
    documents: { snapshot() { return { id: 'document', path: '/synthetic/index-races.pdf',
      sourceDigest: 'same-source-bytes', contentVersion: 'same-content', pageCount: 1 } } },
    pages: { async read(sessionId, documentId, page, signal) {
      reads++
      return overrides.read?.(sessionId, documentId, page, signal)
        ?? { text: 'One durable searchable evidence paragraph.', source: 'pdf-text' }
    } },
    embedding: { select: () => provider },
  }
  return { records, cache, provider, ports, reads: () => reads,
    head: () => [...records.values()].find(value => value && typeof value === 'object' && 'key' in value) as {
      active?: { id: string; rebuildToken?: string }; pending?: { id: string; rebuildToken?: string }
    } | undefined }
}

test('head publication serializes an older promotion with a concurrent forced generation across runtimes', { timeout: 5000 }, async () => {
  const oldPromotion = gate(), releaseOld = gate()
  let captured = false, replacementPublished = false
  const f = fixture({
    async get(key, value) {
      const head = value as { active?: unknown; pending?: unknown } | undefined
      if (key.startsWith('index_head_') && head?.pending && !head.active && !captured) {
        captured = true; oldPromotion.release(); await releaseOld.promise
      }
      return value
    },
    async set(key, value) {
      if (key.startsWith('index_head_') && (value as { pending?: { rebuildToken?: string } }).pending?.rebuildToken === 'newer-rebuild') {
        replacementPublished = true
      }
    },
  })
  const old = createRetrievalService(f.ports), newer = createRetrievalService(f.ports)
  const first = old.search('reader', { documentId: 'document', query: 'evidence', mode: 'semantic' })
  void first.catch(() => {})
  let second: Promise<void> | undefined
  try {
    await oldPromotion.promise
    second = newer.prepare('reader', { documentId: 'document', rebuild: true, rebuildToken: 'newer-rebuild' })
    void second.catch(() => {})
    await turn(); await turn()
    assert.equal(replacementPublished, false, 'head read/modify/write must use one transaction across runtime instances')
    releaseOld.release()
    assert.equal((await first).status, 'complete')
    await second
    assert.equal(f.head()?.active?.rebuildToken, 'newer-rebuild')
    assert.equal(f.head()?.pending, undefined)
  } finally {
    releaseOld.release()
    await Promise.allSettled([first, ...(second ? [second] : [])])
    await old.dispose(); await newer.dispose()
  }
})

test('an older seeded generation can finish without deleting a newer pending rebuild', { timeout: 5000 }, async () => {
  const oldStarted = gate(), newStarted = gate(), releaseOld = gate(), releaseNew = gate()
  let documentCalls = 0
  const f = fixture({ async embed(texts, purpose) {
    if (purpose === 'document') {
      const call = ++documentCalls
      if (call === 1) { oldStarted.release(); await releaseOld.promise }
      if (call === 2) { newStarted.release(); await releaseNew.promise }
    }
    return texts.map(() => [1, 0])
  } })
  const old = createRetrievalService(f.ports), newer = createRetrievalService(f.ports)
  const first = old.search('reader', { documentId: 'document', query: 'evidence', mode: 'semantic' })
  void first.catch(() => {})
  let second: Promise<void> | undefined
  try {
    await oldStarted.promise
    second = newer.prepare('reader', { documentId: 'document', rebuild: true, rebuildToken: 'newer-rebuild' })
    void second.catch(() => {})
    await newStarted.promise
    const pendingId = f.head()?.pending?.id
    assert.ok(pendingId)
    releaseOld.release()
    assert.equal((await first).status, 'complete')
    assert.equal(f.head()?.pending?.id, pendingId, 'publishing an accepted seed must preserve the newer pending head')
    assert.ok(f.head()?.active)
    releaseNew.release()
    await second
    assert.equal(f.head()?.active?.id, pendingId)
    assert.equal(f.head()?.active?.rebuildToken, 'newer-rebuild')
  } finally {
    releaseOld.release(); releaseNew.release()
    await Promise.allSettled([first, ...(second ? [second] : [])])
    await old.dispose(); await newer.dispose()
  }
})

test('a missing incomplete page checkpoint is repaired by normal resume without rereading cached content', async () => {
  let unavailable = true, successfulBatches = 0
  const f = fixture({ async embed(texts) {
    if (unavailable) throw Object.assign(new Error('temporary engine connection failure'), { code: 'ECONNRESET' })
    successfulBatches++
    return texts.map(() => [1, 0])
  } })
  const service = createRetrievalService(f.ports)
  try {
    await assert.rejects(service.prepare('reader', { documentId: 'document' }))
    assert.equal(f.reads(), 1)
    const checkpoint = [...f.records.keys()].find(key => key.startsWith('index_page_'))
    assert.ok(checkpoint)
    f.records.delete(checkpoint)
    unavailable = false
    try { await service.prepare('reader', { documentId: 'document' }) }
    catch (error) { assert.equal((error as { code?: string }).code, 'pdf/index-storage-missing') }
    await service.prepare('reader', { documentId: 'document' })
    assert.ok([...f.records.keys()].some(key => key.startsWith('index_page_')))
    assert.equal(f.reads(), 1, 'the durable independent page cache must supply the replacement checkpoint')
    assert.equal(successfulBatches, 1)
  } finally { await service.dispose() }
})

test('an external same-generation page replacement rejects stale coverage before delivering new chunks', { timeout: 5000 }, async () => {
  const queryStarted = gate(), releaseQuery = gate()
  let holdQuery = true
  const f = fixture({ async embed(texts, purpose) {
    if (purpose === 'query' && holdQuery) {
      holdQuery = false; queryStarted.release(); await releaseQuery.promise
    }
    return texts.map(() => [1, 0])
  } })
  const service = createRetrievalService(f.ports)
  let query: ReturnType<typeof service.search> | undefined
  try {
    await service.prepare('reader', { documentId: 'document' })
    query = service.search('reader', { documentId: 'document', query: 'updated evidence', mode: 'semantic' })
    void query.catch(() => {})
    await queryStarted.promise
    const entry = [...f.records].find(([key]) => key.startsWith('index_page_'))
    assert.ok(entry)
    const [key, original] = entry as [string, StoredIndexPage]
    const content: StoredIndexPage['content'] = { version: 1, source: 'ocr',
      text: 'Updated evidence from the repaired page.\n\nAdditional recovered evidence.' }
    const chunks = chunkRetrievalPage(1, content)
    assert.equal(chunks.length, 2)
    // Simulate another runtime atomically repairing a shard. It does not touch
    // this service's in-memory dataRevision or its captured one-chunk coverage.
    const head = [...f.records.values()].find(value => value && typeof value === 'object' && 'key' in value) as { key: string }
    const replacement: StoredIndexPage = { version: 1, page: 1, generation: original.generation, content,
      vectors: Object.fromEntries(chunks.map(chunk => [chunk.id, encodeCachedVector([1, 0])])) }
    for (const [recordKey, value] of buildIndexPageEntries(head.key, original.generation, replacement, chunks).entries) await f.cache.set(recordKey, value)
    assert.ok(f.records.has(key))
    releaseQuery.release()
    await assert.rejects(query, { code: 'pdf/stale-reader',
      message: 'PDF index data changed during this search. Retry the query.' })
    const recovered = await service.search('reader', { documentId: 'document', query: 'updated evidence', mode: 'semantic' })
    assert.equal(recovered.status, 'complete')
    assert.equal(recovered.indexGeneration, original.generation)
    assert.equal(recovered.coverage.indexedPages, 1)
    assert.equal(recovered.coverage.totalChunks, 2)
    assert.equal(recovered.coverage.embeddedChunks, 2)
    assert.deepEqual(new Set(recovered.chunks.map(chunk => chunk.text)), new Set(chunks.map(chunk => chunk.text)))
    assert.equal(f.reads(), 1, 'refreshing a summary must not re-extract the original document')
  } finally {
    releaseQuery.release()
    if (query) await Promise.allSettled([query])
    await service.dispose()
  }
})

test('unrelated cache and Session metadata writes do not invalidate an immutable search index', { timeout: 5000 }, async () => {
  const queryStarted = gate(), releaseQuery = gate()
  let holdQuery = false
  const f = fixture({ async embed(texts, purpose) {
    if (purpose === 'query' && holdQuery) {
      holdQuery = false; queryStarted.release(); await releaseQuery.promise
    }
    return texts.map(() => [1, 0])
  } })
  const service = createRetrievalService(f.ports)
  let query: ReturnType<typeof service.search> | undefined
  try {
    await service.prepare('reader', { documentId: 'document' })
    holdQuery = true
    query = service.search('reader', { documentId: 'document', query: 'evidence', mode: 'semantic' })
    void query.catch(() => {})
    await queryStarted.promise
    await f.cache.set('other-document-page-cache', { text: 'Independent cached page' })
    await f.cache.set('other-session-reader-state', { selectedPage: 10 })
    releaseQuery.release()
    const result = await query
    assert.equal(result.status, 'complete')
    assert.equal(result.chunks.length, 1)
    assert.match(result.chunks[0]!.text, /durable searchable evidence/)
  } finally {
    releaseQuery.release()
    if (query) await Promise.allSettled([query])
    await service.dispose()
  }
})

test('retrying only failure metadata during a semantic query preserves unchanged indexed evidence', { timeout: 5000 }, async () => {
  const queryStarted = gate(), releaseQuery = gate()
  let holdQuery = false
  const f = fixture({
    async read() { return { text: 'One durable searchable evidence paragraph.', source: 'pdf-text',
      failure: { code: 'pdf/index-image-unavailable' } } },
    async embed(texts, purpose) {
      if (purpose === 'query' && holdQuery) {
        holdQuery = false; queryStarted.release(); await releaseQuery.promise
      }
      return texts.map(() => [1, 0])
    },
  })
  const service = createRetrievalService(f.ports)
  let query: ReturnType<typeof service.search> | undefined
  try {
    const initial = await service.search('reader', { documentId: 'document', query: 'evidence', mode: 'semantic' })
    assert.equal(initial.status, 'incomplete')
    assert.equal(initial.coverage.failedPages[0]?.attempts, 1)
    assert.equal(initial.chunks.length, 1, 'partial visual enrichment must retain searchable native evidence')
    const generation = initial.indexGeneration
    holdQuery = true
    query = service.search('reader', { documentId: 'document', query: 'evidence', mode: 'semantic' })
    void query.catch(() => {})
    await queryStarted.promise
    await assert.rejects(service.prepare('reader', { documentId: 'document' }), { code: 'pdf/retrieval-incomplete' })
    assert.equal(f.reads(), 2, 'background preparation retries the page while query embedding is suspended')
    releaseQuery.release()
    const result = await query
    assert.equal(result.status, 'incomplete')
    assert.equal(result.indexGeneration, generation)
    assert.deepEqual(result.chunks.map(chunk => chunk.text), initial.chunks.map(chunk => chunk.text))
  } finally {
    releaseQuery.release()
    if (query) await Promise.allSettled([query])
    await service.dispose()
  }
})
