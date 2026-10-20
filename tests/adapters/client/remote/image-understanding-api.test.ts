import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createImageUnderstandingApi } from '../../../../src/adapters/client/remote/image-understanding-api.ts'
import type { PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'

// A complete 1×1 PNG, including IHDR, IDAT, and IEND chunks.
const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
const digest = `sha256:${'a'.repeat(64)}`
const imageDigest = `sha256:${createHash('sha256').update(png).digest('hex')}`
const refId = 'pdfref_00000000-0000-4000-8000-000000000001'
const request = { sessionId: 'session-1', documentId: 'doc-1', refId, question: 'Explain this region.' }
const evidence = { refId, documentId: 'doc-1', page: 2,
  locator: { kind: 'pdf-region' as const, rectPdf: [10, 20, 30, 40] as [number, number, number, number] },
  sourceDigest: digest, sourceVersion: 'source-1', contentVersion: 'content-1', revision: 7,
  renderedImageSha256: imageDigest }
const direct = { kind: 'direct-image', backendId: 'session-vision', requestedRefId: refId,
  provenance: { backendId: 'session-vision', mode: 'session-vision' }, evidence, bytes: png }
const derived = { kind: 'derived-text', backendId: 'ocr-text', requestedRefId: refId, evidence,
  text: 'Recognized words', provenance: { backendId: 'ocr-text', mode: 'ocr-text' },
  limitations: 'Text only.' }

test('prepare-reference sends only the Host reference and returns its exact verified PNG bytes', async () => {
  const calls: unknown[][] = []
  const rebound = { ...direct, evidence: { ...evidence, refId: 'pdfref_00000000-0000-4000-8000-000000000003' } }
  const connection: PdfConnection = { rpc: { async call(...args) {
    calls.push(args)
    return { ok: true, value: direct }
  } } }
  const prepared = await createImageUnderstandingApi(connection, new AbortController().signal)
    .prepareReference(request)
  assert.deepEqual(calls[0]?.slice(0, 3), ['/api', 'pdf.image', {
    action: 'prepare-reference', sessionId: 'session-1', documentId: 'doc-1', refId,
    question: 'Explain this region.',
  }])
  assert.equal(calls[0]?.[3] instanceof AbortSignal, true)
  assert.equal(prepared.kind, 'direct-image')
  if (prepared.kind !== 'direct-image') assert.fail('Expected a direct image')
  assert.equal(prepared.image.data, png, 'the Host bytes are passed through without a Client Blob')
  assert.deepEqual([prepared.image.width, prepared.image.height], [1, 1])
  assert.equal(prepared.evidence.refId, refId)

  const reopened = await createImageUnderstandingApi({ rpc: { async call() {
    return { ok: true, value: rebound }
  } } }, new AbortController().signal).prepareReference(request)
  assert.equal(reopened.evidence.refId, rebound.evidence.refId,
    'a Host-reissued ref for byte-identical source remains valid')
})

test('prepare-reference preserves an OCR or auxiliary derived-text route without pixels', async () => {
  for (const backendId of ['ocr-text', 'auxiliary-vision']) {
    const value = { ...derived, backendId,
      provenance: { backendId, mode: backendId === 'ocr-text' ? 'ocr-text' : 'image-description' } }
    const prepared = await createImageUnderstandingApi({ rpc: { async call() {
      return { ok: true, value }
    } } }, new AbortController().signal).prepareReference(request)
    assert.equal(prepared.kind, 'derived-text')
    if (prepared.kind !== 'derived-text') assert.fail('Expected derived text')
    assert.equal(prepared.text, 'Recognized words')
    assert.equal(prepared.limitations, 'Text only.')
    assert.equal('image' in prepared, false)
  }
})

test('a forged, expired, or malformed reference response cannot become image evidence', async () => {
  const lifetime = new AbortController().signal
  const denied = createImageUnderstandingApi({ rpc: { async call() {
    return { ok: false, error: { code: 'pdf/reference-unavailable', message: 'Image evidence is unavailable in this session' } }
  } } }, lifetime)
  await assert.rejects(denied.prepareReference(request),
    { code: 'pdf/reference-unavailable', message: 'Image evidence is unavailable in this session' })

  const invalid = [
    { ...direct, requestedRefId: 'pdfref_00000000-0000-4000-8000-000000000002' },
    { ...direct, evidence: { ...evidence, documentId: 'other-document' } },
    { ...direct, bytes: [...png] },
    { ...direct, bytes: png.subarray(0, png.length - 4) },
    { ...direct, bytes: new Uint8Array(png.length) },
    { ...direct, evidence: { ...evidence, sourceDigest: 'not-a-digest' } },
    { ...direct, evidence: { ...evidence, renderedImageSha256: digest } },
  ]
  for (const value of invalid) {
    const api = createImageUnderstandingApi({ rpc: { async call() {
      return { ok: true, value }
    } } }, lifetime)
    await assert.rejects(api.prepareReference(request))
  }
})

test('prepare-reference refuses lifetime cancellation before contacting Host', async () => {
  const stopped = new AbortController()
  stopped.abort()
  const connection: PdfConnection = { rpc: { async call() {
    assert.fail('an aborted request must not reach Host')
  } } }
  await assert.rejects(createImageUnderstandingApi(connection, stopped.signal).prepareReference(request), /abort/i)
})
