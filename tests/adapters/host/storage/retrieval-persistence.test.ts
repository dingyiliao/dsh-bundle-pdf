import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createRetrievalStore } from '../../../../src/adapters/host/filesystem/retrieval-store.ts'
import { retrievalCacheRecordSchema } from '../../../../src/adapters/host/storage/retrieval-cache.ts'
import { digest, encodeCachedVector, pageCacheKey, retrievalCacheKey } from '../../../../src/modules/retrieval/cache.ts'
import { createRetrievalService } from '../../../../src/modules/retrieval/service.ts'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalPorts } from '../../../../src/modules/retrieval/types.ts'

/** The retired Host's actual domain/JSON format, used only as an import source. */
async function openLegacyDomain(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const domain = await facility.open(defineDomain({ name: 'pdf_retrieval_regression', version: 1,
    layout: 'per-record', tables: { cache: domainTable(retrievalCacheRecordSchema) } }))
  const table = domain.table('cache')
  return { table, async close() {
    await facility.closeAll()
    unregister()
    await backend.close()
    await ctx.fiber.dispose()
  } }
}

test('real legacy Storage Domain records migrate into the file store after all original owners close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-legacy-import-')), legacyRoot = join(root, 'legacy'), disk = join(root, 'index')
  let legacy: Awaited<ReturnType<typeof openLegacyDomain>> | undefined
  let store: ReturnType<typeof createRetrievalStore> | undefined
  const key = retrievalCacheKey('page', 'source', 1)
  const payload = { version: 1, source: 'pdf-text', text: 'Synthetic searchable legacy page.' }
  try {
    legacy = await openLegacyDomain(legacyRoot)
    assert.match(key, /^[A-Za-z0-9_-]+$/)
    await legacy.table.put(key, { createdAt: 1, payload })
    assert.deepEqual(await readdir(join(legacyRoot, 'pdf_retrieval_regression', 'cache')), [key + '.json'])
    await legacy.close(); legacy = undefined
    store = createRetrievalStore({ directory: disk })
    let importedOwnerClosed = false
    await store.migrateLegacy(async () => {
      const source = await openLegacyDomain(legacyRoot)
      return { entries: () => source.table.entries(), async close() { await source.close(); importedOwnerClosed = true } }
    })
    assert.equal(importedOwnerClosed, true)
    assert.deepEqual(await store.get(key), payload, 'valid old records are imported rather than expired by the removed TTL policy')
    await store.dispose()
    store = createRetrievalStore({ directory: disk })
    await store.migrateLegacy(async () => { throw new Error('A committed migration must not reopen the legacy domain') })
    assert.deepEqual(await store.get(key), payload)
    assert.deepEqual(await readdir(join(legacyRoot, 'pdf_retrieval_regression', 'cache')), [key + '.json'],
      'import must preserve the original legacy records')
  } finally { await store?.dispose(); await legacy?.close(); await rm(root, { recursive: true, force: true }) }
})

test('migrated pages and vectors survive file-store restart without recomputation or granting document access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-legacy-retrieval-')), legacyRoot = join(root, 'legacy'), disk = join(root, 'index')
  const text = ['A distant introduction.', 'The cat learns useful patterns.', 'A cat sleeps in the garden.']
  const documentFingerprint = 'fixture-document-encoding-v1'
  let source: RetrievalDocument = { id: 'first-view', path: '/fixtures/persistent.pdf',
    sourceDigest: 'same-source-bytes', contentVersion: 'first-working-copy', pageCount: text.length }
  let allowedSession = 'first-session', generation = 'first-registration'
  let pageReads = 0, documentEmbeddings = 0, queryEmbeddings = 0
  let legacy: Awaited<ReturnType<typeof openLegacyDomain>> | undefined
  let store: ReturnType<typeof createRetrievalStore> | undefined
  let service: ReturnType<typeof createRetrievalService> | undefined
  const provider: RetrievalEmbedding = { fingerprint: 'fixture-model-v1', documentFingerprint,
    configurationIdentity: 'same-model-config', dimensions: 2, maxBatchSize: 2, maxInputCharacters: 1200,
    async embed(texts, purpose) {
      if (purpose === 'document') { documentEmbeddings += texts.length; throw new Error('The imported document vectors must be reused') }
      queryEmbeddings += texts.length
      return texts.map(value => /cat|feline/.test(value) ? [1, 0] : [0, 1])
    } }
  const ports = (): RetrievalPorts => ({
    documents: { snapshot(sessionId, id) {
      if (sessionId !== allowedSession || id !== source.id) throw Object.assign(new Error('Denied'), { code: 'pdf/access-denied' })
      return { ...source }
    } },
    pages: { async read() { pageReads++; throw new Error('The imported pages must be reused') } },
    cache: store!, embedding: { select: () => ({ ...provider, generation }) },
  })
  try {
    legacy = await openLegacyDomain(legacyRoot)
    for (let index = 0; index < text.length; index++) {
      const value = text[index]!
      await legacy.table.put(pageCacheKey(source.path, source.sourceDigest, index + 1), {
        createdAt: 1, payload: { version: 1, text: value, source: 'pdf-text' },
      })
      await legacy.table.put(retrievalCacheKey('vector', documentFingerprint, 'document', digest(value)), {
        createdAt: 1, payload: { ...encodeCachedVector(/cat/.test(value) ? [1, 0] : [0, 1]) },
      })
    }
    await legacy.close(); legacy = undefined
    store = createRetrievalStore({ directory: disk })
    await store.migrateLegacy(async () => {
      const source = await openLegacyDomain(legacyRoot)
      return { entries: () => source.table.entries(), close: () => source.close() }
    })
    service = createRetrievalService(ports())
    await service.prepare(allowedSession, { documentId: source.id })
    assert.equal(pageReads, 0); assert.equal(documentEmbeddings, 0)
    await service.dispose(); service = undefined
    await store.dispose()
    source = { ...source, id: 'new-view', contentVersion: 'new-working-copy' }
    allowedSession = 'new-session'; generation = 'new-registration'
    store = createRetrievalStore({ directory: disk })
    service = createRetrievalService(ports())
    await service.prepare(allowedSession, { documentId: source.id })
    const result = await service.search(allowedSession, { documentId: source.id, query: 'feline', mode: 'semantic', topK: 2 })
    assert.equal(result.status, 'complete')
    assert.equal(result.document.id, source.id)
    assert.deepEqual(result.chunks.map(chunk => chunk.page).sort(), [2, 3])
    assert.equal(pageReads, 0); assert.equal(documentEmbeddings, 0); assert.equal(queryEmbeddings, 1)
    await assert.rejects(service.prepare('foreign-session', { documentId: source.id }), { code: 'pdf/access-denied' })
    await assert.rejects(service.search('foreign-session', { documentId: source.id, query: 'feline', mode: 'semantic' }), { code: 'pdf/access-denied' })
    assert.equal(queryEmbeddings, 1, 'a durable index cannot authorize a foreign Session or call its model')
  } finally { await service?.dispose(); await store?.dispose(); await legacy?.close(); await rm(root, { recursive: true, force: true }) }
})
