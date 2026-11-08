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

const revalidation = { sessionId: request.sessionId, documentId: request.documentId,
  expectedRevision: 4, expectedContentVersion: request.expectedContentVersion,
  selections: [{ id: 'question-1', refIds: [refId] }] }
const revalidated = { documentId: value.documentId, sourcePath: value.sourcePath,
  sourceDigest: value.sourceDigest, sourceVersion: value.sourceVersion,
  contentVersion: value.contentVersion, revision: 4,
  selections: [{ id: 'question-1', text: value.text, evidenceRefs: [refId], fragments: request.fragments }] }

test('selection revalidation uses one current-revision batch and accepts detailed Host glyph geometry', async () => {
  const calls: unknown[] = []
  const result = { ...revalidated, selections: [{ ...revalidated.selections[0]!, fragments: [{ ...request.fragments[0]!,
    quadPoints: Array.from({ length: 256 }, () => request.fragments[0]!.quadPoints).flat() }] }] }
  const connection = { rpc: { async call(...args: unknown[]) { calls.push(args); return { ok: true, value: result } } } } as PdfConnection
  const api = createTextSelectionEvidenceApi(connection, new AbortController().signal)
  assert.deepEqual(await api.revalidate(revalidation), result)
  assert.deepEqual((calls[0] as unknown[]).slice(0, 3), ['/api', 'pdf.selection', { ...revalidation, action: 'revalidate' }])
})

test('selection revalidation rejects substituted, missing, reordered or malformed Host results', async () => {
  const item = revalidated.selections[0]!
  for (const result of [
    { ...revalidated, documentId: 'foreign' }, { ...revalidated, revision: 3 },
    { ...revalidated, contentVersion: 'changed' }, { ...revalidated, selections: [] },
    { ...revalidated, selections: [{ ...item, id: 'different-question' }] },
    { ...revalidated, selections: [{ ...item, evidenceRefs: ['pdfref_00000000-0000-4000-8000-000000000002'] }] },
    { ...revalidated, selections: [{ ...item, fragments: [] }] },
    { ...revalidated, selections: [{ ...item, fragments: [{ ...request.fragments[0], quadPoints: [1, 2] }] }] },
  ]) {
    const connection = { rpc: { async call() { return { ok: true, value: result } } } } as PdfConnection
    await assert.rejects(createTextSelectionEvidenceApi(connection, new AbortController().signal).revalidate(revalidation))
  }
})

test('selection revalidation is bounded, propagates Host errors and rejects late replies after cancellation', async () => {
  let calls = 0
  const connection = { rpc: { async call() { calls++; return { ok: false,
    error: { code: 'pdf/stale-reader', message: 'Original page text changed' } } } } } as PdfConnection
  const api = createTextSelectionEvidenceApi(connection, new AbortController().signal)
  for (const selections of [[], [revalidation.selections[0]!, revalidation.selections[0]!],
    Array.from({ length: 21 }, (_, index) => ({ id: String(index), refIds: [refId] }))]) {
    await assert.rejects(api.revalidate({ ...revalidation, selections }))
  }
  assert.equal(calls, 0)
  await assert.rejects(api.revalidate(revalidation), { code: 'pdf/stale-reader' })
  const lifetime = new AbortController()
  const late = { rpc: { async call() { lifetime.abort(new Error('Reader replaced')); return { ok: true, value: revalidated } } } } as PdfConnection
  await assert.rejects(createTextSelectionEvidenceApi(late, lifetime.signal).revalidate(revalidation), /Reader replaced/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(api.revalidate(revalidation, cancelled.signal), /abort/i)
  assert.equal(calls, 1)
})
