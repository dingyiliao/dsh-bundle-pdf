import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createLocalTesseractOcrBackend } from '../../../../src/adapters/host/ocr/local-backend.js'
import { createLocalTextRecovery } from '../../../../src/adapters/host/ocr/local-text-recovery.js'
import { HostOcrService } from '../../../../src/modules/ocr/index.js'
import type { OcrOutput } from '../../../../src/ocr/types.js'

const signal = new AbortController().signal
const request = { sessionId: 'session', signal, image: new Uint8Array([1]), mediaType: 'image/png' as const,
  width: 1, height: 1, languages: ['auto'] }

test('bundled local backend accepts text-only OCR results through the normal registry', async () => {
  const output: OcrOutput = { text: 'Visible words', blocks: [], lines: [], words: [], confidence: null,
    status: 'complete', coverage: [], warnings: ['geometry-unavailable'] }
  let calls = 0, disposed = 0
  const local = { async recognize(bytes: Uint8Array, width: number, height: number, active: AbortSignal) {
    calls++; assert.deepEqual(bytes, request.image); assert.deepEqual([width, height], [1, 1]); active.throwIfAborted()
    return output
  }, async dispose() { disposed++ } }
  const service = new HostOcrService(() => 'local-tesseract')
  const unregister = service.register(createLocalTesseractOcrBackend(local))
  try {
    assert.equal((await service.availability('session', signal)).status, 'available')
    assert.equal((await service.cacheIdentity('session', signal)).reusable, true)
    assert.equal((await service.recognize(request)).text, 'Visible words')
    assert.equal(calls, 1)
    await assert.rejects(service.recognize({ ...request, languages: ['fr'] }), { code: 'not-configured' })
    await assert.rejects(service.recognize({ ...request, mediaType: 'image/jpeg' }), { code: 'invalid-request' })
    unregister(); await local.dispose()
    assert.equal(disposed, 1)
    await assert.rejects(service.recognize(request), { code: 'engine-unavailable' })
  } finally { service.dispose() }
})

test('local backend unregister cancels recognition and its owner drains the worker on disposal', async () => {
  const local = createLocalTextRecovery(resolve('tests/fixtures/recovery-exit'))
  const service = new HostOcrService(() => 'local-tesseract')
  const unregister = service.register(createLocalTesseractOcrBackend(local))
  const pending = service.recognize(request)
  const rejected = assert.rejects(pending, { code: 'engine-unavailable' })
  unregister()
  await local.dispose()
  await rejected
  await assert.rejects(local.recognize(new Uint8Array(), 1, 1, signal), /closed/)
  service.dispose()
})
