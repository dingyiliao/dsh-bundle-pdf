import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPdfEvidenceRevalidator } from '../../../src/adapters/client/remote/pdf-evidence.ts'
import type { PdfConnection } from '../../../src/adapters/client/remote/pdf-api.ts'
import type { EvidenceRevalidationRequest } from '../../../src/client/toolview/pdf-evidence-navigation.ts'

const digest = `sha256:${'a'.repeat(64)}`
const request: EvidenceRevalidationRequest = { action: 'revalidate', sessionId: 'session-1',
  documentId: 'document-1', sourcePathDigest: digest, page: 2, pageTextDigest: digest,
  startUtf16: 4, endUtf16: 9, excerpt: 'hello', excerptSha256: digest }
const value = { status: 'valid', documentId: 'document-1', page: 2, sourceDigest: digest,
  sourceVersion: 'source-1', contentVersion: 'content-1', revision: 3 }

test('evidence revalidator sends the exact request over the authenticated Host endpoint', async () => {
  const calls: unknown[][] = []
  const connection: PdfConnection = { rpc: { async call(...args) { calls.push(args); return { ok: true, value } } } }
  const lifetime = new AbortController()
  const signal = new AbortController().signal
  const revalidate = createPdfEvidenceRevalidator(connection, lifetime.signal)
  assert.deepEqual(await revalidate(request, signal), value)
  assert.deepEqual(calls[0]?.slice(0, 3), ['/api', 'pdf.evidence', request])
  assert.ok(calls[0]?.[3] instanceof AbortSignal)
})

test('Host denial and malformed success cannot authorize a page jump', async () => {
  const signal = new AbortController().signal
  const denied = createPdfEvidenceRevalidator({ rpc: { async call() {
    return { ok: false, error: { code: 'pdf/stale-reader', message: 'page changed' } }
  } } }, signal)
  await assert.rejects(denied(request, signal), error => error instanceof Error
    && error.message === 'page changed' && 'code' in error && error.code === 'pdf/stale-reader')
  const malformed = createPdfEvidenceRevalidator({ rpc: { async call() {
    return { ok: true, value: { ...value, sourceDigest: 'not-a-digest' } }
  } } }, signal)
  await assert.rejects(malformed(request, signal))
})

test('lifetime cancellation rejects before contacting Host', async () => {
  let calls = 0
  const lifetime = new AbortController()
  lifetime.abort()
  const revalidate = createPdfEvidenceRevalidator({ rpc: { async call() { calls++; return { ok: true, value } } } }, lifetime.signal)
  await assert.rejects(revalidate(request, new AbortController().signal), { name: 'AbortError' })
  assert.equal(calls, 0)
})
