import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPdfRetrieval } from '../../../../src/layers/facade/search/host-retrieval.ts'
import { createMemoryEvidenceReferenceStore } from '../../../../src/layers/facade/evidence/index.ts'
import { createRetrievalStore } from '../../../../src/layers/derived/storage/retrieval-store.ts'
import { EmbeddingRegistry } from '../../../../src/engines/embedding/sdk/index.ts'
import { createOpenAiCompatibleEmbeddingEngine } from '../../../../src/engines/embedding/backends/openai-compatible.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/layers/document/working-copy/index.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'

for (const versioned of [false, true]) test(
  'Host preserves ' + (versioned ? 'revision-attested' : 'declared') + ' provider caches across endpoints, models and disk reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-provider-cache-'))
    const engineId = 'local-qwen3-embedding', text = 'A cat sleeps in the garden.', query = 'feline'
    const signal = new AbortController().signal
    const snapshot: HostWorkspaceSnapshot = {
      id: 'document', path: '/fixtures/provider-cache.pdf', bytes: new Uint8Array([1, 2, 3]),
      sourceVersion: 'source', contentVersion: 'content', revision: 0,
      dirty: false, conflict: false, canUndo: false, canRedo: false,
      document: { pageCount: 1, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false },
    }
    const requests: Array<{ url: string; model?: string; kind: 'metadata' | 'document' | 'query' }> = []
    let config = { endpoint: 'https://first.example/v1', apiKeyRef: 'FIRST_KEY', model: 'model-a', dimensions: 2 }
    let revision = 'weights-v1', time = 0
    let registry: EmbeddingRegistry | undefined
    let store: ReturnType<typeof createRetrievalStore> | undefined
    let retrieval: ReturnType<typeof createPdfRetrieval> | undefined
    const documentCalls = () => requests.filter(request => request.kind === 'document').length
    const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    const open = () => {
      store = createRetrievalStore({ directory: root, maxMemoryBytes: 0 })
      registry = new EmbeddingRegistry()
      registry.register(createOpenAiCompatibleEmbeddingEngine({ now: () => time, resolveCredential: async reference => 'key-' + reference,
        fetch: (async (url, init) => {
          const target = String(url)
          if (target.includes('offline.example')) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer key-' + config.apiKeyRef)
          if (target.endsWith('/models')) {
            requests.push({ url: target, kind: 'metadata' })
            return response({ data: ['model-a', 'model-b'].map((id, index) => ({ id,
              ...(versioned ? { embedding: { revision, dimensions: index + 2, maxInputCharacters: 16000,
                maxBatchSize: 8, truncation: false, queryEncoding: 'client-instruction' } } : {}),
            })) })
          }
          assert.ok(target.endsWith('/embeddings'))
          const body = JSON.parse(String(init?.body)) as { model: string; input: string[] }
          assert.equal(body.input.length, 1)
          assert.ok(body.input[0] === text || body.input[0] === query)
          requests.push({ url: target, model: body.model, kind: body.input[0] === text ? 'document' : 'query' })
          return response({ model: body.model, ...(versioned ? { model_revision: revision } : {}),
            data: body.input.map((_, index) => ({ index, embedding: body.model === 'model-a' ? [1, 0] : [1, 0, 0] })) })
        }) as typeof fetch,
      }))
      retrieval = createPdfRetrieval({ readSnapshot(sessionId, documentId) {
        assert.equal(sessionId, 'session'); assert.equal(documentId, snapshot.id); return snapshot
      } }, { async readPageText() { return { snapshot, content: { items: [{ str: text,
        transform: [1, 0, 0, 1, 0, 0], width: 100, height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }],
      styles: {}, lang: null } } } }, createMemoryEvidenceReferenceStore(), {
        embeddings: registry, cache: store, limits: { maxIndexes: 1 },
        settings: () => ({ ...defaultSettings, embeddingEngine: engineId,
          engineConfigurations: { embedding: { [engineId]: config } } }),
      })
    }
    const close = async () => {
      await retrieval?.dispose(); retrieval = undefined
      registry?.dispose(); registry = undefined
      await store?.dispose(); store = undefined
    }
    const search = async () => {
      await retrieval!.prepare('session', { documentId: snapshot.id }, signal)
      const result = await retrieval!.search('session', { documentId: snapshot.id, query, mode: 'semantic' }, signal)
      assert.equal(result.status, 'complete')
      assert.equal(result.candidates.length, 1)
      return result.indexGeneration
    }
    try {
      open()
      const modelA = await search()
      assert.equal(documentCalls(), 1)
      config = { ...config, endpoint: 'https://second.example/v1', apiKeyRef: 'SECOND_KEY' }
      assert.equal(await search(), modelA)
      assert.equal(documentCalls(), 1, 'endpoint and credentials do not create another vector namespace')
      assert.ok(requests.some(request => request.url === 'https://second.example/v1/models'))
      assert.ok(requests.some(request => request.url === 'https://second.example/v1/embeddings' && request.kind === 'query'),
        'the current connection still computes each fresh query vector')

      config = { ...config, model: 'model-b', dimensions: 3 }
      const modelB = await search()
      assert.notEqual(modelB, modelA)
      assert.equal(documentCalls(), 2, 'different provider model identities coexist without sharing vectors')
      await close()
      config = { ...config, endpoint: 'https://third.example/v1', model: 'model-a', dimensions: 2 }
      open()
      assert.equal(await search(), modelA)
      config = { ...config, model: 'model-b', dimensions: 3 }
      assert.equal(await search(), modelB)
      assert.equal(documentCalls(), 2, 'both model caches survive memory eviction, registry replacement and SQLite reopen')

      config = { ...config, model: 'model-a', dimensions: 2 }
      if (versioned) {
        revision = 'weights-v2'; time += 3000
        assert.notEqual(await search(), modelA)
        assert.equal(documentCalls(), 3, 'the same model name with different weights has its own cache')
        revision = 'weights-v1'; time += 3000
        assert.equal(await search(), modelA)
        assert.equal(documentCalls(), 3, 'switching back to the original revision restores its cache')
      }
      const beforeFailure = documentCalls()
      config = { ...config, endpoint: 'https://offline.example/v1' }
      await assert.rejects(retrieval!.prepare('session', { documentId: snapshot.id }, signal), { code: 'pdf/retrieval-engine-unavailable' })
      config = { ...config, endpoint: 'https://first.example/v1' }
      assert.equal(await search(), modelA)
      assert.equal(documentCalls(), beforeFailure, 'a failed connection never invalidates saved provider vectors')

      await retrieval!.rebuild()
      assert.notEqual(await search(), modelA)
      config = { ...config, model: 'model-b', dimensions: 3 }
      assert.notEqual(await search(), modelB)
      assert.equal(documentCalls(), beforeFailure + 2, 'explicit global cache clear removes all provider identities')
    } finally { await close(); await rm(root, { recursive: true, force: true }) }
  },
)
