import assert from 'node:assert/strict'
import test from 'node:test'
import { createDisabledEmbeddingEngine, EmbeddingError, EmbeddingRegistry,
  type EmbeddingEngine, type EmbeddingEngineRequest } from '../../src/embedding/index.js'

const binding = { engineId: 'test-embedding' }
function engine(embed: EmbeddingEngine['embed'] = async request => request.texts.map(() => [3, 4])): EmbeddingEngine {
  return { descriptor: { id: binding.engineId, name: 'Test', version: '1', execution: 'local' },
    describe: () => ({ engineId: binding.engineId, engineVersion: '1', model: 'test', modelRevision: '1',
      dimensions: 2, maxBatchSize: 4, maxInputCharacters: 100, encoding: 'test-l2-v1', fingerprint: 'test-v1' }), embed }
}
const code = (expected: string) => (error: unknown) => error instanceof EmbeddingError && error.code === expected

test('invalid provider model descriptions and availability states cannot enter the usable catalog', async () => {
  const registry = new EmbeddingRegistry()
  const base = engine()
  const remove = registry.register({ ...base, describe: config => ({ ...base.describe(config), dimensions: 0 }) })
  assert.throws(() => registry.describe(binding), code('invalid-result'))
  remove()
  registry.register({ ...base, availability: async () => ({ status: 'unexpected' as never }) })
  await assert.rejects(registry.availability(binding), code('invalid-result'))
  registry.dispose()
})

test('a provider changing its model during inference cannot return mislabeled vectors', async () => {
  const registry = new EmbeddingRegistry()
  const base = engine()
  let fingerprint = 'original-model'
  registry.register({ ...base,
    describe: config => ({ ...base.describe(config), fingerprint }),
    embed: async () => { fingerprint = 'replacement-model'; return [[3, 4]] },
  })
  await assert.rejects(registry.embed({ texts: ['a'], purpose: 'query' }, binding), code('invalid-result'))
  registry.dispose()
})

test('invalid deadlines fail before invoking an embedding provider', async () => {
  const registry = new EmbeddingRegistry()
  let calls = 0
  registry.register(engine(async () => { calls++; return [[3, 4]] }))
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(registry.embed({ texts: ['a'], purpose: 'query', timeoutMs }, binding), code('invalid-request'))
  }
  assert.equal(calls, 0)
  registry.dispose()
})

test('registry captures inputs, normalizes vectors, and separates registration leases from encoding identity', async () => {
  const registry = new EmbeddingRegistry()
  const remove = registry.register(engine())
  const generation = registry.generation(binding)
  const result = await registry.embed({ texts: ['中文', 'English'], purpose: 'document' }, binding)
  assert.deepEqual(result.vectors, [[0.6, 0.8], [0.6, 0.8]])
  assert.equal(result.model.fingerprint, registry.describe(binding).fingerprint)
  remove()
  registry.register(engine())
  assert.notEqual(registry.generation(binding), generation)
  assert.equal(registry.describe(binding).fingerprint, result.model.fingerprint)
  registry.dispose()
})

test('invalid batch, dimensions, nonfinite/zero vectors fail without returning usable embeddings', async () => {
  for (const vectors of [[], [[1]], [[0, 0]], [[NaN, 2]], [[Infinity, 1]], [[1e308, 1e308]]]) {
    const registry = new EmbeddingRegistry()
    registry.register(engine(async () => vectors))
    if (vectors[0]?.[0] === 1e308) {
      assert.ok((await registry.embed({ texts: ['a'], purpose: 'query' }, binding)).vectors.every(vector => vector.every(Number.isFinite)))
    } else await assert.rejects(registry.embed({ texts: ['a'], purpose: 'query' }, binding), code('invalid-result'))
    registry.dispose()
  }
  const registry = new EmbeddingRegistry({ maxInputCharacters: 3, maxBatchSize: 1 })
  registry.register(engine())
  for (const texts of [[], ['1234'], ['a', 'b'], [' ']]) {
    await assert.rejects(registry.embed({ texts, purpose: 'query' }, binding), code('invalid-request'))
  }
  registry.dispose()
})

test('unloading an engine aborts active work, rejects late responses, and updates its catalog', async () => {
  const registry = new EmbeddingRegistry()
  let captured!: EmbeddingEngineRequest
  let finish!: (vectors: number[][]) => void
  let changes = 0
  registry.subscribe(() => changes++)
  const remove = registry.register(engine(request => {
    captured = request
    return new Promise(resolve => { finish = resolve })
  }))
  const task = registry.embed({ texts: ['sensitive text'], purpose: 'query' }, binding)
  remove()
  assert.equal(captured.signal.aborted, true)
  await assert.rejects(task, code('engine-unavailable'))
  finish([[3, 4]])
  await Promise.resolve()
  assert.deepEqual(registry.list(), [])
  assert.equal(changes, 2)
  registry.dispose()
})

test('cancellation and timeouts bound even a provider that ignores AbortSignal', async () => {
  const registry = new EmbeddingRegistry({ timeoutMs: 10 })
  registry.register(engine(() => new Promise(() => {})))
  const abort = new AbortController()
  const task = registry.embed({ texts: ['a'], purpose: 'document', signal: abort.signal }, binding)
  abort.abort(new Error('private caller details'))
  await assert.rejects(task, code('cancelled'))
  await assert.rejects(registry.embed({ texts: ['a'], purpose: 'document' }, binding), code('timeout'))
  registry.dispose()
  await assert.rejects(registry.embed({ texts: ['a'], purpose: 'document' }, binding), code('engine-unavailable'))
})

test('unload also cancels availability; disabled defaults never run inference', async () => {
  const registry = new EmbeddingRegistry()
  registry.register(createDisabledEmbeddingEngine())
  assert.deepEqual(await registry.availability({ engineId: 'none' }), { status: 'disabled' })
  assert.throws(() => registry.describe({ engineId: 'none' }), code('disabled'))
  const remove = registry.register({ ...engine(), availability: () => new Promise(() => {}) })
  const probe = registry.availability(binding)
  remove()
  await assert.rejects(probe, code('engine-unavailable'))
  registry.dispose()
})

test('bad provider failures and availability reasons do not expose inputs or credentials', async () => {
  const registry = new EmbeddingRegistry()
  registry.register({ ...engine(async () => { throw new Error('secret token and document content') }),
    availability: async () => ({ status: 'unavailable', reason: 'secret token and document content' }) })
  assert.equal(JSON.stringify(await registry.availability(binding)).includes('secret'), false)
  await assert.rejects(registry.embed({ texts: ['document content'], purpose: 'document' }, binding), error => {
    assert.ok(error instanceof EmbeddingError)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
  registry.dispose()
})
