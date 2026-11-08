import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfSelectionDispatch, selectionEvidenceRequestSchema } from '../../../../src/adapters/host/dsh/selection-evidence.ts'
import { registerPdfTransport } from '../../../../src/adapters/host/dsh/transport.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256,
  type SelectionRevalidationResult } from '../../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'
import { createTextSelectionEvidenceApi } from '../../../../src/adapters/client/remote/pdf-selection.ts'
import type { PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'

type Route = Parameters<Parameters<typeof registerPdfTransport>[0]['connection']['fetch']['register']>[0]
const content: NativeTextContent = { items: [{ str: 'Hello',
  transform: [1, 0, 0, 1, 10, 40], width: 50, height: 10, dir: 'ltr', fontName: 'test', hasEOL: false,
  glyphs: [[10, 40, 10], [20, 40, 10], [30, 40, 10], [40, 40, 10], [50, 40, 10]] }],
styles: {}, lang: null }

function fixture(resolvedSession = 'session-a') {
  const snapshot = (): HostWorkspaceSnapshot => ({ id: 'doc-a', path: '/paper.pdf', bytes: Buffer.from('%PDF'),
    sourceVersion: 'source-a', contentVersion: 'content-a', revision: 3, dirty: false,
    canUndo: false, canRedo: false, conflict: false,
    document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 200, 200], rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false },
  } as HostWorkspaceSnapshot)
  const workspaces = { readSnapshot(session: string, id: string) {
    if (session !== 'session-a' || id !== 'doc-a') {
      throw Object.assign(new Error('Unauthorized document'), { code: 'pdf/session-mismatch' })
    }
    return snapshot()
  } }
  const pages = { async readPageText(session: string, id: string) {
    return { snapshot: workspaces.readSnapshot(session, id), content }
  } }
  let route!: Route
  const ctx = { connection: { fetch: { register(value: Route) { route = value; return async () => undefined } } },
    sessionController: { async resolveAgent() { return { agent: { session: { id: resolvedSession, header: {} } } } } },
  }
  const references = createMemoryEvidenceReferenceStore()
  const dispatch = createPdfSelectionDispatch(workspaces, pages,
    references, () => async () => ({ path: '/paper.pdf',
      digest: evidenceSha256(Buffer.from('%PDF')) }))
  registerPdfTransport(ctx, dispatch,
  { endpoint: 'pdf.selection', maxRequestBytes: 64 * 1024 })
  const payload = { sessionId: 'session-a', documentId: 'doc-a', expectedRevision: 3,
    expectedContentVersion: 'content-a', quote: 'Hello', fragments: [{ page: 1,
      rect: [10, 38, 60, 50] as [number, number, number, number], quadPoints: [10, 50, 60, 50, 10, 38, 60, 38] }] }
  return { route, payload, dispatch, references }
}

async function call<Value = { text: string; excerpts: { refId: string }[] }>(route: Route, payload: unknown) {
  const response = await route.fetch(new Request('https://example.test/api/pdf.selection', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', method: 'pdf.selection', rpcId: 'test-1', payload }),
  }))
  return response.json() as Promise<{ result: { ok: boolean; value?: Value;
    error?: { code: string } } }>
}

test('the Client selection adapter and authenticated Host route share prepare and revalidation contracts', async () => {
  const { route, payload, references } = fixture()
  const connection = { rpc: { async call(_path: string, method: string, request: unknown) {
    assert.equal(method, 'pdf.selection')
    return (await call<unknown>(route, request)).result
  } } } as PdfConnection
  const api = createTextSelectionEvidenceApi(connection, new AbortController().signal)
  const captured = await api.prepare(payload)
  const refs = captured.excerpts.map(excerpt => excerpt.refId)
  const original = structuredClone(references.get(refs[0]!))
  const result = await api.revalidate({ sessionId: payload.sessionId, documentId: payload.documentId,
    expectedRevision: payload.expectedRevision, expectedContentVersion: payload.expectedContentVersion,
    selections: [{ id: 'question-1', refIds: refs }] })
  assert.equal(result.selections[0]!.text, captured.text)
  assert.deepEqual(result.selections[0]!.evidenceRefs, refs)
  assert.equal(result.selections[0]!.fragments[0]!.page, 1)
  assert.equal(result.selections[0]!.fragments[0]!.quadPoints.length, 8)
  assert.deepEqual(references.get(refs[0]!), original)
  await assert.rejects(api.revalidate({ sessionId: payload.sessionId, documentId: payload.documentId,
    expectedRevision: payload.expectedRevision - 1, expectedContentVersion: payload.expectedContentVersion,
    selections: [{ id: 'question-1', refIds: refs }] }), { code: 'pdf/stale-reader' })
})

test('pdf.selection RPC authenticates the caller and returns Host canonical text with a durable ref', async () => {
  const { route, payload } = fixture()
  const accepted = await call(route, payload)
  assert.equal(accepted.result.ok, true)
  assert.equal(accepted.result.value?.text, 'Hello')
  assert.match(accepted.result.value!.excerpts[0]!.refId, /^pdfref_/)
  const forged = await call(route, { ...payload, quote: 'World' })
  assert.equal(forged.result.ok, false)
  assert.equal(forged.result.error?.code, 'pdf/selection-mismatch')
  const foreign = await call(route, { ...payload, sessionId: 'session-b' })
  assert.equal(foreign.result.ok, false)
  assert.equal(foreign.result.error?.code, 'pdf/session-mismatch')
  const wrongAgent = fixture('session-b')
  const refused = await call(wrongAgent.route, wrongAgent.payload)
  assert.equal(refused.result.error?.code, 'pdf/session-mismatch')
  await assert.rejects(wrongAgent.dispatch('session-a', { ...wrongAgent.payload, sessionId: 'session-b' },
    { session: { id: 'session-a', header: {} } } as never, new AbortController().signal),
  { code: 'pdf/session-mismatch' })
})

test('pdf.selection revalidation accepts opaque references and returns only currently verified text and geometry', async () => {
  const { route, payload, references } = fixture()
  const captured = await call(route, payload), refId = captured.result.value!.excerpts[0]!.refId
  const before = structuredClone(references.get(refId))
  const input = { action: 'revalidate', sessionId: payload.sessionId, documentId: payload.documentId,
    expectedRevision: payload.expectedRevision, expectedContentVersion: payload.expectedContentVersion,
    selections: [{ id: 'first-question', refIds: [refId] }] }
  const accepted = await call<SelectionRevalidationResult>(route, input)
  assert.equal(accepted.result.ok, true)
  assert.deepEqual(accepted.result.value, { documentId: 'doc-a', sourcePath: '/paper.pdf',
    sourceDigest: evidenceSha256(Buffer.from('%PDF')), sourceVersion: 'source-a', contentVersion: 'content-a', revision: 3,
    selections: [{ id: 'first-question', text: 'Hello', evidenceRefs: [refId],
      fragments: [{ page: 1, rect: [10, 39.8, 60, 40.8], quadPoints: [10, 40.8, 60, 40.8, 10, 39.8, 60, 39.8] }] }],
  })
  assert.deepEqual(references.get(refId), before)
  for (const changed of [{ expectedRevision: 2 }, { expectedContentVersion: 'other-content' }]) {
    const rejected = await call(route, { ...input, ...changed })
    assert.equal(rejected.result.ok, false)
    assert.equal(rejected.result.error?.code, 'pdf/stale-reader')
  }
  const foreign = await call(route, { ...input, sessionId: 'another-session' })
  assert.equal(foreign.result.error?.code, 'pdf/session-mismatch')
  const wrongAgent = fixture('another-session')
  await assert.rejects(wrongAgent.dispatch(payload.sessionId, input,
    { session: { id: 'another-session', header: {} } } as never, new AbortController().signal),
  { code: 'pdf/session-mismatch' })
})

test('selection RPC preserves legacy prepare requests and rejects unbounded or forged revalidation payloads', () => {
  const { payload } = fixture()
  assert.equal(selectionEvidenceRequestSchema.safeParse(payload).success, true)
  assert.equal(selectionEvidenceRequestSchema.safeParse({ ...payload, action: 'prepare' }).success, true)
  const refId = 'pdfref_00000000-0000-0000-0000-000000000000'
  const input = { action: 'revalidate', sessionId: 'session-a', documentId: 'doc-a',
    expectedRevision: 3, expectedContentVersion: 'content-a', selections: [{ id: 'first', refIds: [refId] }] }
  assert.equal(selectionEvidenceRequestSchema.safeParse(input).success, true)
  for (const invalid of [
    { ...input, selections: [] },
    { ...input, selections: Array.from({ length: 21 }, (_, index) => ({ id: `q-${index}`, refIds: [refId] })) },
    { ...input, selections: [{ id: 'q', refIds: [] }] },
    { ...input, selections: [{ id: 'q', refIds: Array.from({ length: 11 }, () => refId) }] },
    { ...input, selections: [{ id: 'q', refIds: [refId] }, { id: 'q', refIds: [refId] }] },
    { ...input, selections: [{ id: 'q', refIds: ['pdfref_invalid'] }] },
    { ...input, selections: [{ id: 'q', refIds: [refId], quote: 'Forged source text' }] },
    { ...input, quote: 'Forged source text' },
    { ...input, action: 'unknown' },
    { ...payload, action: 'revalidate' },
  ]) assert.equal(selectionEvidenceRequestSchema.safeParse(invalid).success, false)
})
