import assert from 'node:assert/strict'
import test from 'node:test'
import { EmbeddingError, EmbeddingRegistry } from '../../../../src/embedding/index.js'
import { createOpenAiCompatibleEmbeddingEngine, QWEN3_RETRIEVAL_INSTRUCTION } from '../../../../src/adapters/host/embedding/openai-compatible.js'
import { withIndexPerformance, type IndexPerformanceMetric } from '../../../../src/modules/retrieval/performance.js'

const FIXTURE_MODEL_REVISION = 'test-model-revision'
const binding = { engineId: 'local-qwen3-embedding', config: { dimensions: 2, queryInstruction: QWEN3_RETRIEVAL_INSTRUCTION } }
function metadata(overrides = {}) {
  return { data: [{ id: 'mlx-community/Qwen3-Embedding-0.6B-8bit', embedding: {
    revision: FIXTURE_MODEL_REVISION, dimensions: 2, truncation: false, maxInputCharacters: 16000,
    maxBatchSize: 8, queryEncoding: 'client-instruction', ...overrides } }] }
}
function reply(values: object) { return new Response(JSON.stringify({ model_revision: FIXTURE_MODEL_REVISION, ...values }), { headers: { 'content-type': 'application/json' } }) }
const code = (expected: string) => (error: unknown) => error instanceof EmbeddingError && error.code === expected
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const nextTurn = () => new Promise<void>(done => setImmediate(done))

test('endpoint configuration and direct engine inputs reject invalid limits before network access', async () => {
  let calls = 0
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => { calls++; throw new Error('unexpected request') }) as typeof fetch })
  const invalidConfigurations: Parameters<typeof engine.describe>[0][] = [
    { dimensions: 0 }, { maxBatchSize: 17 }, { maxInputCharacters: 1.5 }, { endpoint: 'not a URL' },
    { model: ' ' }, { model: 'x'.repeat(513) }, { model: 3 }, { queryInstruction: 3 }, { queryInstruction: 'x'.repeat(513) },
  ]
  for (const config of invalidConfigurations) {
    assert.throws(() => engine.describe(config), code('invalid-request'))
  }
  for (const texts of [[], [' '], ['abc'], ['a', 'b']]) {
    await assert.rejects(async () => engine.embed({ texts, purpose: 'document', signal: new AbortController().signal, timeoutMs: 1000 },
      { dimensions: 2, maxBatchSize: 1, maxInputCharacters: 2 }), code('limit-exceeded'))
  }
  assert.equal(calls, 0)
  assert.deepEqual(engine.describe({ apiKeyRef: '' }), engine.describe({}))
})

test('availability verifies server metadata without transmitting document inputs', async () => {
  const requests: string[] = []
  const registry = new EmbeddingRegistry()
  registry.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async (url, init) => {
    requests.push(String(url))
    assert.equal(init?.body, undefined)
    return reply(metadata())
  }) as typeof fetch }))
  try {
    assert.deepEqual(await registry.availability(binding), { status: 'available' })
    assert.deepEqual(requests, ['http://127.0.0.1:8001/v1/models'])
  } finally { registry.dispose() }
})

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
    registry.describe({ ...binding, config: { ...binding.config, queryInstruction: 'different' } }).fingerprint)
  registry.dispose()
})

test('missing models and explicitly truncating or mismatched metadata are rejected before sending document text', async () => {
  for (const data of [{}, metadata({ truncation: true }), metadata({ revision: '' }), metadata({ dimensions: 3 }),
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
  for (const endpoint of ['http://example.com/v1/embeddings', 'http://localhost.evil.test/v1/embeddings',
    'file:///tmp/secret', 'http://user:password@localhost:8001/v1/embeddings', 'http://localhost:8001/v1/embeddings?token=secret',
    'https://example.com/v1/chat/completions', 'https://example.com/v1/embeddings#secret']) {
    assert.throws(() => registry.describe({ ...binding, config: { endpoint } }), code('invalid-request'))
  }
  registry.dispose()
  const failed = new EmbeddingRegistry()
  failed.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => new Response('secret backend failure', { status: 500 })) as typeof fetch }))
  await assert.rejects(failed.embed({ texts: ['a'], purpose: 'document' }, binding), error => {
    assert.ok(error instanceof EmbeddingError)
    assert.equal((error as EmbeddingError & { status: number }).status, 500)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
  failed.dispose()
})

test('one service adapter accepts local and third-party endpoints using standard model and vector responses', async () => {
  for (const endpoint of ['http://localhost:8001/v1/embeddings', 'http://[::1]:8001/v1/embeddings', 'https://provider.example/api/v1/embeddings']) {
    const calls: string[] = []
    const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async (url, init) => {
      calls.push(String(url))
      assert.equal(init?.redirect, 'error')
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'provider-embedding' }] }))
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'provider-embedding', input: ['search words'], encoding_format: 'float' })
      return new Response(JSON.stringify({ model: 'provider-embedding', data: [{ index: 0, embedding: [3, 4] }] }))
    }) as typeof fetch })
    const registry = new EmbeddingRegistry()
    registry.register(engine)
    try {
      const configured = { ...binding, config: { endpoint, model: 'provider-embedding', dimensions: 2 } }
      assert.equal(registry.list()[0]!.execution, 'service')
      assert.deepEqual(await registry.availability(configured), { status: 'available' })
      assert.deepEqual((await registry.embed({ texts: ['search words'], purpose: 'query' }, configured)).vectors, [[0.6, 0.8]])
      assert.deepEqual(calls, [endpoint.replace(/embeddings$/, 'models'), endpoint])
      assert.equal(registry.describe(configured).modelRevision, 'unversioned')
    } finally { registry.dispose() }
  }
})

test('authentication is resolved once per operation and sent to both API requests without entering the model identity', async () => {
  let resolutions = 0, token = 'first-secret'
  const authorizations: Array<string | null> = []
  const engine = createOpenAiCompatibleEmbeddingEngine({
    async resolveCredential(reference) { assert.equal(reference, '_EMBEDDING_API_KEY'); resolutions++; return token },
    fetch: (async (url, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return String(url).endsWith('/models') ? reply(metadata()) : reply({ data: [{ index: 0, embedding: [1, 0] }] })
    }) as typeof fetch,
  })
  const registry = new EmbeddingRegistry()
  registry.register(engine)
  try {
    const configured = { ...binding, config: { ...binding.config, apiKeyRef: '_EMBEDDING_API_KEY' } }
    await registry.availability(configured)
    resolutions = 0; authorizations.length = 0
    const before = registry.describe(configured)
    await registry.embed({ texts: ['document'], purpose: 'document' }, configured)
    token = 'rotated-secret'
    await registry.embed({ texts: ['query'], purpose: 'query' }, configured)
    assert.equal(resolutions, 2)
    assert.deepEqual(authorizations, ['Bearer first-secret', 'Bearer rotated-secret', 'Bearer rotated-secret'])
    assert.deepEqual(registry.describe(configured), before)
    assert.equal(JSON.stringify(before).includes('secret'), false)
  } finally { registry.dispose() }
})

test('missing or invalid credentials stop before any request and provider errors do not leak secrets', async () => {
  for (const resolveCredential of [undefined, async () => undefined, async () => '', async () => 'key\ninvalid',
    async () => { throw new Error('private credential failure') }]) {
    let requests = 0
    const engine = createOpenAiCompatibleEmbeddingEngine({ resolveCredential, fetch: (async () => { requests++; throw new Error('unexpected fetch') }) as typeof fetch })
    const registry = new EmbeddingRegistry()
    registry.register(engine)
    try {
      await assert.rejects(registry.embed({ texts: ['document'], purpose: 'document' },
        { ...binding, config: { ...binding.config, apiKeyRef: 'EMBEDDING_API_KEY' } }), error => {
        assert.ok(error instanceof EmbeddingError)
        assert.equal(error.code, 'not-configured')
        assert.equal(error.message.includes('private'), false)
        return true
      })
      assert.equal(requests, 0)
    } finally { registry.dispose() }
  }
  const engine = createOpenAiCompatibleEmbeddingEngine()
  for (const apiKeyRef of ['sk-raw-key', 'HAS SPACE', 123, 'user/reference']) {
    assert.throws(() => engine.describe({ apiKeyRef }), code('invalid-request'))
  }
})

test('cancellation after model discovery prevents transmitting document text', async () => {
  const controller = new AbortController()
  let requests = 0
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => {
    requests++
    controller.abort(new Error('stop'))
    return reply(metadata())
  }) as typeof fetch })
  await assert.rejects(engine.embed({ texts: ['document'], purpose: 'document', signal: controller.signal, timeoutMs: 1000 }, binding.config), /stop/)
  assert.equal(requests, 1)
})

test('cache identity is internally managed from the service and encoding configuration', () => {
  const engine = createOpenAiCompatibleEmbeddingEngine()
  const initial = engine.describe({})
  const configurations: Parameters<typeof engine.describe>[0][] = [
    { endpoint: 'https://provider.example/v1/embeddings' }, { model: 'other-embedding' },
    { dimensions: 2 }, { queryInstruction: QWEN3_RETRIEVAL_INSTRUCTION },
  ]
  for (const config of configurations) {
    assert.notEqual(engine.describe(config).fingerprint, initial.fingerprint)
  }
  assert.equal(engine.descriptor.configurationFields?.some(field => field.key === 'modelRevision'), false)
  assert.deepEqual(engine.describe({ modelRevision: 'retired-user-tag' }), initial)
})

test('server revisions are checked within an operation without requiring a configured revision', async () => {
  for (const revision of ['server-build-1', 'server-build-2']) {
    const registry = new EmbeddingRegistry()
    registry.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async url => String(url).endsWith('/models')
      ? reply(metadata({ revision })) : new Response(JSON.stringify({ model_revision: revision, data: [{ index: 0, embedding: [1, 0] }] }))) as typeof fetch }))
    try {
      assert.deepEqual((await registry.embed({ texts: ['document'], purpose: 'document' }, binding)).vectors, [[1, 0]])
    } finally { registry.dispose() }
  }
})

test('a service advertising the revision contract must echo it for the embedding response', async () => {
  const registry = new EmbeddingRegistry()
  registry.register(createOpenAiCompatibleEmbeddingEngine({ fetch: (async url => String(url).endsWith('/models')
    ? reply(metadata()) : new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))) as typeof fetch }))
  try {
    await assert.rejects(registry.embed({ texts: ['document'], purpose: 'document' }, binding), code('invalid-result'))
  } finally { registry.dispose() }
})

test('document encoding identity ignores query instructions and transport limits while query identity remains distinct', async () => {
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => reply(metadata())) as typeof fetch })
  const base = { dimensions: 2, queryInstruction: 'first query' }
  await engine.availability!(base, new AbortController().signal)
  const original = engine.describe(base)
  assert.equal(original.modelRevision, FIXTURE_MODEL_REVISION)
  const executionChanges: Parameters<typeof engine.describe>[0][] = [
    { maxBatchSize: 2 }, { maxInputCharacters: 1000 }, { queryInstruction: 'another query' },
  ]
  for (const change of executionChanges) {
    const changed = engine.describe({ ...base, ...change })
    assert.equal(changed.documentFingerprint, original.documentFingerprint,
      'unchanged document inputs and weights produce interchangeable document vectors')
    assert.equal(changed.modelRevision, original.modelRevision, 'transport and query changes do not forget learned model metadata')
    if ('queryInstruction' in change) assert.notEqual(changed.fingerprint, original.fingerprint)
    else assert.equal(changed.fingerprint, original.fingerprint)
  }
  const encodingChanges: Parameters<typeof engine.describe>[0][] = [
    { model: 'other-model' }, { dimensions: 3 }, { endpoint: 'https://other.example/v1/embeddings' },
  ]
  for (const change of encodingChanges) {
    assert.notEqual(engine.describe({ ...base, ...change }).documentFingerprint, original.documentFingerprint)
  }
})

test('credential changes stay isolated until the service attests the same model revision', async () => {
  const engine = createOpenAiCompatibleEmbeddingEngine({ resolveCredential: async () => 'fixture-key',
    fetch: (async () => reply(metadata())) as typeof fetch })
  const first = { dimensions: 2, apiKeyRef: 'FIRST_ACCOUNT' }, second = { dimensions: 2, apiKeyRef: 'SECOND_ACCOUNT' }
  assert.notEqual(engine.describe(first).documentFingerprint, engine.describe(second).documentFingerprint)
  await engine.availability!(first, new AbortController().signal)
  await engine.availability!(second, new AbortController().signal)
  assert.equal(engine.describe(first).documentFingerprint, engine.describe(second).documentFingerprint)
})

test('availability and successive embedding batches reuse only fresh successful model checks', async () => {
  let time = 0, gets = 0, posts = 0, revision = 'first'
  const metrics: IndexPerformanceMetric[] = []
  const engine = createOpenAiCompatibleEmbeddingEngine({ now: () => time, fetch: (async url => {
    if (String(url).endsWith('/models')) { gets++; return reply(metadata({ revision })) }
    posts++; return reply({ model_revision: revision, data: [{ index: 0, embedding: [1, 0] }] })
  }) as typeof fetch })
  const registry = new EmbeddingRegistry(); registry.register(engine)
  try {
    await withIndexPerformance(metric => metrics.push(metric), async () => {
      assert.deepEqual(await registry.availability(binding), { status: 'available' })
      for (let i = 0; i < 4; i++) await registry.embed({ texts: [`batch ${i}`], purpose: 'document' }, binding)
      assert.equal(gets, 1); assert.equal(posts, 4)
      time = 1999
      await registry.availability(binding)
      assert.equal(gets, 1, 'Fresh checks can be reused, but hits do not extend their expiry')
      time = 2000; revision = 'second'
      await registry.embed({ texts: ['next batch'], purpose: 'document' }, binding)
      assert.equal(gets, 2); assert.equal(posts, 5)
      assert.equal(registry.describe(binding).modelRevision, 'second')
    })
    assert.equal(metrics.filter(metric => metric.stage === 'metadata-http').length, 2)
    assert.equal(metrics.filter(metric => metric.stage === 'embedding-http').length, 5)
    assert.ok(metrics.every(metric => metric.requests === 1 && metric.durationMs >= 0))
  } finally { registry.dispose() }
})

test('concurrent callers share discovery and one cancelled waiter cannot abort the other request', async () => {
  const gate = deferred(), started = deferred(), first = new AbortController(), second = new AbortController()
  let gets = 0, posts = 0, probeSignal: AbortSignal | null | undefined
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async (url, init) => {
    if (String(url).endsWith('/models')) {
      gets++; probeSignal = init?.signal; started.resolve(); await gate.promise; return reply(metadata())
    }
    posts++; return reply({ data: [{ index: 0, embedding: [1, 0] }] })
  }) as typeof fetch })
  const available = engine.availability!(binding.config, first.signal)
  const cancelled = assert.rejects(available, /leave first/)
  const embedded = engine.embed({ texts: ['still needed'], purpose: 'document', signal: second.signal, timeoutMs: 1000 }, binding.config)
  await started.promise; await nextTurn()
  first.abort(new Error('leave first')); await cancelled
  assert.equal(probeSignal?.aborted, false)
  gate.resolve()
  const output = await embedded
  assert.ok('vectors' in output)
  assert.deepEqual(output.vectors, [[1, 0]])
  assert.equal(gets, 1); assert.equal(posts, 1)
})

test('all waiters leaving cancel discovery and a late noncooperative result is never cached', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  let gets = 0, sharedSignal: AbortSignal | null | undefined
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async (_url, init) => {
    gets++
    if (gets === 1) { sharedSignal = init?.signal; started.resolve(); await gate.promise }
    return reply(metadata())
  }) as typeof fetch })
  const pending = engine.availability!(binding.config, controller.signal)
  const cancelled = assert.rejects(pending, /leave all/)
  await started.promise; controller.abort(new Error('leave all')); await cancelled
  assert.equal(sharedSignal?.aborted, true)
  await assert.rejects(engine.availability!(binding.config, new AbortController().signal), code('engine-unavailable'))
  assert.equal(gets, 1, 'A draining fetch cannot admit unlimited replacement work')
  gate.resolve(); await nextTurn()
  await engine.availability!(binding.config, new AbortController().signal)
  assert.equal(gets, 2, 'An aborted probe is not a successful cache entry')
})

test('failed discovery is retried and metadata cache isolates endpoint, model, dimensions and advertised limits', async () => {
  let gets = 0, failed = true
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => {
    gets++
    if (failed) throw new Error('offline')
    return new Response(JSON.stringify({ data: [{ id: 'one' }, { id: 'two' }] }))
  }) as typeof fetch })
  const base = { model: 'one', dimensions: 2 }, active = new AbortController().signal
  await assert.rejects(engine.availability!(base, active), /offline/)
  failed = false
  await engine.availability!(base, active); await engine.availability!({ ...base, queryInstruction: 'query only' }, active)
  assert.equal(gets, 2)
  const changes: Parameters<typeof engine.describe>[0][] = [{ endpoint: 'https://another.example/v1/embeddings' },
    { model: 'two' }, { dimensions: 3 }, { maxBatchSize: 1 }, { maxInputCharacters: 1000 }]
  for (const change of changes) {
    await engine.availability!({ ...base, ...change }, active)
  }
  assert.equal(gets, 7, 'Every distinct advertised capability/configuration needs its own attestation')
})

test('a changed embedding revision invalidates the fresh discovery entry and retries verify the new metadata', async () => {
  let gets = 0, revision = 'first'
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async url => {
    if (String(url).endsWith('/models')) { gets++; return reply(metadata({ revision })) }
    return reply({ model_revision: revision, data: [{ index: 0, embedding: [1, 0] }] })
  }) as typeof fetch })
  const registry = new EmbeddingRegistry(); registry.register(engine)
  try {
    await registry.availability(binding); revision = 'new deployment'
    await assert.rejects(registry.embed({ texts: ['document'], purpose: 'document' }, binding), code('invalid-result'))
    assert.equal(gets, 1, 'The stale cached contract is still checked against the actual vector response')
    await registry.embed({ texts: ['document'], purpose: 'document' }, binding)
    assert.equal(gets, 2); assert.equal(registry.describe(binding).modelRevision, revision)
  } finally { registry.dispose() }
})

test('discovery success and pending request caches stay bounded', async () => {
  let gets = 0
  const engine = createOpenAiCompatibleEmbeddingEngine({ now: () => 0, fetch: (async () => {
    gets++; return reply(metadata())
  }) as typeof fetch })
  const active = new AbortController().signal
  const configured = (n: number) => ({ ...binding.config, endpoint: `https://provider${n}.example/v1/embeddings` })
  for (let i = 0; i < 129; i++) await engine.availability!(configured(i), active)
  await engine.availability!(configured(128), active); assert.equal(gets, 129)
  await engine.availability!(configured(0), active); assert.equal(gets, 130, 'The oldest successful entry was evicted')

  const gate = deferred(); gets = 0
  const blocked = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => {
    gets++; await gate.promise; return reply(metadata())
  }) as typeof fetch })
  const checks = Array.from({ length: 32 }, (_, i) => blocked.availability!(configured(i), active))
  await nextTurn()
  try {
    await assert.rejects(blocked.availability!(configured(32), active), code('engine-unavailable'))
    assert.equal(gets, 32)
  } finally { gate.resolve(); await Promise.all(checks) }
})

test('unregistering an engine still cancels pending discovery and prevents vector transmission', async () => {
  const gate = deferred(), started = deferred(); let posts = 0
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async url => {
    if (String(url).endsWith('/models')) { started.resolve(); await gate.promise; return reply(metadata()) }
    posts++; return reply({ data: [{ index: 0, embedding: [1, 0] }] })
  }) as typeof fetch })
  const registry = new EmbeddingRegistry(), unregister = registry.register(engine)
  try {
    const request = registry.embed({ texts: ['document'], purpose: 'document' }, binding)
    const rejected = assert.rejects(request, code('engine-unavailable'))
    await started.promise; unregister(); await rejected
    gate.resolve(); await nextTurn(); assert.equal(posts, 0)
  } finally { gate.resolve(); registry.dispose() }
})

test('oversized declared responses, empty bodies, malformed JSON and interrupted streams reject before reuse', async () => {
  const responses = [
    { response: () => new Response('{}', { headers: { 'content-length': '100000' } }), error: code('limit-exceeded') },
    { response: () => new Response(null), error: code('invalid-result') },
    { response: () => new Response('not JSON'), error: code('invalid-result') },
    { response: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket interrupted')) } })), error: /socket interrupted/ },
  ]
  for (const { response, error } of responses) {
    let gets = 0
    const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => { gets++; return response() }) as typeof fetch })
    for (let retry = 0; retry < 2; retry++) await assert.rejects(engine.availability!(binding.config, new AbortController().signal), error)
    assert.equal(gets, 2, 'An invalid or interrupted model check is never cached as success')
  }
})

test('an explicitly null cancellation reason still cancels the waiter and its abandoned probe', async () => {
  const gate = deferred(), started = deferred(), abort = new AbortController()
  const engine = createOpenAiCompatibleEmbeddingEngine({ fetch: (async () => {
    started.resolve(); await gate.promise; return reply(metadata())
  }) as typeof fetch })
  const check = engine.availability!(binding.config, abort.signal)
  const rejected = assert.rejects(check, { name: 'AbortError' })
  await started.promise; abort.abort(null); await rejected
  gate.resolve(); await nextTurn()
})
