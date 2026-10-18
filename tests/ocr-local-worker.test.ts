import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalWorkerMessageHandler } from '../src/ocr/local-worker.ts'
import type { LocalOcrWorkerRequest, LocalOcrWorkerResponse } from '../src/ocr/bridge.ts'
import { OcrError, type OcrOutput } from '../src/ocr/types.ts'

const assets = { workerPath: '/ocr/worker.js', corePath: '/ocr/core', langPath: '/ocr/lang', gzip: true }
const image = new Uint8Array([1, 2, 3])
const request: LocalOcrWorkerRequest = {
  request: { image, width: 12, height: 8, languages: ['eng'], timeoutMs: 500 },
  assets,
}
const event = new MessageEvent<LocalOcrWorkerRequest>('message', { data: request })
const output: OcrOutput = {
  text: 'Hello', blocks: [], lines: [], words: [], confidence: null,
  status: 'complete', coverage: [{ x0: 0, y0: 0, x1: 12, y1: 8 }], warnings: [],
}

test('LocalOCR Worker entry installs its handler and posts an actual request failure', async () => {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<LocalOcrWorkerRequest>) => Promise<void>
    postMessage?: (message: LocalOcrWorkerResponse) => void
  }
  assert.equal(typeof scope.onmessage, 'function')
  const previousPostMessage = scope.postMessage
  const messages: LocalOcrWorkerResponse[] = []
  scope.postMessage = message => messages.push(message)
  try {
    const controller = new AbortController()
    controller.abort()
    // Directly exercise the installed handler without launching Tesseract's child worker.
    const abortedRequest = { ...request.request, signal: controller.signal }
    await scope.onmessage(new MessageEvent<LocalOcrWorkerRequest>('message', {
      data: { ...request, request: abortedRequest },
    }))
    assert.deepEqual(messages, [{ type: 'error', error: { code: 'cancelled', message: 'LocalOCR was cancelled.' } }])
  } finally {
    if (previousPostMessage) scope.postMessage = previousPostMessage
    else delete scope.postMessage
  }
})

test('LocalOCR Worker relays progress and result from the same recognition path', async () => {
  const messages: LocalOcrWorkerResponse[] = []
  const handler = createLocalWorkerMessageHandler(async (received, receivedAssets) => {
    assert.deepEqual({ ...received, onProgress: undefined }, { ...request.request, onProgress: undefined })
    assert.equal(received.image, image)
    assert.equal(receivedAssets, assets)
    received.onProgress?.({ stage: 'recognizing text', progress: 0.4 })
    return output
  }, message => messages.push(message))

  await handler(event)
  assert.deepEqual(messages, [
    { type: 'progress', progress: { stage: 'recognizing text', progress: 0.4 } },
    { type: 'result', result: output },
  ])
})

test('LocalOCR Worker preserves public OCR failure codes', async () => {
  const messages: LocalOcrWorkerResponse[] = []
  const handler = createLocalWorkerMessageHandler(async () => {
    throw new OcrError('timeout', 'OCR timed out')
  }, message => messages.push(message))

  await handler(event)
  assert.deepEqual(messages, [{ type: 'error', error: { code: 'timeout', message: 'OCR timed out' } }])
})

test('LocalOCR Worker redacts unexpected internal errors', async () => {
  const messages: LocalOcrWorkerResponse[] = []
  const handler = createLocalWorkerMessageHandler(async () => {
    throw new Error('/private/user-document.pdf is missing')
  }, message => messages.push(message))

  await handler(event)
  assert.deepEqual(messages, [{ type: 'error', error: {
    code: 'recognition-failed', message: 'LocalOCR could not recognize the image.',
  } }])
})
