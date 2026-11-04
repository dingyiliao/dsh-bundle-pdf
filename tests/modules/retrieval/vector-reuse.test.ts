import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRetrievalStore } from '../../../src/adapters/host/filesystem/retrieval-store.ts'
import { decodeCachedVector, digest, encodeCachedVector, retrievalCacheKey, RETRIEVAL_EXTRACTION_VERSION,
  type CachedRetrievalPage } from '../../../src/modules/retrieval/cache.ts'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { buildIndexPageEntries, storedIndexHeadKey, storedIndexPageKey,
  type IndexPageSummary, type StoredIndexPage } from '../../../src/modules/retrieval/stored-index.ts'
import { chunkRetrievalPage, RETRIEVAL_TEXT_VERSION } from '../../../src/modules/retrieval/text.ts'
import type { RetrievalCache, RetrievalEmbedding, RetrievalPorts, RetrievalProgress } from '../../../src/modules/retrieval/types.ts'

const input = [0.275497866794467, -0.4411379941739142]
const text = 'One durable searchable evidence paragraph.'

for (const source of ['encoded', 'legacy', 'failed-legacy-migration'] as const) {
  test(`${source} cached vectors remain searchable across checkpoint publication and service restoration`, async () => {
    const original = encodeCachedVector(input)
    assert.notEqual(encodeCachedVector(decodeCachedVector(original, 2)!).sha256, original.sha256,
      'this vector changes bytes if the cached Float32 values are normalized again')
    const vectorKey = retrievalCacheKey('vector', 'exact-vector-reuse', 'document', digest(text))
    const records = new Map<string, unknown>([[vectorKey, source === 'encoded' ? original : [...input]]])
    let vectorWrites = 0, reads = 0, documentEmbeddings = 0, queryEmbeddings = 0
    const cache: RetrievalCache = {
      async get(key) { return structuredClone(records.get(key)) },
      async has(key) { return records.has(key) },
      async set(key, value) {
        if (key === vectorKey) {
          vectorWrites++
          if (source === 'failed-legacy-migration') throw new Error('optional legacy migration write failed')
        }
        records.set(key, structuredClone(value))
      },
    }
    const provider: RetrievalEmbedding = { fingerprint: 'exact-vector-reuse', dimensions: 2, maxBatchSize: 8,
      async embed(texts, purpose) {
        if (purpose === 'document') { documentEmbeddings++; throw new Error('cached document vectors must be reused') }
        queryEmbeddings++; return texts.map(() => [...input])
      } }
    const ports: RetrievalPorts = { cache,
      documents: { snapshot() { return { id: 'document', path: '/synthetic/exact-vector-reuse.pdf',
        sourceDigest: 'same-source', contentVersion: 'same-content', pageCount: 1 } } },
      pages: { async read() { reads++; return { text, source: 'pdf-text' } } },
      embedding: { select: () => provider },
    }
    const search = { documentId: 'document', query: 'evidence', mode: 'semantic' as const, topK: 8 }
    let service = createRetrievalService(ports)
    try {
      let progress: RetrievalProgress | undefined
      await service.prepare('reader', { documentId: 'document' }, undefined, value => { progress = value })
      assert.equal(progress?.phase, 'ready')
      assert.equal(progress?.reusedChunks, 1)
      assert.equal(progress?.computedChunks, 0)
      const header = [...records.entries()].find(([key]) => key.startsWith('index_page_'))?.[1] as {
        vectorRefs: Record<string, { key: string; sha256: string }>
      }
      const refs = Object.values(header.vectorRefs)
      assert.equal(refs.length, 1)
      assert.equal(refs[0]!.sha256, original.sha256, 'checkpoint publication retains the original encoded bytes')
      assert.deepEqual(records.get(refs[0]!.key), original, 'the checkpoint references the exact record that is durable')
      assert.equal(refs[0]!.key, source === 'failed-legacy-migration' ? `index_vector_${original.sha256}` : vectorKey)
      const first = await service.search('reader', search)
      assert.equal(first.status, 'complete')
      assert.equal(first.coverage.embeddedChunks, 1)
      assert.equal(first.chunks[0]?.text, text)
      await service.dispose()
      service = createRetrievalService(ports)
      const restored = await service.search('reader', search)
      assert.equal(restored.status, 'complete')
      assert.equal(restored.indexGeneration, first.indexGeneration)
      assert.equal(restored.coverage.embeddedChunks, 1)
      assert.deepEqual(restored.chunks, first.chunks)
      assert.equal(reads, 1, 'restoring the checkpoint requires no extra extraction or OCR')
      assert.equal(documentEmbeddings, 0)
      assert.equal(queryEmbeddings, 2, 'only the two local query embeddings run')
      assert.equal(vectorWrites, source === 'encoded' ? 0 : 1, 'modern cache hits are read-only and legacy migration is attempted once')
    } finally { await service.dispose() }
  })
}

test('SQLite repair makes an old vector reference searchable immediately while retaining its generation, OCR and evidence version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-vector-reference-repair-'))
  let cache = createRetrievalStore({ directory, maxMemoryBytes: 64 * 1024 })
  const original = encodeCachedVector(input), referenced = encodeCachedVector(decodeCachedVector(original, 2)!)
  assert.notEqual(referenced.sha256, original.sha256)
  const ocrText = 'Original OCR evidence keeps its producer, geometry and image provenance.'
  const content: CachedRetrievalPage = { version: 1, source: 'pdf-text', text: '',
    contentIdentity: `sha256:${digest('original-page-content')}`,
    units: [{ id: 'original-ocr', blockId: 'scanned-paragraph', kind: 'ocr-text', text: ocrText,
      digest: `sha256:${digest(ocrText)}`, rectPdf: [1, 2, 201, 22],
      spans: [{ startUtf16: 0, endUtf16: ocrText.length, rectPdf: [1, 2, 201, 22] }],
      producer: { id: 'original-ocr-engine', version: '1', model: 'preserved-ocr-model', configurationIdentity: 'eng' },
      inputDigest: `sha256:${digest('original-scanned-image')}` }] }
  const document = { id: 'document', path: '/synthetic/preserved-ocr.pdf', sourceDigest: 'original-source',
    contentVersion: 'original-content', pageCount: 1 }
  let reads = 0, documentEmbeddings = 0, queryEmbeddings = 0
  const provider: RetrievalEmbedding = { fingerprint: 'old-reference-model', documentFingerprint: 'old-reference-document-model',
    dimensions: 2, maxBatchSize: 8,
    async embed(texts, purpose) {
      if (purpose === 'document') { documentEmbeddings++; throw new Error('repair must preserve the existing document vector') }
      queryEmbeddings++; return texts.map(() => [...input])
    } }
  const persistentKey = digest(JSON.stringify(['disk-index-v1', document.sourceDigest, 1, 1, 1,
    provider.documentFingerprint, RETRIEVAL_EXTRACTION_VERSION, RETRIEVAL_TEXT_VERSION, '']))
  const generation = 'b9329848-aeb6-4c32-af59-f7ec46f185c6'
  const vectorKey = retrievalCacheKey('vector', provider.documentFingerprint, 'document', digest(ocrText))
  const chunks = chunkRetrievalPage(1, content)
  assert.equal(chunks.length, 1)
  const chunk = chunks[0]!
  const record: StoredIndexPage = { version: 1, page: 1, generation, content, vectors: { [chunk.id]: referenced } }
  // Reproduce the old cache-reuse publication: the header expects a vector
  // normalized twice but its reusable model/text key still holds the original.
  const built = buildIndexPageEntries(persistentKey, generation, record, chunks, undefined, { [chunk.id]: vectorKey })
  interface Header {
    generation: string; contentKey: string; chunkIds: string[]
    vectorRefs: Record<string, { key: string; sha256: string }>; summary: IndexPageSummary
  }
  const before = structuredClone(built.entries.at(-1)![1]) as Header
  const pageKey = storedIndexPageKey(persistentKey, generation, 1)
  const ports: RetrievalPorts = { cache, documents: { snapshot: () => ({ ...document }) },
    pages: { async read() { reads++; throw new Error('repair must not extract the page or rerun OCR') } },
    embedding: { select: () => provider } }
  let service = createRetrievalService(ports)
  try {
    assert.equal(typeof cache.compareAndSet, 'function', 'the production SQLite store must provide atomic repair')
    await cache.setMany([[vectorKey, original], ...built.entries,
      [storedIndexHeadKey(persistentKey), { version: 1, key: persistentKey, active: { id: generation } }]])
    const query = { documentId: document.id, query: 'original OCR evidence', mode: 'semantic' as const, topK: 8 }
    const first = await service.search('reader', query)
    assert.equal(first.status, 'complete', 'the first search repairs old refs without a preparation or retry')
    assert.equal(first.indexGeneration, generation)
    assert.deepEqual(first.coverage.ocrPages, [1])
    assert.equal(first.coverage.embeddedChunks, 1)
    assert.deepEqual(first.chunks.map(({ score: _score, ...value }) => value), chunks)
    const repaired = await cache.get(pageKey) as Header
    assert.deepEqual(repaired, { ...before, vectorRefs: {
      [chunk.id]: { key: `index_vector_${referenced.sha256}`, sha256: referenced.sha256 },
    } }, 'repair changes only the reference location, preserving the committed evidence version and generation')
    assert.deepEqual(await cache.get(before.contentKey), content, 'the exact persisted OCR data is retained')
    assert.deepEqual(await cache.get(vectorKey), original, 'the independent cache retains its original Float32 bytes')
    assert.deepEqual(await cache.get(repaired.vectorRefs[chunk.id]!.key), referenced)
    await service.dispose(); await cache.dispose()
    cache = createRetrievalStore({ directory, maxMemoryBytes: 64 * 1024 })
    ports.cache = cache
    service = createRetrievalService(ports)
    const restored = await service.search('reopened-reader', query)
    assert.equal(restored.status, 'complete')
    assert.equal(restored.indexGeneration, generation)
    assert.deepEqual(restored.chunks, first.chunks)
    assert.deepEqual(await cache.get(pageKey), repaired, 'reopening the SQLite database keeps the exact repaired checkpoint')
    assert.deepEqual(await cache.get(before.contentKey), content)
    assert.deepEqual(await cache.get(vectorKey), original)
    assert.equal(reads, 0)
    assert.equal(documentEmbeddings, 0)
    assert.equal(queryEmbeddings, 2, 'only local query embeddings run during the two searches')
  } finally {
    await service.dispose(); await cache.dispose(); await rm(directory, { recursive: true, force: true })
  }
})
