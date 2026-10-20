import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuxiliaryVisionBackend } from '../../../src/adapters/host/dsh/image-auxiliary.ts'
import { HostImageUnderstandingService, ImageUnderstandingError,
  type ImageUnderstandingRequest } from '../../../src/modules/image-understanding/index.js'
import type { SessionOcrAttachmentStore, SessionOcrLlm } from '../../../src/adapters/host/dsh/ocr-session-llm.ts'

const image = new Uint8Array(24)
image.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
image.set([73, 72, 68, 82], 12)
new DataView(image.buffer).setUint32(16, 12)
new DataView(image.buffer).setUint32(20, 9)
const attachment = { attachmentId: 'image-ref', mediaType: 'image/png', bytes: 24, width: 12, height: 9 }
const request = (signal = new AbortController().signal): ImageUnderstandingRequest => ({
  sessionId: 'current-text-only-session', question: 'What is plotted here?', signal,
  image: { mediaType: 'image/png', data: image, width: 12, height: 9 },
})
const hasCode = (code: string) => (error: unknown) => error instanceof ImageUnderstandingError && error.code === code

test('auxiliary vision requires an explicitly configured model; no implicit session fallback', async () => {
  let calls = 0
  const backend = createAuxiliaryVisionBackend({
    selectedModel: () => undefined,
    getLlm: () => { calls++; return undefined },
    getAttachments: () => { calls++; return undefined },
  })
  const service = new HostImageUnderstandingService(() => backend.id)
  service.register(backend)
  try {
    assert.deepEqual(await service.availability(request().sessionId, request().signal), {
      status: 'unavailable', reason: 'Configure an auxiliary vision provider and model first.',
    })
    await assert.rejects(service.prepare(request()), hasCode('pdf/image-unavailable'))
    assert.equal(calls, 0)
  } finally { service.dispose() }
})

test('auxiliary vision refuses a configured text-only model before storing image', async () => {
  let saved = 0
  const backend = createAuxiliaryVisionBackend({
    selectedModel: () => ({ provider: 'other-provider', model: 'text-only' }),
    getLlm: () => ({ async resolveModelInfo() { return { inputModalities: ['text'] } },
      async *stream() { throw new Error('must not stream'); yield { type: 'finish' } } }),
    getAttachments: () => ({ async saveImage() { saved++; return attachment } }),
  })
  const service = new HostImageUnderstandingService(() => backend.id)
  service.register(backend)
  try {
    assert.equal((await service.availability(request().sessionId, request().signal)).status, 'unavailable')
    await assert.rejects(service.prepare(request()), hasCode('pdf/image-unavailable'))
    assert.equal(saved, 0)
  } finally { service.dispose() }
})

test('auxiliary vision returns bounded, provenance-labelled text for the current text-only session', async () => {
  let stored = 0
  const attachments: SessionOcrAttachmentStore = {
    async saveImage(input) {
      stored++
      assert.equal(input.mediaType, 'image/png')
      assert.deepEqual(input.data, image)
      return attachment
    },
  }
  const llm: SessionOcrLlm = {
    async resolveModelInfo(provider, model) {
      assert.equal(provider, 'vision-provider')
      assert.equal(model, 'cheap-vision')
      return { inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      assert.equal(options.sessionId, 'current-text-only-session')
      assert.equal(options.provider, 'vision-provider')
      assert.equal(options.model, 'cheap-vision')
      assert.equal(options.messages.length, 1)
      assert.match((options.messages[0]?.content[0] as { text: string }).text, /What is plotted here\?/)
      assert.deepEqual(options.messages[0]?.content[1], { type: 'image', attachment })
      assert.match(options.system, /Do not answer the question/)
      yield { type: 'text-delta', index: 0, text: 'A line rises' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A line rises left to right.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const backend = createAuxiliaryVisionBackend({ selectedModel: () => ({ provider: 'vision-provider', model: 'cheap-vision' }),
    getLlm: () => llm, getAttachments: () => attachments })
  const service = new HostImageUnderstandingService(() => backend.id)
  service.register(backend)
  try {
    assert.deepEqual(await service.availability(request().sessionId, request().signal), {
      status: 'available', kind: 'derived-text', backendId: 'auxiliary-vision',
      limitation: 'The auxiliary model describes the image; the current session model receives text, not image pixels.',
    })
    assert.deepEqual(await service.prepare(request()), {
      kind: 'derived-text', text: 'A line rises left to right.',
      provenance: { backendId: 'auxiliary-vision', mode: 'image-description', model: 'vision-provider/cheap-vision' },
      limitations: 'This is a second-model description, not the original image. Details may be omitted or mistaken.',
    })
    assert.equal(stored, 1)
  } finally { service.dispose() }
})

test('auxiliary vision rejects truncated output rather than passing partial evidence downstream', async () => {
  const backend = createAuxiliaryVisionBackend({
    selectedModel: () => ({ provider: 'vision', model: 'limited' }),
    getLlm: () => ({ async resolveModelInfo() { return { inputModalities: ['image'] } },
      async *stream() { yield { type: 'text-delta', index: 0, text: 'Incomplete' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } } } }),
    getAttachments: () => ({ async saveImage() { return attachment } }),
  })
  const service = new HostImageUnderstandingService(() => backend.id)
  service.register(backend)
  try { await assert.rejects(service.prepare(request()), hasCode('pdf/image-incomplete')) }
  finally { service.dispose() }
})

test('auxiliary vision validates output token bound', () => {
  assert.throws(() => createAuxiliaryVisionBackend({ selectedModel: () => undefined,
    getLlm: () => undefined, getAttachments: () => undefined, maxOutputTokens: 0 }), RangeError)
})
