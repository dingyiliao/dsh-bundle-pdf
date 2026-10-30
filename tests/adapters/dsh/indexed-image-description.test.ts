import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshVisionBackend, resolveSessionVisionModel, supportsSessionImages } from '../../../src/adapters/host/dsh/image-backends.js'
import { createSessionLlmOcrBackend, type SessionOcrLlm } from '../../../src/adapters/host/dsh/ocr-session-llm.js'
import { HostImageUnderstandingService, type ImageUnderstandingRequest } from '../../../src/modules/image-understanding/index.js'
import { HostOcrService } from '../../../src/modules/ocr/index.js'

const signal = new AbortController().signal, data = new Uint8Array(24)
data.set([137, 80, 78, 71, 13, 10, 26, 10]); data.set([73, 72, 68, 82], 12)
new DataView(data.buffer).setUint32(16, 1); new DataView(data.buffer).setUint32(20, 1)
const request: ImageUnderstandingRequest = { sessionId: 'session', prompt: 'An interactive question', signal,
  image: { mediaType: 'image/png', data, width: 1, height: 1 } }
const attachment = { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 24, width: 1, height: 1 }
function services() {
  let model = 'vision-one', contextWindow = 10_000, loaded = true, vision = true
  let uploads = 0, streams = 0
  const prompts: string[] = []
  const llm: SessionOcrLlm = {
    async resolveModelInfo(provider, id) { return { provider, id, inputModalities: vision ? ['image'] : ['text'], context: { contextWindow } } },
    async *stream(options) {
      streams++; assert.equal(options.sessionId, 'session')
      prompts.push((options.messages[0]!.content[0] as { text: string }).text)
      yield { type: 'text-delta', index: 0, text: 'A labelled figure.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const attachments = { async saveImage() { uploads++; return attachment } }
  const route = async () => ({ provider: 'fixture', model })
  const ctx = { get(key: string) {
    if (!loaded && ['llm', 'attachments'].includes(key)) return undefined
    if (key === 'llm') return llm
    if (key === 'attachments') return attachments
    if (key === 'sessionController') return { async resolveAgent() {
      return { agent: { session: { requestHeader: () => ({ config: { provider: 'fixture', model } }) } } }
    } }
    return undefined
  } } as never
  const backend = createDshVisionBackend({ selectedModel: (sessionId, active) => resolveSessionVisionModel(ctx, sessionId, active),
    getLlm: () => loaded ? llm : undefined, getAttachments: () => loaded ? attachments : undefined })
  return { llm, attachments, ctx, route, backend, prompts,
    setModel(value: string) { model = value }, setContext(value: number) { contextWindow = value },
    setVision(value: boolean) { vision = value }, unload() { loaded = false }, counts() { return { uploads, streams } } }
}

test('interactive understanding and index descriptions share one executing engine and preserve caller prompts', async () => {
  const f = services(), service = new HostImageUnderstandingService(() => 'dsh-vision')
  service.register(f.backend)
  try {
    for (const prompt of ['Explain this diagram.', 'Describe this page for a searchable index.']) {
      const result = await service.understand({ ...request, prompt })
      assert.equal(result.text, 'A labelled figure.')
      assert.deepEqual(result.source, { backendId: 'dsh-vision', backendVersion: '2', model: 'fixture/vision-one' })
    }
    assert.deepEqual(f.prompts, ['Explain this diagram.', 'Describe this page for a searchable index.'])
    assert.deepEqual(f.counts(), { uploads: 2, streams: 2 })
    assert.deepEqual(service.list().map(item => item.id), ['dsh-vision'])
    f.unload()
    await assert.rejects(service.understand(request), { code: 'pdf/image-unavailable' })
  } finally { service.dispose() }
})

test('session image delivery checks metadata without invoking the registered engine', async () => {
  const f = services()
  assert.equal(await supportsSessionImages(f.ctx, 'session', signal), true)
  f.setVision(false)
  assert.equal(await supportsSessionImages(f.ctx, 'session', signal), false)
  assert.deepEqual(f.counts(), { uploads: 0, streams: 0 })
  f.unload()
  await assert.rejects(supportsSessionImages(f.ctx, 'session', signal), { code: 'pdf/image-unavailable' })
})

test('model metadata lookup failure cannot masquerade as a text-only model and trigger a different engine', async () => {
  const ctx = { get(key: string) {
    if (key === 'sessionController') return { async resolveAgent() {
      return { agent: { session: { requestHeader: () => ({ config: { provider: 'fixture', model: 'vision' } }) } } }
    } }
    if (key === 'llm') return { async resolveModelInfo() { throw new Error('metadata offline') } }
    return undefined
  } } as never
  await assert.rejects(supportsSessionImages(ctx, 'session', signal), error => error instanceof Error
    && 'code' in error && error.code === 'pdf/image-unavailable' && !error.message.includes('metadata offline'))
})

test('vision uses the current route or an explicitly configured model without changing the conversation', async () => {
  const f = services(), service = new HostImageUnderstandingService(() => 'dsh-vision')
  service.register(f.backend)
  try {
    const configured = await service.understand({ ...request,
      binding: { engineId: 'dsh-vision', config: { provider: 'other', model: 'cheap-vision' } } })
    assert.equal(configured.source.model, 'other/cheap-vision')
    assert.equal((await service.understand(request)).source.model, 'fixture/vision-one')
    assert.equal((await service.understand({ ...request,
      binding: { engineId: 'dsh-vision', config: { provider: '', model: '' } } })).source.model, 'fixture/vision-one')
  } finally { service.dispose() }
})

test('OCR and image model identity tracks routes and metadata without claiming unverified persistent reuse', async () => {
  const f = services(), ocr = new HostOcrService(() => 'session-llm')
  const images = new HostImageUnderstandingService(() => 'dsh-vision')
  ocr.register(createSessionLlmOcrBackend({ getLlm: () => f.llm, getAttachments: () => f.attachments, resolveModel: f.route }))
  images.register(f.backend)
  try {
    for (const service of [ocr, images]) {
      const first = await service.cacheIdentity('session', signal)
      assert.equal(first.reusable, false)
      assert.equal(first.fingerprint, (await service.cacheIdentity('session', signal)).fingerprint)
      f.setModel('vision-two')
      const second = await service.cacheIdentity('session', signal)
      assert.notEqual(first.fingerprint, second.fingerprint)
      f.setContext(20_000)
      assert.notEqual(second.fingerprint, (await service.cacheIdentity('session', signal)).fingerprint)
      f.setModel('vision-one'); f.setContext(10_000)
    }
    assert.deepEqual(f.counts(), { uploads: 0, streams: 0 })
  } finally { ocr.dispose(); images.dispose() }
})
