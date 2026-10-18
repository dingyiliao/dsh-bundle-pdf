import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/host/image-understanding-plugin.ts'
import { HostImageUnderstandingService, ImageUnderstandingError,
  createOcrTextBackend, createSessionVisionBackend, type ImageUnderstandingBackend,
  type ImageUnderstandingRequest } from '../src/host/image-understanding-service.ts'
import { createImageUnderstandingDispatch } from '../src/host/image-understanding-transport.ts'
import { HostOcrService } from '../src/host/ocr-service.ts'
import type { OcrOutput } from '../src/ocr/types.ts'

function png(width = 12, height = 9): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([73, 72, 68, 82], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function request(signal = new AbortController().signal): ImageUnderstandingRequest {
  return { sessionId: 'session-1', image: { mediaType: 'image/png', data: png(), width: 12, height: 9 },
    question: 'What does this region mean?', signal }
}

const agent = { session: { id: 'session-1', header: {} } }

test('image Host defaults to the current session vision backend', () => {
  assert.deepEqual(Config.parse(undefined), { backend: 'session-vision' })
  assert.deepEqual(Config.parse({ backend: 'auxiliary-vision', auxiliaryVision: {
    provider: 'configured-provider', model: 'configured-vision', maxOutputTokens: 2048,
  } }), { backend: 'auxiliary-vision', auxiliaryVision: {
    provider: 'configured-provider', model: 'configured-vision', maxOutputTokens: 2048,
  } })
})

test('direct image backend follows declared image capability of the current session model', async () => {
  let model = 'text-only'
  let checked = 0
  const backend = createSessionVisionBackend({ get(key: string) {
    if (key === 'sessionController') return { async resolveAgent(id: string) {
      assert.equal(id, 'session-1')
      return { agent: { session: { requestHeader: () => ({ config: { provider: 'test', model } }) } } }
    } }
    if (key === 'llm') return { async resolveModelInfo(provider: string, name: string) {
      checked++
      assert.equal(provider, 'test')
      return { inputModalities: name === 'vision' ? ['text', 'image'] : ['text'] }
    } }
    return undefined
  } } as never)
  const service = new HostImageUnderstandingService(new Context(), () => 'session-vision')
  service.register(backend)
  try {
    assert.deepEqual(await service.availability('session-1', request().signal),
      { status: 'unavailable', reason: 'The current session model does not declare image input.' })
    await assert.rejects(service.prepare(request()), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-unavailable')
    model = 'vision'
    assert.deepEqual(await service.availability('session-1', request().signal),
      { status: 'available', kind: 'direct-image', backendId: 'session-vision' })
    assert.deepEqual(await service.prepare(request()), { kind: 'direct-image', backendId: 'session-vision',
      provenance: { backendId: 'session-vision', mode: 'session-vision' } })
    assert.ok(checked >= 4)
  } finally { service.dispose() }
})

test('selected backend registration is scoped, and removal aborts in-flight preparation', async () => {
  const service = new HostImageUnderstandingService(new Context(), () => 'community-description')
  let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const backend: ImageUnderstandingBackend = {
    id: 'community-description', kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare() { started(); return new Promise<never>(() => undefined) },
  }
  const unregister = service.register(backend)
  assert.deepEqual(service.list(), [{ id: 'community-description', kind: 'derived-text' }])
  try {
    const pending = service.prepare(request())
    await began
    unregister()
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-unavailable')
    assert.deepEqual(service.list(), [])
    assert.equal((await service.availability('session-1', request().signal)).status, 'unavailable')
  } finally { service.dispose() }
})

test('backend output is bounded and a selected unavailable backend does not silently fall back', async () => {
  const service = new HostImageUnderstandingService(new Context(), () => 'community-description')
  service.register({ id: 'session-vision', kind: 'direct-image',
    async availability() { return { available: true } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } } })
  assert.deepEqual(await service.availability('session-1', request().signal), {
    status: 'unavailable', reason: 'The selected image backend is not installed.',
  })
  service.register({ id: 'community-description', kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare() { return { kind: 'derived-text', mode: 'image-description', text: 'x'.repeat(32_769) } },
  })
  try {
    await assert.rejects(service.prepare(request()), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-result')
  } finally { service.dispose() }
})

test('OCR text backend is explicit and reports that it cannot interpret diagrams', async () => {
  const ocr = new HostOcrService(new Context(), () => 'local-ocr')
  const output: OcrOutput = { text: 'A visible label', blocks: [], lines: [], words: [], confidence: null,
    status: 'complete', coverage: [], warnings: [] }
  ocr.register({
    descriptor: { id: 'local-ocr', name: 'Local OCR', version: '1', execution: 'local', geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize(input) { assert.equal(input.mediaType, 'image/png'); return output },
  })
  const service = new HostImageUnderstandingService(new Context(), () => 'ocr-text')
  service.register(createOcrTextBackend({ get: (key: string) => key === 'ocr' ? ocr : undefined } as never))
  try {
    assert.deepEqual(await service.availability('session-1', request().signal), {
      status: 'available', kind: 'derived-text', backendId: 'ocr-text',
      limitation: 'OCR extracts visible text only; diagrams and layout are not understood.',
    })
    assert.deepEqual(await service.prepare(request()), { kind: 'derived-text', text: 'A visible label',
      provenance: { backendId: 'ocr-text', mode: 'ocr-text' },
      limitations: 'OCR extracts visible text only; visual structure and diagrams may be missing.' })
  } finally { service.dispose(); ocr.dispose() }
})

test('authenticated image dispatch rejects mismatched sessions, malformed image data, and spoofed dimensions', async () => {
  const service = new HostImageUnderstandingService(new Context(), () => 'test')
  service.register({ id: 'test', kind: 'direct-image', async availability() { return { available: true } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } } })
  const dispatch = createImageUnderstandingDispatch(service)
  const data = Buffer.from(png()).toString('base64')
  const input = { action: 'prepare', sessionId: 'session-1', image: {
    mediaType: 'image/png', data, width: 12, height: 9 }, question: 'Explain.' }
  try {
    await assert.rejects(dispatch('session-2', input, agent, request().signal), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/session-mismatch')
    await assert.rejects(dispatch('session-1', { ...input, image: { ...input.image, data: `${data} ` } },
      agent, request().signal), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-request')
    await assert.rejects(dispatch('session-1', { ...input, image: { ...input.image, height: 10 } },
      agent, request().signal), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-request')
    assert.equal((await dispatch('session-1', input, agent, request().signal) as { kind: string }).kind, 'direct-image')
  } finally { service.dispose() }
})
