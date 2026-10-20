import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfOcrDispatch } from '../../../src/adapters/host/dsh/pdf-ocr-transport.ts'
import { HostOcrService } from '../../../src/modules/ocr/index.js'
import type { OcrOutput } from '../../../src/ocr/types.ts'

const agent = { session: { id: 'session-1', header: { cwd: '/workspace' } } }
const signal = () => new AbortController().signal
const output: OcrOutput = {
  text: 'Recognized text', blocks: [{ id: 'text', text: 'Recognized text', box: null, confidence: null }],
  lines: [], words: [], confidence: null, status: 'complete',
  coverage: [{ x0: 0, y0: 0, x1: 400, y1: 100 }], warnings: ['geometry-unavailable'],
}

test('the Host decides OCR availability for this session and checks it again before rendering', async () => {
  let available = false
  let renders = 0
  const service = new HostOcrService(() => 'vision')
  service.register({
    descriptor: { id: 'vision', name: 'Current session model', version: '1', execution: 'remote',
      geometry: [], confidence: false },
    async availability(sessionId) {
      assert.equal(sessionId, 'session-1')
      return available ? { status: 'available' } : { status: 'unavailable', reason: 'No image input.' }
    },
    async recognize() { return output },
  })
  const dispatch = createPdfOcrDispatch({ get: (name: string) => name === 'ocr' ? service : undefined } as never,
    { readSnapshot: () => ({ revision: 2, contentVersion: 'v1' }) } as never,
    { async renderOcrImage() { renders++; throw new Error('should not render while unavailable') } } as never,
    () => 30_000)
  try {
    const request = { action: 'availability', sessionId: 'session-1' }
    assert.equal((await dispatch('session-1', request, agent, signal()) as { status: string }).status, 'unavailable')
    await assert.rejects(dispatch('session-1', { action: 'recognize', sessionId: 'session-1',
      documentId: 'doc', page: 1 }, agent, signal()), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'pdf/ocr-unavailable')
    assert.equal(renders, 0)
    available = true
    assert.equal((await dispatch('session-1', request, agent, signal()) as { status: string }).status, 'available')
    available = false
    await assert.rejects(dispatch('session-1', { action: 'recognize', sessionId: 'session-1',
      documentId: 'doc', page: 1 }, agent, signal()))
    assert.equal(renders, 0)
  } finally { service.dispose() }
})

test('Host OCR renders only the requested PDF region and preserves text-only geometry', async () => {
  const service = new HostOcrService(() => 'vision')
  const recognized: { sessionId: string; width: number; height: number; bytes: number }[] = []
  service.register({
    descriptor: { id: 'vision', name: 'Current session model', version: '1', execution: 'remote',
      geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize(request) {
      recognized.push({ sessionId: request.sessionId, width: request.width, height: request.height,
        bytes: request.image instanceof Uint8Array ? request.image.byteLength : request.image.size })
      return output
    },
  })
  const renderedArgs: unknown[][] = []
  const dispatch = createPdfOcrDispatch({ get: (name: string) => name === 'ocr' ? service : undefined } as never,
    { readSnapshot: () => ({ revision: 2, contentVersion: 'v1' }) } as never,
    { async renderOcrImage(...args: unknown[]) {
      renderedArgs.push(args)
      return { png: new Uint8Array([137, 80, 78, 71]), width: 400, height: 100,
        pdfRegion: [20, 40, 180, 60], snapshot: { id: 'doc', revision: 2, contentVersion: 'v1' } }
    } } as never, () => 30_000)
  try {
    const region = [20, 40, 180, 60]
    const value = await dispatch('session-1', { action: 'recognize', sessionId: 'session-1',
      documentId: 'doc', page: 3, region }, agent, signal()) as {
        documentId: string; text: string; geometry: { status: string; pdfCoordinatesAvailable: boolean }
      }
    assert.equal(value.documentId, 'doc')
    assert.equal(value.text, 'Recognized text')
    assert.deepEqual(value.geometry, { status: 'none', coordinateSpace: 'rendered-image-pixels',
      positionedParts: 0, totalParts: 1, pdfCoordinatesAvailable: false })
    assert.deepEqual(renderedArgs[0]?.slice(0, 5), ['session-1', 'doc', 3, region, 1024])
    assert.deepEqual(recognized, [{ sessionId: 'session-1', width: 400, height: 100, bytes: 4 }])
  } finally { service.dispose() }
})

test('Host OCR rejects a result after the PDF changes during recognition', async () => {
  let revision = 4
  const service = new HostOcrService(() => 'vision')
  service.register({
    descriptor: { id: 'vision', name: 'Current session model', version: '1', execution: 'remote',
      geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize() { revision++; return output },
  })
  const dispatch = createPdfOcrDispatch({ get: (name: string) => name === 'ocr' ? service : undefined } as never,
    { readSnapshot: () => ({ revision, contentVersion: 'v1' }) } as never,
    { async renderOcrImage() { return { png: new Uint8Array([137, 80, 78, 71]), width: 400, height: 100,
      pdfRegion: [0, 0, 400, 100], snapshot: { id: 'doc', revision: 4, contentVersion: 'v1' } } } } as never,
    () => 30_000)
  try {
    await assert.rejects(dispatch('session-1', { action: 'recognize', sessionId: 'session-1',
      documentId: 'doc', page: 1 }, agent, signal()), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'pdf/stale-reader')
  } finally { service.dispose() }
})
