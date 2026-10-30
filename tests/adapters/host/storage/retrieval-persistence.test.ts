import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createRetrievalCache, retrievalCacheRecordSchema } from '../../../../src/adapters/host/storage/retrieval-cache.ts'
import { retrievalCacheKey } from '../../../../src/modules/retrieval/cache.ts'
import { createRetrievalService } from '../../../../src/modules/retrieval/service.ts'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalPorts } from '../../../../src/modules/retrieval/types.ts'

/** The production domain and JSON backend, with an isolated durable root. */
async function openDiskCache(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const domain = await facility.open(defineDomain({ name: 'pdf_retrieval_regression', version: 1,
    layout: 'per-record', tables: { cache: domainTable(retrievalCacheRecordSchema) } }))
  const table = domain.table('cache'), cache = createRetrievalCache(table)
  return { cache, table, async close() {
    await cache.dispose()
    await facility.closeAll()
    unregister()
    await backend.close()
    await ctx.fiber.dispose()
  } }
}

test('retrieval cache keys satisfy DSH per-record storage and survive closing every storage owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-retrieval-keys-'))
  let storage: Awaited<ReturnType<typeof openDiskCache>> | undefined
  try {
    storage = await openDiskCache(root)
    const key = retrievalCacheKey('page', 'source', 1)
    assert.match(key, /^[A-Za-z0-9_-]+$/)
    // The old colon-prefixed keys were accepted by Map test doubles but rejected
    // by this actual backend. cacheDerived swallowed those failed writes.
    await assert.rejects(storage.table.put(`retrieval:${'a'.repeat(64)}`, { createdAt: Date.now(), payload: 'old key' }),
      /per-record key .* is not path-safe/)
    await storage.cache.set(key, { source: 'pdf-text', text: 'Synthetic searchable page.' })
    assert.deepEqual(await readdir(join(root, 'pdf_retrieval_regression', 'cache')), [`${key}.json`])
    await storage.close(); storage = undefined
    storage = await openDiskCache(root)
    assert.deepEqual(await storage.cache.get(key), { source: 'pdf-text', text: 'Synthetic searchable page.' })
    await storage.cache.clear()
    assert.deepEqual(await readdir(join(root, 'pdf_retrieval_regression', 'cache')), [])
  } finally { await storage?.close(); await rm(root, { recursive: true, force: true }) }
})

test('fresh retrieval and storage services restore an authorized document without reading pages or recomputing embeddings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-retrieval-restart-'))
  const text = ['A distant introduction.', 'The cat learns useful patterns.', 'A cat sleeps in the garden.']
  let pageReads = 0, documentEmbeddings = 0, queryEmbeddings = 0
  let generation = 'first-registration'
  let source: RetrievalDocument = { id: 'first-view', path: '/fixtures/persistent.pdf',
    sourceDigest: 'same-source-bytes', contentVersion: 'first-working-copy', pageCount: text.length }
  const provider = (): RetrievalEmbedding => ({ fingerprint: 'fixture-model-v1', generation,
    configurationIdentity: 'same-model-config', dimensions: 2, maxBatchSize: 2, maxInputCharacters: 1200,
    async embed(texts, purpose) {
      if (purpose === 'document') documentEmbeddings += texts.length
      else queryEmbeddings += texts.length
      return texts.map(value => /cat|feline/.test(value) ? [1, 0] : [0, 1])
    } })
  let authorizedSession = 'first-session'
  let storage: Awaited<ReturnType<typeof openDiskCache>> | undefined
  let service: ReturnType<typeof createRetrievalService> | undefined
  const ports = (): RetrievalPorts => ({
    documents: { snapshot(sessionId, id) {
      assert.equal(sessionId, authorizedSession); assert.equal(id, source.id)
      return { ...source }
    } },
    pages: { async read(_sessionId, _id, page) { pageReads++; return { text: text[page - 1]!, source: 'pdf-text' } } },
    cache: storage!.cache, embedding: { select: provider },
    limits: { pagesPerStep: 1, embeddingBatchesPerStep: 1 },
  })
  try {
    storage = await openDiskCache(root)
    service = createRetrievalService(ports())
    await service.prepare(authorizedSession, { documentId: source.id })
    assert.equal(pageReads, text.length)
    assert.equal(documentEmbeddings, text.length)
    assert.equal((await readdir(join(root, 'pdf_retrieval_regression', 'cache'))).length, text.length * 2)
    await service.dispose(); service = undefined
    await storage.close(); storage = undefined

    // New storage backend, domain, retrieval service, document view, session and
    // provider registration: no in-memory owner from the first Host remains.
    source = { ...source, id: 'new-view', contentVersion: 'new-working-copy' }
    authorizedSession = 'new-session'; generation = 'new-registration'
    storage = await openDiskCache(root)
    service = createRetrievalService(ports())
    await service.prepare(authorizedSession, { documentId: source.id })
    assert.equal(pageReads, text.length, 'page text must come from disk instead of native extraction')
    assert.equal(documentEmbeddings, text.length, 'unchanged text must reuse persisted document vectors')
    const result = await service.search(authorizedSession, { documentId: source.id, query: 'feline', mode: 'semantic', topK: 2 })
    assert.equal(result.status, 'complete')
    assert.equal(result.document.id, source.id)
    assert.deepEqual(result.chunks.map(chunk => chunk.page).sort(), [2, 3])
    assert.equal(queryEmbeddings, 1, 'only the new query needs the model after restoration')
    assert.equal(documentEmbeddings, text.length)

    const deniedPorts = ports()
    deniedPorts.documents.snapshot = () => { throw Object.assign(new Error('Denied'), { code: 'pdf/access-denied' }) }
    const denied = createRetrievalService(deniedPorts)
    try { await assert.rejects(denied.prepare('foreign-session', { documentId: source.id }), { code: 'pdf/access-denied' }) }
    finally { await denied.dispose() }
  } finally {
    await service?.dispose(); await storage?.close()
    await rm(root, { recursive: true, force: true })
  }
})
