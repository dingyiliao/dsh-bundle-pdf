import assert from 'node:assert/strict'
import test from 'node:test'
import { EmbeddingError, EmbeddingRegistry } from '../../../../src/embedding/index.js'
import { createOpenAiCompatibleEmbeddingEngine, LOCAL_QWEN3_REVISION, QWEN3_RETRIEVAL_INSTRUCTION } from '../../../../src/adapters/host/embedding/openai-compatible.js'

const binding = { engineId: 'local-qwen3-embedding', config: { dimensions: 2 } }
function metadata(overrides = {}) {
  return { data: [{ id: 'mlx-community/Qwen3-Embedding-0.6B-8bit', embedding: {
    revision: LOCAL_QWEN3_REVISION, dimensions: 2, truncation: false, maxInputCharacters: 16000,
    maxBatchSize: 8, queryEncoding: 'client-instruction', ...overrides } }] }
}
function reply(values: object) { return new Response(JSON.stringify({ model_revision: LOCAL_QWEN3_REVISION, ...values }), { headers: { 'content-type': 'application/json' } }) }
const code = (expected: string) => (error: unknown) => error instanceof EmbeddingError && error.code === expected

test('metadata-verified embeddings preserve API indices and distinguish query/document encoding', async () => {
  const requests: string[][] = []
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async (url, init) => {
    assert.equal(init?.redirect, 'error')
    if (String(url).endsWith('/models')) return reply(metadata())
    requests.push(JSON.parse(String(init?.body)).input)
    return reply({ data: [{ index: 1, embedding: [4, 3] }, { index: 0, embedding: [3, 4] }] })
  }) as typeof fetch })
  const registry = new EmbeddingRegistry()
  registry.register(engine)
  const texts = ['中文', 'English']
  const result = await registry.embed({ texts, purpose: 'document' }, binding)
  assert.deepEqual(result.vectors, [[0.6, 0.8], [0.8, 0.6]])
  await registry.embed({ texts, purpose: 'query' }, binding)
  assert.deepEqual(requests[0], texts)
  assert.deepEqual(requests[1], texts.map(text => `Instruct: ${QWEN3_RETRIEVAL_INSTRUCTION}\nQuery: ${text}`))
  assert.notEqual(registry.describe(binding).fingerprint,
    registry.describe({ ...binding, config: { ...binding.config, modelRevision: 'different' } }).fingerprint)
  registry.dispose()
})

test('legacy silently-truncating or mismatched servers are rejected before sending document text', async () => {
  for (const data of [{}, metadata({ truncation: true }), metadata({ revision: 'different' }), metadata({ dimensions: 3 }),
    metadata({ maxInputCharacters: 512 }), metadata({ maxBatchSize: 1 })]) {
    let calls = 0
    const registry = new EmbeddingRegistry()
    registry.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async (url) => {
      calls++
      assert.ok(String(url).endsWith('/models'))
      return reply(data)
    }) as typeof fetch }))
    await assert.rejects(registry.embed({ texts: ['private PDF text'], purpose: 'document' }, binding), code('engine-unavailable'))
    assert.equal(calls, 1)
    registry.dispose()
  }
})

test('duplicate/missing indices, wrong model and malformed vectors are rejected', async () => {
  for (const data of [
    { data: [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [1, 2] }] },
    { data: [{ index: 1, embedding: [1, 2] }] },
    { model: 'wrong', data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1, 2] }] },
    { model_revision: 'changed-after-metadata-check', data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: [null, 1] }, { index: 1, embedding: [1, 2] }] },
  ]) {
    const registry = new EmbeddingRegistry()
    registry.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async url => reply(String(url).endsWith('/models') ? metadata() : data)) as typeof fetch }))
    await assert.rejects(registry.embed({ texts: ['a', 'b'], purpose: 'document' }, binding), code('invalid-result'))
    registry.dispose()
  }
})

test('response bytes, endpoint destinations and status errors are bounded without leaking response bodies', async () => {
  const registry = new EmbeddingRegistry()
  registry.register(createOpenAiCompatibleEmbeddingEngine({ maxResponseBytes: 10,
    fetch: (async url => String(url).endsWith('/models') ? reply(metadata()) : reply({ secret: 'private error body', data: [] })) as typeof fetch }))
  await assert.rejects(registry.embed({ texts: ['a'], purpose: 'document' }, binding), code('limit-exceeded'))
  for (const endpoint of ['https://example.com/v1/embeddings', 'http://localhost.evil.test/v1/embeddings',
    'file:///tmp/secret', 'http://user:password@localhost:8001/v1/embeddings', 'http://localhost:8001/v1/embeddings?token=secret']) {
    assert.throws(() => registry.describe({ ...binding, config: { endpoint } }), code('invalid-request'))
  }
  registry.dispose()
  const failed = new EmbeddingRegistry()
  failed.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => new Response('secret backend failure', { status: 500 })) as typeof fetch }))
  await assert.rejects(failed.embed({ texts: ['a'], purpose: 'document' }, binding), error => {
    assert.ok(error instanceof EmbeddingError)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
  failed.dispose()
})
