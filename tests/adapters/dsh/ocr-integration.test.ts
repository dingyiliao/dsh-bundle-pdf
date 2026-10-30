import assert from 'node:assert/strict'
import test from 'node:test'
import { OcrError, type OcrOutput } from '../../../src/ocr/types.js'
import { createSessionLlmOcrBackend, type SessionOcrAttachmentStore, type SessionOcrLlm } from '../../../src/adapters/host/dsh/ocr-session-llm.js'
import { HostOcrService, type HostOcrRequest } from '../../../src/modules/ocr/index.js'
import { resolveOcrSessionModel } from '../../../src/adapters/host/dsh/ocr-model-route.js'
import { Config as OcrConfig } from '../../../src/entrypoints/ocr-host.js'

const request = (signal?: AbortSignal): HostOcrRequest => ({
  sessionId: 'session-1', image: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png',
  width: 100, height: 200, languages: ['eng'], signal,
})
const reference = { attachmentId: 'sha256', mediaType: 'image/png', bytes: 4, width: 100, height: 200 }
const output = (): OcrOutput => ({ text: 'hello', blocks: [], lines: [], words: [], confidence: null,
  status: 'complete', coverage: [{ x0: 0, y0: 0, x1: 100, y1: 200 }], warnings: [] })
const hasCode = (code: string) => (error: unknown) => error instanceof OcrError && error.code === code

test('OCR plugin can load with no explicit configuration', () => {
  assert.deepEqual(OcrConfig.parse(undefined), { backend: 'session-llm' })
})

test('session OCR sends one durable image reference to the current vision model without writing Session', async () => {
  let saved = 0
  const attachments: SessionOcrAttachmentStore = {
    async saveImage(input) { saved++; assert.equal(input.mediaType, 'image/png'); return reference },
  }
  const llm: SessionOcrLlm = {
    async resolveModelInfo(provider, model) {
      assert.equal(provider, 'vision'); assert.equal(model, 'current');
      return { inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      assert.equal(options.provider, 'vision')
      assert.equal(options.sessionId, 'session-1')
      assert.equal(options.messages.length, 1)
      assert.deepEqual(options.messages[0]?.content[1], { type: 'image', attachment: reference })
      yield { type: 'text-delta', index: 0, text: 'hel' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const backend = createSessionLlmOcrBackend({ getLlm: () => llm, getAttachments: () => attachments,
    resolveModel: async () => ({ provider: 'vision', model: 'current' }) })
  const result = await backend.recognize(request())
  assert.equal(saved, 1)
  assert.equal(result.text, 'hello')
  assert.deepEqual(result.lines, [])
  assert.deepEqual(result.blocks[0]?.box, null)
  assert.ok(result.warnings.includes('geometry-unavailable'))
})

test('session OCR fails closed when image capability is absent or unknown', async () => {
  let saved = 0
  const backend = createSessionLlmOcrBackend({
    getLlm: () => ({
      async resolveModelInfo() { return {} },
      async *stream() { throw new Error('must not call') },
    }),
    getAttachments: () => ({ async saveImage() { saved++; return reference } }),
    resolveModel: async () => ({ provider: 'text', model: 'current' }),
  })
  assert.equal((await backend.availability('session-1', new AbortController().signal)).status, 'unavailable')
  await assert.rejects(backend.recognize(request()), hasCode('engine-unavailable'))
  assert.equal(saved, 0)
})

test('session OCR availability follows the current session model instead of a Client-side toggle', async () => {
  let selectedModel = 'text-only'
  let uploads = 0
  const backend = createSessionLlmOcrBackend({
    getLlm: () => ({
      async resolveModelInfo(_provider, model) {
        return { inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }
      },
      async *stream() { throw new Error('availability must not invoke the model') },
    }),
    getAttachments: () => ({ async saveImage() { uploads++; return reference } }),
    resolveModel: async (sessionId) => {
      assert.equal(sessionId, 'session-1')
      return { provider: 'provider', model: selectedModel }
    },
  })
  const signal = new AbortController().signal
  assert.equal((await backend.availability('session-1', signal)).status, 'unavailable')
  selectedModel = 'vision'
  assert.deepEqual(await backend.availability('session-1', signal), { status: 'available' })
  selectedModel = 'text-only'
  assert.equal((await backend.availability('session-1', signal)).status, 'unavailable')
  assert.equal(uploads, 0)
})

test('the Host service cancels in-flight work when a backend is unregistered', async () => {
  const service = new HostOcrService(() => 'local-test')
  let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const unregister = service.register({
    descriptor: { id: 'local-test', name: 'Local test', version: '1', execution: 'local', geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize() { started(); return new Promise<OcrOutput>(() => undefined) },
  })
  assert.equal(service.selectedDescriptor()?.id, 'local-test')
  const task = service.recognize(request())
  await began
  unregister()
  await assert.rejects(task, hasCode('engine-unavailable'))
  service.dispose()
})

test('staged image handles are session-scoped and do not expose raw paths or bytes', async () => {
  const service = new HostOcrService(() => 'local-test')
  service.register({
    descriptor: { id: 'local-test', name: 'Local test', version: '1', execution: 'local', geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize(input) { assert.equal(input.sessionId, 'session-1'); return output() },
  })
  const handle = await service.stageImage(request())
  assert.match(handle, /^ocrimg_[0-9a-f-]{36}$/)
  assert.equal(handle.includes('PNG'), false)
  await assert.rejects(service.recognizeStaged(handle, 'another-session', new AbortController().signal), hasCode('invalid-request'))
  const result = await service.recognizeStaged(handle, 'session-1', new AbortController().signal)
  assert.equal(result.text, 'hello')
  assert.deepEqual(result.source, { backendId: 'local-test', backendVersion: '1' })
  service.dispose()
  await assert.rejects(service.recognizeStaged(handle, 'session-1', new AbortController().signal), hasCode('engine-unavailable'))
})

test('the shared OCR service bounds direct input and backend output', async () => {
  const service = new HostOcrService(() => 'local-test')
  service.register({
    descriptor: { id: 'local-test', name: 'Local test', version: '1', execution: 'local', geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize() { return { ...output(), text: 'x'.repeat(32_769) } },
  })
  await assert.rejects(service.recognize({ ...request(), image: new Uint8Array(16 * 1024 * 1024 + 1) }), hasCode('limit-exceeded'))
  await assert.rejects(service.recognize({ ...request(), width: 5_000, height: 5_000 }), hasCode('limit-exceeded'))
  await assert.rejects(service.recognize(request()), hasCode('limit-exceeded'))
  service.dispose()
})

test('session route prefers pending selection, then request header, then default', async () => {
  const signal = new AbortController().signal
  const session = { requestHeader: () => ({ config: { provider: 'header', model: 'm' } }) }
  let pending: { provider: string; model: string } | null = { provider: 'pending', model: 'm' }
  const ctx = {
    sessionController: { async resolveAgent() { return { agent: { session } } } },
    get(key: string) {
      if (key === 'sessionProjections') return { stateOf: () => ({ pending }) }
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default', model: 'm' }) }
      return undefined
    },
  }
  assert.equal((await resolveOcrSessionModel(ctx as never, 's', signal)).provider, 'pending')
  pending = null
  assert.equal((await resolveOcrSessionModel(ctx as never, 's', signal)).provider, 'header')
})
