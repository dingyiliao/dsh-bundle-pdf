import assert from 'node:assert/strict'
import test from 'node:test'
import { HostOcrService, type HostOcrBackend, type HostOcrRequest } from '../../../src/modules/ocr/index.js'
import { OcrError, type OcrOutput } from '../../../src/ocr/types.js'
import type { EngineConfiguration } from '../../../src/modules/engines/index.js'

const descriptor = {
  id: 'test-backend', name: 'Test OCR', version: '1', execution: 'local' as const,
  geometry: [] as const, confidence: false,
}
const output = (): OcrOutput => ({ text: 'readable', blocks: [], lines: [], words: [],
  confidence: null, status: 'complete', coverage: [], warnings: [] })
const request = (signal?: AbortSignal): HostOcrRequest => ({ sessionId: 'session-1',
  image: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 2, height: 2,
  languages: ['eng'], signal })
const errorCode = (code: string) => (error: unknown) => error instanceof OcrError && error.code === code
const backend = (overrides: Partial<HostOcrBackend> = {}): HostOcrBackend => ({ descriptor,
  async availability() { return { status: 'available' } },
  async recognize() { return output() }, ...overrides })

test('OCR backend registry exposes copies and a stale disposer cannot remove its successor', async () => {
  const service = new HostOcrService(() => descriptor.id)
  try {
    assert.deepEqual(service.list(), [])
    assert.equal(service.selectedDescriptor(), undefined)
    assert.deepEqual(await service.availability('session-1'),
      { status: 'unavailable', reason: 'The selected OCR backend is not installed.' })
    assert.throws(() => service.register(backend({ descriptor: { ...descriptor, id: '' } })))
    const first = service.register(backend())
    assert.throws(() => service.register(backend()))
    const listed = service.list()
    listed[0]!.name = 'Changed outside registry'
    assert.equal(service.list()[0]?.name, descriptor.name)
    const selected = service.selectedDescriptor()!
    selected.name = 'Changed outside registry'
    assert.equal(service.selectedDescriptor()?.name, descriptor.name)
    assert.deepEqual(await service.availability('  '),
      { status: 'not-configured', reason: 'OCR requires a session.' })
    first()
    const second = service.register(backend())
    first()
    assert.deepEqual(service.list().map(item => item.id), [descriptor.id])
    second()
    assert.deepEqual(service.list(), [])
  } finally { service.dispose() }
  assert.throws(() => service.register(backend()), errorCode('engine-unavailable'))
  service.dispose()
})

test('staged Blob bytes, languages and options are copied before a model can consume them', async () => {
  const service = new HostOcrService(() => descriptor.id)
  const originalLanguages = ['eng']
  const originalOptions = { scale: 2 }
  service.register(backend({ async recognize(input) {
    assert.ok(input.image instanceof Uint8Array)
    assert.deepEqual([...input.image], [1, 2, 3])
    assert.deepEqual(input.languages, ['eng'])
    assert.deepEqual(input.options, { scale: 2 })
    return output()
  } }))
  try {
    const handle = await service.stageImage({ ...request(), image: new Blob([new Uint8Array([1, 2, 3])]),
      languages: originalLanguages, options: originalOptions })
    originalLanguages[0] = 'fra'
    originalOptions.scale = 99
    const result = await service.recognizeStaged(handle, 'session-1', new AbortController().signal)
    assert.equal(result.text, 'readable')
    assert.deepEqual(result.source, { backendId: descriptor.id, backendVersion: descriptor.version })
  } finally { service.dispose() }
})

test('OCR service wraps backend faults and propagates caller cancellation and timeout', async () => {
  const service = new HostOcrService(() => descriptor.id)
  const unregister = service.register(backend({ async recognize() { throw new Error('private backend failure') } }))
  try {
    await assert.rejects(service.recognize(request()), errorCode('recognition-failed'))
  } finally { unregister() }
  const stop = service.register(backend({ async recognize() { return new Promise<OcrOutput>(() => undefined) } }))
  try {
    const controller = new AbortController()
    const pending = service.recognize(request(controller.signal))
    controller.abort()
    await assert.rejects(pending, errorCode('cancelled'))
    await assert.rejects(service.recognize({ ...request(), timeoutMs: 1 }), errorCode('timeout'))
  } finally { stop(); service.dispose() }
})

test('disposing staged image storage cancels auxiliary consumers and releases producer pins', async () => {
  const service = new HostOcrService(() => 'missing')
  let released = 0
  const handle = await service.stageImage({ ...request(), image: new Uint8Array([1]) }, {
    async acquire() { return () => { released++ } }, async validate() {},
  })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const pending = service.withStagedImage(handle, 'session-1', new AbortController().signal,
    async (_image, _record, activeSignal) => {
      started()
      await new Promise<never>((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true })
      })
    })
  await ready
  service.dispose()
  await assert.rejects(pending, { code: 'cancelled' })
  assert.equal(released, 1)
})

test('a pixel-free result guard keeps owner validation and cancels on service unload', async () => {
  const service = new HostOcrService(() => 'missing')
  let released = 0
  const handle = await service.stageImage({ ...request(), image: new Uint8Array([1]) }, {
    async acquire() { return () => { released++ } }, async validate() {},
  })
  const guard = service.imageResultGuard(handle, 'session-1')
  await assert.rejects(guard.run('foreign', new AbortController().signal, async () => 'hidden'), { code: 'invalid-request' })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const pending = guard.run('session-1', new AbortController().signal, async activeSignal => {
    started()
    await new Promise<never>((_resolve, reject) => {
      activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true })
    })
  })
  await ready
  service.dispose()
  await assert.rejects(pending, { code: 'cancelled' })
  await assert.rejects(guard.run('session-1', new AbortController().signal, async () => 'hidden'), { code: 'engine-unavailable' })
  assert.equal(released, 1)
})

test('a producer lifetime abort cancels an active pixel-free result read and purges its staged input', async () => {
  const service = new HostOcrService(() => 'missing')
  const producer = new AbortController()
  let released = 0
  const handle = await service.stageImage({ ...request(), image: new Uint8Array([1]) }, {
    signal: producer.signal, async acquire() { return () => { released++ } }, async validate() {},
  })
  const guard = service.imageResultGuard(handle, 'session-1')
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const pending = guard.run('session-1', new AbortController().signal, async activeSignal => {
    started()
    await new Promise<never>((_resolve, reject) => {
      activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true })
    })
  })
  await ready
  producer.abort(Object.assign(new Error('Producer unloaded'), { code: 'pdf/unavailable' }))
  await assert.rejects(pending, { code: 'pdf/unavailable' })
  await assert.rejects(service.withStagedImage(handle, 'session-1', new AbortController().signal, async () => ''), { code: 'invalid-request' })
  assert.equal(released, 1)
  service.dispose()
})

test('OCR identity validates contributor configuration before asking the backend for an attestation', async () => {
  const service = new HostOcrService(() => descriptor.id), signal = new AbortController().signal
  let probes = 0
  service.register(backend({
    descriptor: { ...descriptor, configurationFields: [{ key: 'model', label: 'Model', type: 'string', required: true }] },
    async cacheIdentity(_session, _signal, config) {
      probes++; assert.deepEqual(config, { model: 'ocr-one' }); return 'ocr-one-revision'
    },
  }))
  try {
    const invalid: EngineConfiguration[] = [{}, { model: false }, { model: 'ocr-one', undeclared: true }]
    for (const config of invalid) {
      await assert.rejects(service.cacheIdentity('session-1', signal, { engineId: descriptor.id, config }), errorCode('not-configured'))
    }
    assert.equal(probes, 0, 'invalid bindings must never reach contributor code')
    const identity = await service.cacheIdentity('session-1', signal, { engineId: descriptor.id, config: { model: 'ocr-one' } })
    assert.equal(identity.backendId, descriptor.id); assert.equal(identity.reusable, true)
    assert.equal(probes, 1)
  } finally { service.dispose() }
})

test('OCR identity rejects a completed attestation when its provider unloads before Host adoption', async () => {
  for (const action of ['remove', 'replace', 'dispose'] as const) {
    const service = new HostOcrService(() => descriptor.id), signal = new AbortController().signal
    let stop!: () => void
    let produced = false
    stop = service.register(backend({ cacheIdentity() {
      const completed = Promise.resolve('retired-model')
      // Completion and plugin unload race before the Host can adopt the result;
      // replacing a provider under the same ID cannot reuse the retired proof.
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
      await assert.rejects(service.cacheIdentity('session-1', signal), error =>
        errorCode('engine-unavailable')(error) && (error as Error).message === 'The OCR backend was removed.')
      assert.equal(produced, true)
      if (action === 'replace') {
        const current = await service.cacheIdentity('session-1', signal)
        assert.equal(current.backendId, descriptor.id); assert.equal(current.reusable, true)
      } else assert.equal(service.generation(), undefined)
    } finally { service.dispose() }
  }
})
