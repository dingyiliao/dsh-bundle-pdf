import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfSelectionDispatch } from '../../../../src/adapters/host/dsh/selection-evidence.ts'
import { registerPdfTransport } from '../../../../src/adapters/host/dsh/transport.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'

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
  const dispatch = createPdfSelectionDispatch(workspaces, pages,
    createMemoryEvidenceReferenceStore(), () => async () => ({ path: '/paper.pdf',
      digest: evidenceSha256(Buffer.from('%PDF')) }))
  registerPdfTransport(ctx, dispatch,
  { endpoint: 'pdf.selection', maxRequestBytes: 64 * 1024 })
  const payload = { sessionId: 'session-a', documentId: 'doc-a', expectedRevision: 3,
    expectedContentVersion: 'content-a', quote: 'Hello', fragments: [{ page: 1,
      rect: [10, 38, 60, 50], quadPoints: [10, 50, 60, 50, 10, 38, 60, 38] }] }
  return { route, payload, dispatch }
}

async function call(route: Route, payload: unknown) {
  const response = await route.fetch(new Request('https://example.test/api/pdf.selection', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', method: 'pdf.selection', rpcId: 'test-1', payload }),
  }))
  return response.json() as Promise<{ result: { ok: boolean; value?: { text: string; excerpts: { refId: string }[] };
    error?: { code: string } } }>
}

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
