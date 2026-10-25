import assert from 'node:assert/strict'
import test from 'node:test'
import { HostImageUnderstandingService, ImageUnderstandingError,
  type ImageUnderstandingBackend, type ImageUnderstandingRequest } from '../../../src/modules/image-understanding/index.js'
import { createOcrTextBackend, createSessionVisionBackend } from '../../../src/adapters/host/dsh/image-backends.js'

function request(signal = new AbortController().signal): ImageUnderstandingRequest {
  const data = new Uint8Array(24)
  data.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  data.set([73, 72, 68, 82], 12)
  new DataView(data.buffer).setUint32(16, 1)
  new DataView(data.buffer).setUint32(20, 1)
  return { sessionId: 'session-1', question: 'Explain this region',
    image: { mediaType: 'image/png', data, width: 1, height: 1 }, signal }
}

function backend(overrides: Partial<ImageUnderstandingBackend> = {}): ImageUnderstandingBackend {
  return { id: 'test-backend', kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare() { return { kind: 'derived-text', text: 'A valid description', mode: 'image-description' } },
    ...overrides }
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ImageUnderstandingError && error.code === code
}

test('backend IDs are constrained, duplicate IDs rejected, and a disposer never removes a successor', () => {
  const service = new HostImageUnderstandingService(() => 'test-backend')
  try {
    for (const id of ['', 'Uppercase', 'contains space', 'a'.repeat(129)]) {
      assert.throws(() => service.register(backend({ id })), hasCode('pdf/image-invalid-backend'))
    }
    const first = service.register(backend())
    assert.throws(() => service.register(backend()), hasCode('pdf/image-invalid-backend'))
    first()
    const second = service.register(backend())
    first()
    assert.deepEqual(service.list().map(({ id, kind }) => ({ id, kind })), [{ id: 'test-backend', kind: 'derived-text' }])
    second()
    assert.deepEqual(service.list(), [])
    service.dispose()
    assert.throws(() => service.register(backend()), hasCode('pdf/image-unavailable'))
    service.dispose()
  } finally { service.dispose() }
})

test('availability rechecks a backend after awaiting it and preserves typed error messages', async () => {
  const service = new HostImageUnderstandingService(() => 'test-backend')
  let finish!: (result: { available: true }) => void
  let started!: () => void
  const called = new Promise<void>(resolve => { started = resolve })
  const disposer = service.register(backend({ async availability() {
    started()
    return new Promise(resolve => { finish = resolve })
  } }))
  try {
    const pending = service.availability('session-1', request().signal)
    await called
    disposer()
    finish({ available: true })
    assert.deepEqual(await pending, { status: 'unavailable', reason: 'The selected image backend was removed.' })

    const typed = service.register(backend({ async availability() {
      throw new ImageUnderstandingError('pdf/image-unavailable', 'Source is offline')
    } }))
    assert.deepEqual(await service.availability('session-1', request().signal),
      { status: 'unavailable', reason: 'Source is offline' })
    typed()
    service.register(backend({ async availability() { throw 'unknown backend failure' } }))
    assert.deepEqual(await service.availability('session-1', request().signal),
      { status: 'unavailable', reason: 'The image backend is unavailable.' })
    assert.deepEqual(await service.availability(' ', request().signal),
      { status: 'unavailable', reason: 'A valid session is required.' })
  } finally { service.dispose() }
})

test('availability propagates caller cancellation rather than treating it as a normal unavailable backend', async () => {
  const service = new HostImageUnderstandingService(() => 'test-backend')
  const controller = new AbortController()
  service.register(backend({ async availability(_sessionId, signal) {
    controller.abort(new Error('caller cancelled'))
    signal.throwIfAborted()
    return { available: true }
  } }))
  try {
    await assert.rejects(service.availability('session-1', controller.signal), /caller cancelled/)
  } finally { service.dispose() }
})

test('preparation rejects malformed request metadata and mismatched backend result kind', async () => {
  const service = new HostImageUnderstandingService(() => 'test-backend')
  service.register(backend({ async prepare() {
    return { kind: 'direct-image', mode: 'session-vision' } as never
  } }))
  try {
    await assert.rejects(service.prepare({ ...request(), question: '' }), hasCode('pdf/image-invalid-request'))
    await assert.rejects(service.prepare({ ...request(), image: { ...request().image, width: 2 } }),
      hasCode('pdf/image-invalid-request'))
    await assert.rejects(service.prepare(request()), hasCode('pdf/image-invalid-result'))
  } finally { service.dispose() }
})

test('third-party output provenance is validated and arbitrary engine failures stay private', async () => {
  for (const value of [null, { kind: 'direct-image', mode: 'invalid' },
    { kind: 'derived-text', text: 'Fixture', mode: 'invalid' },
    { kind: 'derived-text', text: 'Fixture', mode: 'image-description', model: 42 },
    { kind: 'derived-text', text: 'Fixture', mode: 'image-description', limitations: 42 }]) {
    const service = new HostImageUnderstandingService(() => 'test-backend')
    service.register(backend({ kind: value?.kind === 'direct-image' ? 'direct-image' : 'derived-text',
      async prepare() { return value as never } }))
    try { await assert.rejects(service.prepare(request()), hasCode('pdf/image-invalid-result')) }
    finally { service.dispose() }
  }
  const service = new HostImageUnderstandingService(() => 'test-backend')
  service.register(backend({ async prepare() { throw new Error('private provider details') } }))
  try {
    await assert.rejects(service.prepare(request()), error => error instanceof ImageUnderstandingError
      && error.code === 'pdf/image-failed' && !error.message.includes('private'))
  } finally { service.dispose() }
})

test('image preparation validates contributor configuration and availability checks immutable registration identity', async () => {
  const service = new HostImageUnderstandingService(() => 'test-backend')
  let id = 'test-backend'
  service.register({ get id() { return id }, kind: 'derived-text',
    descriptor: { id, name: 'Fixture image', version: '1', execution: 'local',
      configurationFields: [{ key: 'style', label: 'Style', type: 'string', required: true }] },
    async availability() { id = 'changed-backend'; return { available: true } },
    async prepare() { return { kind: 'derived-text', text: 'Fixture', mode: 'image-description' } },
  })
  try {
    await assert.rejects(service.prepare(request()), hasCode('pdf/image-not-configured'))
    const result = await service.availability('session-1', request().signal, { engineId: 'test-backend', config: { style: 'short' } })
    assert.deepEqual(result, { status: 'unavailable', reason: 'The selected image backend was removed.' })
  } finally { service.dispose() }
})

test('disposing image understanding aborts a backend currently preparing an image', async () => {
  const service = new HostImageUnderstandingService(() => 'test-backend')
  let started!: () => void
  const called = new Promise<void>(resolve => { started = resolve })
  service.register(backend({ async prepare() {
    started()
    return new Promise<never>(() => undefined)
  } }))
  const pending = service.prepare(request())
  await called
  service.dispose()
  await assert.rejects(pending, hasCode('pdf/image-unavailable'))
})

test('preparation refuses results from a contributor whose backend identity changed in flight', async () => {
  const service = new HostImageUnderstandingService(() => 'mutable-backend')
  let id = 'mutable-backend'
  service.register({
    get id() { return id }, kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare() {
      // Runtime backends are third-party objects. TypeScript readonly does not freeze them.
      id = 'different-backend'
      return { kind: 'derived-text', mode: 'image-description', text: 'Stale description' }
    },
  })
  try {
    await assert.rejects(service.prepare(request()), hasCode('pdf/image-unavailable'))
  } finally { service.dispose() }
})

test('session vision reports an unknown model lookup failure without leaking an arbitrary thrown value', async () => {
  const vision = createSessionVisionBackend({ get(key: string) {
    if (key === 'sessionController') return { async resolveAgent() { throw 'non-Error lookup failure' } }
    if (key === 'llm') return { async resolveModelInfo() { return { inputModalities: ['image'] } } }
    return undefined
  } } as never)
  assert.deepEqual(await vision.availability('session-1', request().signal),
    { available: false, reason: 'The session model is unavailable.' })
  await assert.rejects(vision.prepare(request()), hasCode('pdf/image-unavailable'))
})

test('OCR backend reports an unavailable OCR service and supplies a fallback reason', async () => {
  const withoutOcr = createOcrTextBackend({ get() { return undefined } } as never)
  assert.deepEqual(await withoutOcr.availability('session-1', request().signal),
    { available: false, reason: 'The OCR plugin is not installed.' })
  await assert.rejects(withoutOcr.prepare(request()), hasCode('pdf/image-unavailable'))
  const unavailable = createOcrTextBackend({ get() {
    return { async availability() { return { status: 'unavailable' } } }
  } } as never)
  assert.deepEqual(await unavailable.availability('session-1', request().signal),
    { available: false, reason: 'The selected OCR backend is unavailable.' })
})
