import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTextSelectionEvidenceApi } from '../../../../src/adapters/client/remote/pdf-selection.ts'
import type { PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'

const digest = `sha256:${'a'.repeat(64)}`
const refId = 'pdfref_00000000-0000-4000-8000-000000000001'
const request = { sessionId: 'session-1', documentId: 'doc-1', expectedRevision: 3,
  expectedContentVersion: 'content-1', quote: 'Verified text',
  fragments: [{ page: 2, rect: [10, 20, 50, 40] as [number, number, number, number],
    quadPoints: [10, 20, 50, 20, 10, 40, 50, 40] }] }
const value = { text: 'Verified text', documentId: 'doc-1', sourcePath: '/document.pdf',
  sourceDigest: digest, sourceVersion: 'source-1', contentVersion: 'content-1', revision: 3,
  excerpts: [{ page: 2, text: 'Verified text', refId, startUtf16: 5, endUtf16: 18 }] }

test('text selection adapter sends one bounded request and accepts only Host canonical text', async () => {
  const calls: unknown[] = []
  const connection = { rpc: { async call(...args: unknown[]) {
    calls.push(args)
    return { ok: true, value }
  } } } as PdfConnection
  const api = createTextSelectionEvidenceApi(connection, new AbortController().signal)
  assert.deepEqual(await api.prepare(request), value)
  assert.deepEqual((calls[0] as unknown[]).slice(0, 3), ['/api', 'pdf.selection', request])
})

test('text selection adapter rejects a mismatched Host identity and malformed evidence', async () => {
  for (const result of [{ ...value, documentId: 'other' }, { ...value, excerpts: [] },
    { ...value, excerpts: [{ ...value.excerpts[0], page: 99 }] }]) {
    const connection = { rpc: { async call() { return { ok: true, value: result } } } } as PdfConnection
    await assert.rejects(createTextSelectionEvidenceApi(connection, new AbortController().signal).prepare(request))
  }
})

test('text selection adapter refuses lifetime cancellation before contacting Host', async () => {
  const stopped = new AbortController(); stopped.abort()
  const connection = { rpc: { async call() { assert.fail('aborted request must not reach Host') } } } as PdfConnection
  await assert.rejects(createTextSelectionEvidenceApi(connection, stopped.signal).prepare(request), /abort/i)
})
