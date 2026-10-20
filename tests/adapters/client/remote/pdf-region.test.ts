import assert from 'node:assert/strict'
import test from 'node:test'
import { createRegionEvidenceApi } from '../../../../src/adapters/client/remote/pdf-region.ts'
import type { PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'
import type { PdfRegionEvidenceApi } from '../../../../src/modules/viewer/ports/reader.ts'

// A complete 1×1 PNG, including IHDR, IDAT, and IEND chunks.
const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
const digest = `sha256:${'a'.repeat(64)}`
const request: Parameters<PdfRegionEvidenceApi['prepare']>[0] = {
  sessionId: 'session-1', documentId: 'document-1', page: 2,
  rectPdf: [10, 20, 50, 60], expectedRevision: 7,
  expectedContentVersion: 'content-1', maxEdge: 512,
}
const value = {
  refId: `pdfref_${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`,
  documentId: 'document-1', page: 2, rectPdf: [10, 20, 50, 60] as [number, number, number, number],
  sourcePath: '/paper.pdf', sourceDigest: digest, sourceVersion: 'source-1',
  contentVersion: 'content-1', revision: 7, mediaType: 'image/png', width: 1, height: 1, bytes: png,
}

test('region adapter requests authenticated Host evidence and preserves exact binary bytes', async () => {
  const calls: unknown[][] = []
  const connection: PdfConnection = { rpc: { async call(...args) { calls.push(args); return { ok: true, value } } } }
  const lifetime = new AbortController()
  const operation = new AbortController()
  const prepared = await createRegionEvidenceApi(connection, lifetime.signal).prepare(request, operation.signal)
  assert.deepEqual(prepared, value)
  assert.equal(prepared.bytes, png)
  assert.deepEqual(calls[0]?.slice(0, 3), ['/api', 'pdf.region', request])
  assert.ok(calls[0]?.[3] instanceof AbortSignal)
})

test('Host denial preserves its error code and malformed success cannot become image evidence', async () => {
  const lifetime = new AbortController().signal
  const denied = createRegionEvidenceApi({ rpc: { async call() {
    return { ok: false, error: { code: 'pdf/stale-reader', message: 'PDF changed' } }
  } } }, lifetime)
  await assert.rejects(denied.prepare(request), { code: 'pdf/stale-reader', message: 'PDF changed' })

  for (const invalid of [
    { ...value, sourceDigest: 'invalid' },
    { ...value, bytes: [...png] },
    { ...value, mediaType: 'image/jpeg' },
    { ...value, width: 2 },
    { ...value, bytes: png.subarray(0, png.length - 3) },
    { ...value, bytes: new Uint8Array(MAX_BYTES + 1) },
  ]) {
    const api = createRegionEvidenceApi({ rpc: { async call() { return { ok: true, value: invalid } } } }, lifetime)
    await assert.rejects(api.prepare(request))
  }
})

const MAX_BYTES = 6 * 1024 * 1024

test('region adapter rejects cancellation before RPC and after a late Host reply', async () => {
  const lifetime = new AbortController()
  lifetime.abort()
  let calls = 0
  const api = createRegionEvidenceApi({ rpc: { async call() { calls++; return { ok: true, value } } } }, lifetime.signal)
  await assert.rejects(api.prepare(request), { name: 'AbortError' })
  assert.equal(calls, 0)

  let resolve!: (response: unknown) => void
  const pendingResponse = new Promise<unknown>(next => { resolve = next })
  const operation = new AbortController()
  let transportSignal: AbortSignal | undefined
  const waiting = createRegionEvidenceApi({ rpc: { async call(_path, _method, _payload, signal) {
    transportSignal = signal
    return pendingResponse
  } } }, new AbortController().signal).prepare(request, operation.signal)
  operation.abort()
  assert.equal(transportSignal?.aborted, true)
  resolve({ ok: true, value })
  await assert.rejects(waiting, { name: 'AbortError' })
})
