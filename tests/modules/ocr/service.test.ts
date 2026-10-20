import assert from 'node:assert/strict'
import test from 'node:test'
import { HostOcrService, type HostOcrBackend, type HostOcrRequest } from '../../../src/modules/ocr/index.js'
import { OcrError, type OcrOutput } from '../../../src/ocr/types.js'

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
