import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeCachedVector, digest, encodeCachedVector, retrievalCacheKey } from '../../../../src/layers/derived/indexing/cache.ts'
import { createRetrievalService } from '../../../../src/layers/facade/search/retrieval/service.ts'
import type { RetrievalEmbedding, RetrievalPorts, RetrievalProgress } from '../../../../src/layers/facade/search/retrieval/types.ts'
import type { RetrievalCache } from '../../../../src/layers/derived/indexing/types.ts'

const input = [0.275497866794467, -0.4411379941739142]
const text = 'One durable searchable evidence paragraph.'

test('cached vectors remain searchable across checkpoint publication and service restoration', async () => {
    const original = encodeCachedVector(input)
    assert.notEqual(encodeCachedVector(decodeCachedVector(original, 2)!).sha256, original.sha256,
      'this vector changes bytes if the cached Float32 values are normalized again')
    const vectorKey = retrievalCacheKey('vector', 'exact-vector-reuse', 'document', digest(text))
    const records = new Map<string, unknown>([[vectorKey, original]])
    let vectorWrites = 0, reads = 0, documentEmbeddings = 0, queryEmbeddings = 0
    const cache: RetrievalCache = {
      async get(key) { return structuredClone(records.get(key)) },
      async has(key) { return records.has(key) },
      async set(key, value) {
        if (key === vectorKey) {
          vectorWrites++
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
      assert.equal(refs[0]!.key, vectorKey)
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
      assert.equal(vectorWrites, 0)
    } finally { await service.dispose() }
})
