import assert from 'node:assert/strict'
import test from 'node:test'
import { HostImageUnderstandingService, ImageUnderstandingError,
  type ImageUnderstandingBackend, type ImageUnderstandingRequest } from '../../../src/modules/image-understanding/index.js'
import type { EngineConfiguration } from '../../../src/modules/engines/index.js'

function request(signal = new AbortController().signal): ImageUnderstandingRequest {
  const data = new Uint8Array(24)
  data.set([137, 80, 78, 71, 13, 10, 26, 10]); data.set([73, 72, 68, 82], 12)
  new DataView(data.buffer).setUint32(16, 1); new DataView(data.buffer).setUint32(20, 1)
  return { sessionId: 'session-1', prompt: 'Explain this region',
    image: { mediaType: 'image/png', data, width: 1, height: 1 }, signal }
}
const descriptor = { id: 'test-backend', name: 'Test vision', version: '2', execution: 'remote' as const }
function backend(overrides: Partial<ImageUnderstandingBackend> = {}): ImageUnderstandingBackend {
  return { descriptor, async availability() { return { available: true } },
    async understand() { return { text: 'A valid description' } }, ...overrides }
}
const hasCode = (code: string) => (error: unknown) => error instanceof ImageUnderstandingError && error.code === code

test('all image engines execute one image/prompt to text contract and publish its typed capability', async () => {
  const service = new HostImageUnderstandingService(() => descriptor.id)
  let calls = 0
  service.register(backend({ async understand(input) {
    calls++; assert.equal(input.prompt, request().prompt)
    input.image.data[0] = 0
    return { text: 'A figure.', model: 'vision/one' }
  } }))
  try {
    assert.deepEqual(service.selectedDescriptor()?.capabilities, ['image-description'])
    assert.deepEqual(await service.availability('session-1', request().signal), { status: 'available', backendId: descriptor.id })
    const input = request()
    assert.deepEqual(await service.understand(input), { text: 'A figure.',
      source: { backendId: descriptor.id, backendVersion: '2', model: 'vision/one' } })
    assert.equal(calls, 1)
    assert.equal(input.image.data[0], 137, 'contributors receive private image bytes')
  } finally { service.dispose() }
})

test('duplicate IDs are rejected and a stale disposer never removes a successor', () => {
  const service = new HostImageUnderstandingService(() => descriptor.id)
  try {
    assert.throws(() => service.register(backend({ descriptor: { ...descriptor, id: '' } })), hasCode('pdf/image-invalid-backend'))
    assert.throws(() => service.register(backend({ descriptor: { ...descriptor, id: 'contains space' } })))
    const first = service.register(backend())
    assert.throws(() => service.register(backend()), hasCode('pdf/image-invalid-backend'))
    first(); const second = service.register(backend()); first()
    assert.deepEqual(service.list().map(item => item.id), [descriptor.id])
    second(); assert.deepEqual(service.list(), [])
    service.dispose(); assert.throws(() => service.register(backend()), hasCode('pdf/image-unavailable'))
  } finally { service.dispose() }
})

test('availability revokes in-flight probes and preserves safe typed errors', async () => {
  const service = new HostImageUnderstandingService(() => descriptor.id)
  let finish!: (value: { available: true }) => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const stop = service.register(backend({ async availability() { entered(); return new Promise(resolve => { finish = resolve }) } }))
  try {
    const pending = service.availability('session-1', request().signal)
    await started; stop(); finish({ available: true })
    assert.deepEqual(await pending, { status: 'unavailable', reason: 'The selected image backend was removed.' })
    const typed = service.register(backend({ async availability() { throw new ImageUnderstandingError('pdf/image-unavailable', 'Source is offline') } }))
    assert.deepEqual(await service.availability('session-1', request().signal), { status: 'unavailable', reason: 'Source is offline' })
    typed(); service.register(backend({ async availability() { throw new Error('private provider details') } }))
    assert.deepEqual(await service.availability('session-1', request().signal), { status: 'unavailable', reason: 'The image backend is unavailable.' })
    assert.deepEqual(await service.availability(' ', request().signal), { status: 'unavailable', reason: 'A valid session is required.' })
  } finally { service.dispose() }
})

test('caller cancellation propagates through availability and understanding', async () => {
  for (const operation of ['availability', 'understand'] as const) {
    const controller = new AbortController(), service = new HostImageUnderstandingService(() => descriptor.id)
    service.register(backend({ async availability(_sessionId, signal) {
      controller.abort(new Error('caller cancelled')); signal.throwIfAborted(); return { available: true }
    } }))
    try { await assert.rejects(operation === 'availability' ? service.availability('session-1', controller.signal)
      : service.understand(request(controller.signal)), /caller cancelled/) }
    finally { service.dispose() }
  }
})

test('understanding rejects malformed requests and outputs without textual interpretations', async () => {
  const service = new HostImageUnderstandingService(() => descriptor.id)
  service.register(backend({ async understand() { return { kind: 'direct-image' } as never } }))
  try {
    await assert.rejects(service.understand({ ...request(), prompt: '' }), hasCode('pdf/image-invalid-request'))
    await assert.rejects(service.understand({ ...request(), image: { ...request().image, width: 2 } }), hasCode('pdf/image-invalid-request'))
    await assert.rejects(service.understand(request()), hasCode('pdf/image-invalid-result'))
  } finally { service.dispose() }
})

test('invalid contributor output and arbitrary failures never become successful interpretations', async () => {
  for (const value of [null, { text: '' }, { text: 'Fixture', model: 42 }, { text: 'Fixture', limitations: 42 }]) {
    const service = new HostImageUnderstandingService(() => descriptor.id)
    service.register(backend({ async understand() { return value as never } }))
    try { await assert.rejects(service.understand(request()), hasCode('pdf/image-invalid-result')) }
    finally { service.dispose() }
  }
  const service = new HostImageUnderstandingService(() => descriptor.id)
  service.register(backend({ async understand() { throw new Error('private provider details') } }))
  try { await assert.rejects(service.understand(request()), error => error instanceof ImageUnderstandingError
    && error.code === 'pdf/image-failed' && !error.message.includes('private')) }
  finally { service.dispose() }
})

test('configuration is validated and mutable registration identity cannot bypass an in-flight fence', async () => {
  const service = new HostImageUnderstandingService(() => descriptor.id)
  const mutable = { ...descriptor, configurationFields: [{ key: 'style', label: 'Style', type: 'string' as const, required: true }] }
  service.register(backend({ descriptor: mutable, async availability() { mutable.id = 'changed'; return { available: true } } }))
  try {
    await assert.rejects(service.understand(request()), hasCode('pdf/image-not-configured'))
    assert.deepEqual(await service.availability('session-1', request().signal, { engineId: 'test-backend', config: { style: 'short' } }),
      { status: 'unavailable', reason: 'The selected image backend was removed.' })
  } finally { service.dispose() }
})

test('disposing or unloading image understanding cancels a backend that does not cooperate', async () => {
  for (const disposeService of [true, false]) {
    const service = new HostImageUnderstandingService(() => descriptor.id)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const stop = service.register(backend({ async understand() { entered(); return new Promise(() => undefined) } }))
    const pending = service.understand(request()); await started
    if (disposeService) service.dispose(); else stop()
    await assert.rejects(pending, hasCode('pdf/image-unavailable')); service.dispose()
  }
})

test('results from a contributor whose identity changed during execution are rejected', async () => {
  const service = new HostImageUnderstandingService(() => descriptor.id), mutable = { ...descriptor }
  service.register(backend({ descriptor: mutable, async understand() { mutable.id = 'changed'; return { text: 'Stale' } } }))
  try { await assert.rejects(service.understand(request()), hasCode('pdf/image-unavailable')) }
  finally { service.dispose() }
})

test('image identity validates contributor configuration before asking the backend for an attestation', async () => {
  const service = new HostImageUnderstandingService(() => descriptor.id)
  let probes = 0
  service.register(backend({
    descriptor: { ...descriptor, configurationFields: [{ key: 'model', label: 'Model', type: 'string', required: true }] },
    async cacheIdentity(_session, _signal, config) {
      probes++; assert.deepEqual(config, { model: 'vision-one' }); return 'vision-one-revision'
    },
  }))
  try {
    const invalid: EngineConfiguration[] = [{}, { model: false }, { model: 'vision-one', undeclared: true }]
    for (const config of invalid) {
      await assert.rejects(service.cacheIdentity('session-1', request().signal, { engineId: descriptor.id, config }),
        hasCode('pdf/image-not-configured'))
    }
    assert.equal(probes, 0, 'invalid bindings must never reach contributor code')
    const identity = await service.cacheIdentity('session-1', request().signal,
      { engineId: descriptor.id, config: { model: 'vision-one' } })
    assert.equal(identity.backendId, descriptor.id); assert.equal(identity.reusable, true)
    assert.equal(probes, 1)
  } finally { service.dispose() }
})

test('image identity rejects a completed attestation when its provider unloads before Host adoption', async () => {
  for (const action of ['remove', 'replace', 'dispose'] as const) {
    const service = new HostImageUnderstandingService(() => descriptor.id)
    let stop!: () => void
    let produced = false
    stop = service.register(backend({ cacheIdentity() {
      const completed = Promise.resolve('retired-model')
      // The provider finishes successfully, then its plugin unloads in the same
      // microtask turn. An already settled probe must not bless this old generation.
      void completed.then(() => {
        produced = true
        if (action === 'dispose') service.dispose()
        else {
          stop()
          if (action === 'replace') service.register(backend({ async cacheIdentity() { return 'successor-model' } }))
        }
      })
      return completed
    } }))
    try {
      await assert.rejects(service.cacheIdentity('session-1', request().signal), error =>
        hasCode('pdf/image-unavailable')(error) && (error as Error).message === 'The selected image backend was removed.')
      assert.equal(produced, true)
      if (action === 'replace') {
        const current = await service.cacheIdentity('session-1', request().signal)
        assert.equal(current.backendId, descriptor.id); assert.equal(current.reusable, true)
      } else assert.equal(service.generation(), undefined)
    } finally { service.dispose() }
  }
})
