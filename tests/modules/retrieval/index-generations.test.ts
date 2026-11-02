import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { storedIndexPageKey } from '../../../src/modules/retrieval/stored-index.ts'
import { isIndexGenerationRetained } from '../../../src/modules/retrieval/index-transaction.ts'
import type { RetrievalCache, RetrievalEmbedding, RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

interface Head {
  key: string
  active?: { id: string; rebuildToken?: string }
  pending?: { id: string; rebuildToken?: string }
  seeds?: Array<{ id: string }>
  retired?: Array<{ id: string }>
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function fixture(pageCount = 3) {
  const records = new Map<string, unknown>(), deleted: string[] = []
  let sourceReads = 0, documentEmbeds = 0
  let beforeDelete: ((key: string) => Promise<void>) | undefined
  let beforeQuery: (() => Promise<void>) | undefined
  let afterWrite: ((key: string, value: unknown) => void) | undefined
  const cache: RetrievalCache & { delete(key: string): Promise<void> } = {
    async get(key) { return structuredClone(records.get(key)) },
    async set(key, value) { records.set(key, structuredClone(value)); afterWrite?.(key, value) },
    async delete(key) { await beforeDelete?.(key); records.delete(key); deleted.push(key) },
  }
  const provider: RetrievalEmbedding = { fingerprint: 'generation-model', dimensions: 2, maxBatchSize: 8,
    async embed(texts, purpose) {
      if (purpose === 'document') documentEmbeds += texts.length
      else await beforeQuery?.()
      return texts.map(() => [1, 0])
    },
  }
  const ports: RetrievalPorts = { cache,
    documents: { snapshot() { return { id: 'document', path: '/synthetic/index-generations.pdf',
      sourceDigest: 'same-source-bytes', contentVersion: 'same-content', pageCount } } },
    pages: { async read(_session, _document, page) {
      sourceReads++; return { text: `Durable independent paragraph for page ${page}.`, source: 'pdf-text' }
    } },
    embedding: { select: () => provider }, limits: { maxIndexes: 2 },
  }
  const head = () => [...records.values()].find(value => value && typeof value === 'object' && 'key' in value) as Head
  const pageKeys = (generation: string) => Array.from({ length: pageCount }, (_, page) => storedIndexPageKey(head().key, generation, page + 1))
  return { ports, records, deleted, head, pageKeys,
    countPageShards: () => [...records.keys()].filter(key => key.startsWith('index_page_')).length,
    sourceReads: () => sourceReads, documentEmbeds: () => documentEmbeds,
    setBeforeDelete(value: typeof beforeDelete) { beforeDelete = value },
    setBeforeQuery(value: typeof beforeQuery) { beforeQuery = value },
    setAfterWrite(value: typeof afterWrite) { afterWrite = value },
  }
}

test('repeated unchanged rebuilds collect retired page generations while reusing independent content and vector caches', async () => {
  const f = fixture(), first = createRetrievalService(f.ports)
  let reopened: ReturnType<typeof createRetrievalService> | undefined
  try {
    await first.prepare('reader', { documentId: 'document' })
    for (let revision = 0; revision < 10; revision++) {
      await first.prepare('reader', { documentId: 'document', rebuild: true, rebuildToken: `rebuild-${revision}` })
    }
    assert.equal(f.sourceReads(), 3)
    assert.equal(f.documentEmbeds(), 3)
    assert.equal(f.head().active?.rebuildToken, 'rebuild-9')
    await first.dispose()
    reopened = createRetrievalService(f.ports)
    await reopened.prepare('new-reader', { documentId: 'document' })
    assert.equal(f.countPageShards(), 3, 'unreferenced generations must not accumulate another copy of every PDF page')
    assert.equal(f.head().retired?.length ?? 0, 0)
    assert.equal(f.head().pending, undefined)
    assert.ok(f.deleted.length >= 30)
    assert.equal(f.sourceReads(), 3)
    assert.equal(f.documentEmbeds(), 3)
  } finally { await first.dispose(); await reopened?.dispose() }
})

test('shutdown at asynchronous head-publication boundaries does not leave a generation pinned after one disposal', async () => {
  // Sweep microtask boundaries around completion of the external durable write;
  // the test never needs to know when the service constructs its metadata.
  for (let depth = 0; depth <= 8; depth++) {
    const f = fixture(1), service = createRetrievalService(f.ports)
    let disposal: Promise<void> | undefined, scheduled = false
    const schedule = (remaining: number): void => queueMicrotask(() => {
      if (remaining) schedule(remaining - 1)
      else disposal = service.dispose()
    })
    f.setAfterWrite(key => {
      if (key.startsWith('index_head_') && !scheduled) { scheduled = true; schedule(depth) }
    })
    try {
      await assert.rejects(service.prepare('reader', { documentId: 'document' }), { code: 'pdf/cancelled' })
      assert.ok(disposal, `the durable-write shutdown hook must run at boundary ${depth}`)
      await disposal
      const head = f.head(), generation = head.active ?? head.pending
      assert.ok(generation)
      assert.equal(isIndexGenerationRetained(f.ports.cache!, head.key, generation.id), false,
        `one complete disposal must release every admitted generation at boundary ${depth}`)
    } finally {
      // A second dispose could mask leaked late-created metadata. Only call it
      // when the injected shutdown has not already requested disposal.
      if (disposal) await disposal
      else await service.dispose()
    }
  }
})

test('a running query and its cached metadata pin the old generation until drain and disposal', { timeout: 5000 }, async () => {
  const f = fixture(), old = createRetrievalService(f.ports), newer = createRetrievalService(f.ports)
  const queryStarted = gate(), releaseQuery = gate()
  let query: ReturnType<typeof old.search> | undefined
  try {
    await old.prepare('reader', { documentId: 'document' })
    const oldGeneration = f.head().active!.id, oldPages = f.pageKeys(oldGeneration)
    f.setBeforeQuery(async () => { queryStarted.release(); await releaseQuery.promise })
    query = old.search('reader', { documentId: 'document', query: 'paragraph', mode: 'semantic' })
    void query.catch(() => {})
    await queryStarted.promise
    await newer.prepare('reader', { documentId: 'document', rebuild: true, rebuildToken: 'new-pending-generation' })
    assert.notEqual(f.head().active?.id, oldGeneration)
    assert.ok(oldPages.every(key => f.records.has(key)), 'promotion must not delete shards in use by an old query')
    releaseQuery.release()
    const result = await query
    assert.equal(result.status, 'complete')
    assert.equal(result.indexGeneration, oldGeneration)
    assert.ok(oldPages.every(key => f.records.has(key)), 'an idle cached runtime still owns its generation pin')
    await old.dispose()
    await newer.prepare('reader', { documentId: 'document' })
    assert.ok(oldPages.every(key => !f.records.has(key)))
    assert.equal(f.countPageShards(), 3)
    assert.equal(f.documentEmbeds(), 3)
  } finally {
    releaseQuery.release()
    if (query) await Promise.allSettled([query])
    await old.dispose(); await newer.dispose()
  }
})

test('failed retired-shard deletion preserves a retry marker and the active generation', async () => {
  const f = fixture(), old = createRetrievalService(f.ports), newer = createRetrievalService(f.ports)
  try {
    await old.prepare('reader', { documentId: 'document' })
    const retiredGeneration = f.head().active!.id
    await newer.prepare('reader', { documentId: 'document', rebuild: true, rebuildToken: 'replacement' })
    const activeGeneration = f.head().active!.id, activePages = f.pageKeys(activeGeneration)
    await old.dispose()
    let attempts = 0
    const diagnosticCodes: unknown[] = []
    f.ports.onFailure = (_session, _document, error) => { diagnosticCodes.push((error as { code?: string }).code) }
    f.setBeforeDelete(async () => {
      attempts++
      if (attempts >= 2) throw Object.assign(new Error('simulated filesystem deletion failure'), { code: 'pdf/index-storage-delete-failed' })
    })
    await newer.prepare('reader', { documentId: 'document' })
    assert.equal(attempts, 2, 'the fault must occur after a useful deletion, not before collection starts')
    assert.equal(f.head().active?.id, activeGeneration)
    assert.ok(activePages.every(key => f.records.has(key)))
    assert.ok(f.head().retired?.some(generation => generation.id === retiredGeneration), 'partially cleaned generations remain retryable')
    const result = await newer.search('reader', { documentId: 'document', query: 'paragraph', mode: 'semantic' })
    assert.equal(result.status, 'complete', 'a cleanup failure must not fail a valid active index')
    assert.equal(result.indexGeneration, activeGeneration)
    assert.ok(diagnosticCodes.includes('pdf/index-storage-delete-failed'))
    f.setBeforeDelete(undefined)
    await newer.prepare('reader', { documentId: 'document' })
    assert.equal(f.head().active?.id, activeGeneration)
    assert.equal(f.head().retired?.length ?? 0, 0)
    assert.equal(f.countPageShards(), 3)
    assert.equal(f.documentEmbeds(), 3)
  } finally { await old.dispose(); await newer.dispose() }
})
