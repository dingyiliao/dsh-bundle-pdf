import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundDocuments } from '../src/modules/working-copy/index.ts'
import { createImageUnderstandingDispatch } from '../src/adapters/host/dsh/image-transport.ts'
import { HostOcrService, type HostOcrRequest } from '../src/modules/ocr/index.js'
import { createPdfOcrDispatch } from '../src/adapters/host/dsh/pdf-ocr-transport.ts'
import { createReaderContexts } from '../src/modules/navigation/index.ts'

const signal = () => new AbortController().signal
const agent = { session: { id: 'session', header: {} } }

test('background document manager yields ownership to an existing UI reader', async () => {
  let released = 0
  const manager = createBackgroundDocuments({
    listDocuments() { return [] },
    onIdle() { return () => {} },
    touch() {},
    isUiOwned(_sessionId: string, id: string) { return id === 'visible' },
    async releaseBackground(_sessionId: string, _id: string, evict?: () => Promise<unknown>) { await evict?.(); return 'released' as const },
  } as never, { async releaseDocument() { released++ } } as never, { schedule: false })
  assert.equal(await manager.adopt('session', 'visible', 20), 'ui')
  assert.equal(manager.diagnostics().documents, 0)
  assert.equal(released, 0)
  assert.equal(await manager.adopt('session', 'hidden', 20), 'background')
  assert.equal((await manager.close('session', 'hidden')), 'released')
  assert.equal(released, 1)
  await manager.dispose()
})

test('reader presence rejects stale document versions and out-of-range pages before announcing a tab', () => {
  const readers = createReaderContexts({ readSnapshot() {
    return { contentVersion: 'v2', document: { pageCount: 5 } }
  } } as never)
  const base = { action: 'set', sessionId: 'session', tabId: 'tab', leaseId: 'lease', sequence: 1,
    documentId: 'doc', contentVersion: 'v2', page: 1 }
  assert.throws(() => readers.update('session', { ...base, contentVersion: 'v1' }), { code: 'pdf/stale-reader' })
  assert.throws(() => readers.update('session', { ...base, sequence: 2, page: 6 }), { code: 'pdf/invalid-page' })
  assert.deepEqual(readers.current('session'), [])
  assert.deepEqual(readers.update('session', { ...base, sequence: 3 }), { ok: true })
  assert.equal(readers.current('session')[0]?.page, 1)
  readers.dispose()
})

test('Host OCR dispatch reports missing plugin and rejects session spoofing before rendering', async () => {
  const dispatch = createPdfOcrDispatch({ get() { return undefined } } as never,
    { readSnapshot() { throw new Error('must not read') } } as never,
    { async renderOcrImage() { throw new Error('must not render') } } as never, () => 30_000)
  assert.deepEqual(await dispatch('session', { action: 'availability', sessionId: 'session' }, agent, signal()),
    { status: 'unavailable', reason: 'The OCR plugin is not installed.' })
  await assert.rejects(dispatch('session', { action: 'recognize', sessionId: 'session', documentId: 'doc', page: 1 },
    agent, signal()), { code: 'pdf/ocr-unavailable' })
  await assert.rejects(dispatch('session', { action: 'availability', sessionId: 'other' }, agent, signal()),
    { code: 'pdf/session-mismatch' })
})

test('Host OCR dispatch bounds the serialized response, including backend-provided geometry', async () => {
  const huge = 'x'.repeat(1_048_576)
  const dispatch = createPdfOcrDispatch({ get() { return {
    async availability() { return { status: 'available' } },
    selectedDescriptor() { return { id: 'untrusted', languages: ['eng'] } },
    async recognize() { return { text: 'ok', blocks: [{ id: 'b', text: huge, box: null, confidence: null }],
      lines: [], words: [], coverage: [], status: 'complete', warnings: [],
      source: { backendId: 'untrusted', backendVersion: '1' } } },
  } } } as never, { readSnapshot() { return { revision: 1, contentVersion: 'v1' } } } as never,
  { async renderOcrImage() { return { png: new Uint8Array([1]), width: 1, height: 1, pdfRegion: [0, 0, 1, 1],
    snapshot: { id: 'doc', revision: 1, contentVersion: 'v1' } } } } as never, () => 30_000)
  await assert.rejects(dispatch('session', { action: 'recognize', sessionId: 'session', documentId: 'doc', page: 1 },
    agent, signal()), { code: 'pdf/ocr-result-too-large' })
})

test('Host OCR rejects invalid session, media type and backend pixel bounds before recognition', async () => {
  const service = new HostOcrService(() => 'small')
  let calls = 0
  service.register({ descriptor: { id: 'small', name: 'Small', version: '1', execution: 'local', geometry: [],
    confidence: false, maxPixels: 4 },
  async availability() { return { status: 'available' } },
  async recognize() { calls++; throw new Error('must not run') } })
  const valid = { sessionId: 'session', image: new Uint8Array([1]), mediaType: 'image/png' as const,
    width: 2, height: 2, languages: ['eng'] }
  try {
    await assert.rejects(service.stageImage({ ...valid, sessionId: '' }), { code: 'invalid-request' })
    await assert.rejects(service.stageImage({ ...valid, mediaType: 'application/pdf' } as unknown as HostOcrRequest), { code: 'invalid-request' })
    await assert.rejects(service.recognize({ ...valid, sessionId: '' }), { code: 'invalid-request' })
    await assert.rejects(service.recognize({ ...valid, mediaType: 'application/pdf' } as unknown as HostOcrRequest), { code: 'invalid-request' })
    await assert.rejects(service.recognize({ ...valid, width: 3 }), { code: 'limit-exceeded' })
    assert.equal(calls, 0)
  } finally { service.dispose() }
})

test('Host OCR stage handles evict the oldest item when bounded capacity is reached', async () => {
  const service = new HostOcrService(() => 'none')
  const valid = { sessionId: 'session', image: new Uint8Array([1]), mediaType: 'image/png' as const,
    width: 1, height: 1, languages: ['eng'] }
  try {
    const first = await service.stageImage(valid)
    for (let index = 0; index < 24; index++) await service.stageImage(valid)
    await assert.rejects(service.recognizeStaged(first, 'session', signal()), { code: 'invalid-request' })
  } finally { service.dispose() }
})

test('image transport rejects padded Base64 with nonzero discarded bits', async () => {
  const dispatch = createImageUnderstandingDispatch({ async prepare() {
    throw new Error('noncanonical image should not reach the model')
  } } as never)
  await assert.rejects(dispatch('session', { action: 'prepare', sessionId: 'session',
    image: { mediaType: 'image/png', data: 'Zh==', width: 1, height: 1 }, question: 'What is this?' },
  agent, signal()), { code: 'pdf/image-invalid-request' })
})
