import assert from 'node:assert/strict'
import test from 'node:test'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.js'
import { createMemoryEvidenceReferenceStore, createImageEvidenceRegistry, evidenceSha256,
  type PdfImageEvidence, type SavedReference } from '../../../../src/modules/evidence/index.js'
import { createAgentNavigation, createReaderContexts } from '../../../../src/modules/navigation/index.js'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.js'
import type { AgentNavigationRequest } from '../../../../src/contracts/navigation.js'

const signal = new AbortController().signal
const caller = (id = 'alice') => ({ session: { id, header: {} } })
type Tool = { name: string; execute(raw: unknown, exec: unknown): Promise<unknown> }

async function fixture(source: 'ocr-text' | 'auxiliary-vision' = 'ocr-text', region = false) {
  let bytes = new Uint8Array([37, 80, 68, 70]), sourceBytes = bytes, revision = 0, reads = 0, pins = 0, nativeReads = 0
  let beforeSourceRead: ((active: AbortSignal) => Promise<void>) | undefined
  const snapshot = (): HostWorkspaceSnapshot => ({ id: 'doc', path: '/fixtures/paper.pdf', bytes,
    contentVersion: 'content', sourceVersion: 'source', revision, conflict: false,
    document: { pageCount: 3, pages: Array.from({ length: 3 }, () => ({ cropBox: [0, 0, 300, 400] })) },
  } as HostWorkspaceSnapshot)
  const readSnapshot = (owner: string, documentId: string) => {
    if (owner !== 'alice' || documentId !== 'doc') throw Object.assign(new Error('Foreign document'), { code: 'pdf/session-mismatch' })
    return snapshot()
  }
  const workspaces = { readSnapshot, async acquire(owner: string, id: string, _agent: unknown, active: AbortSignal) {
    active.throwIfAborted(); readSnapshot(owner, id); pins++; return () => { pins-- }
  }, onIdle() { return () => {} }, listDocuments() { return [] } } as never
  const store = createMemoryEvidenceReferenceStore()
  const registry = createImageEvidenceRegistry({ readSnapshot }, store)
  const evidence = await registry.mint('alice', { documentId: 'doc', sourcePath: snapshot().path,
    sourceDigest: evidenceSha256(bytes), sourceVersion: 'source', contentVersion: 'content', revision, page: 2,
    renderedImageSha256: evidenceSha256('rendered PNG'), source,
    locator: region ? { kind: 'pdf-region', rectPdf: [10, 20, 40, 60] } : { kind: 'page-only' },
    precision: region ? 'approximate-geometry' : 'page-only', limitations: ['Derived text'],
    snapshot: { kind: 'derived-text', text: 'Visible diagram labels', sha256: evidenceSha256('Visible diagram labels'), backendId: 'fixture' },
  }, signal)
  const contexts = createReaderContexts({ readSnapshot })
  const navigation = createAgentNavigation({ readSnapshot }, contexts, 1000)
  const lease = { sessionId: 'alice', tabId: 'tab', leaseId: 'lease', documentId: 'doc', contentVersion: 'content' }
  contexts.update('alice', { action: 'set', ...lease, sequence: 1, page: 1 })
  const tools = new Map<string, Tool>()
  const ctx = { get() { return undefined }, tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => {} } } } as never
  const files = { async read(agent: ReturnType<typeof caller>, path: string, active: AbortSignal) {
    reads++; assert.equal(agent.session.id, 'alice'); assert.equal(path, snapshot().path)
    await beforeSourceRead?.(active); active.throwIfAborted()
    return { path, bytes: sourceBytes, version: evidenceSha256(sourceBytes) }
  } } as never
  const dispose = registerPdfAgentTools(ctx, workspaces, { async readPageText() {
    nativeReads++; throw new Error('Derived references must not use native text')
  } } as never, contexts, store, files, navigation)
  const run = (input = {}, active = signal, owner = 'alice') => tools.get('pdf_page_jump')!.execute(
    { documentId: 'doc', refId: evidence.refId, ...input }, { signal: active, agent: caller(owner) })
  return { evidence, store, lease, contexts, navigation, run, snapshot,
    counts() { return { reads, pins, nativeReads } },
    changeRevision() { revision++ }, changeBytes() { bytes = new Uint8Array([...bytes, 1]); sourceBytes = bytes },
    overwriteSource() { sourceBytes = new Uint8Array([0]) },
    sourceRead(callback: (active: AbortSignal) => Promise<void>) { beforeSourceRead = callback },
    async dispose() { navigation.dispose(); contexts.dispose(); await dispose() } }
}

for (const source of ['ocr-text', 'auxiliary-vision'] as const) {
  test(`${source} reference uses the existing Reader page handoff and retains its validated locator`, async () => {
    const f = await fixture(source, true)
    try {
      const pending = f.run()
      const handed = await f.navigation.dispatch('alice', { action: 'wait', ...f.lease }, signal) as AgentNavigationRequest
      assert.equal(handed.page, 2)
      assert.equal(handed.target, undefined, 'Derived text must never be represented as native text geometry')
      assert.equal(f.counts().pins, 1, 'The document remains held until Reader acknowledgement')
      await f.navigation.dispatch('alice', { action: 'complete', ...f.lease, requestId: handed.requestId, status: 'opened' }, signal)
      const result = await pending as { status: string; precision: string; locator: PdfImageEvidence['locator']; refId: string }
      assert.equal(result.status, 'opened')
      assert.equal(result.precision, 'page-only')
      assert.deepEqual(result.locator, { kind: 'pdf-region', rectPdf: [10, 20, 40, 60] })
      assert.equal(result.refId, f.evidence.refId)
      assert.deepEqual(f.counts(), { reads: 2, pins: 0, nativeReads: 0 })
    } finally { await f.dispose() }
  })
}

test('derived navigation rejects foreign sessions, tampered saved refs and text-digest changes', async () => {
  const f = await fixture()
  const saved = f.store.get(f.evidence.refId)!
  try {
    await assert.rejects(f.run({}, signal, 'bob'), { code: 'pdf/session-mismatch' })
    await f.store.put(f.evidence.refId, { ...saved, sessionId: 'bob' })
    await assert.rejects(f.run(), { code: 'pdf/reference-unavailable' })
    await f.store.put(f.evidence.refId, { ...saved, evidence: { ...f.evidence,
      refId: 'pdfref_00000000-0000-0000-0000-000000000000' } })
    await assert.rejects(f.run(), { code: 'pdf/reference-unavailable' })
    await f.store.put(f.evidence.refId, { ...saved, evidence: { ...f.evidence, snapshot: {
      ...f.evidence.snapshot, text: 'Changed labels',
    } } } as SavedReference)
    await assert.rejects(f.run(), { code: 'pdf/stale-reader' })
    await f.store.put(f.evidence.refId, { ...saved, evidence: { ...f.evidence,
      locator: { kind: 'pdf-region', rectPdf: [40, 20, 10, 60] },
    } })
    await assert.rejects(f.run(), { code: 'pdf/invalid-region' })
    assert.equal(f.counts().nativeReads, 0)
    assert.equal(f.counts().pins, 0)
  } finally { await f.dispose() }
})

test('derived navigation rejects stale source bytes and an external overwrite before handoff', async () => {
  for (const change of ['changeBytes', 'overwriteSource'] as const) {
    const f = await fixture()
    try {
      f[change]()
      await assert.rejects(f.run(), { code: 'pdf/stale-reader' })
      assert.equal(f.counts().pins, 0)
    } finally { await f.dispose() }
  }
})

test('derived navigation rebinds a byte-identical revision before using the same page handoff', async () => {
  const f = await fixture()
  try {
    f.changeRevision()
    const pending = f.run()
    const handed = await f.navigation.dispatch('alice', { action: 'wait', ...f.lease }, signal) as AgentNavigationRequest
    await f.navigation.dispatch('alice', { action: 'complete', ...f.lease, requestId: handed.requestId, status: 'opened' }, signal)
    const result = await pending as { precision: string; refId: string }
    assert.equal(result.precision, 'page-only')
    assert.notEqual(result.refId, f.evidence.refId)
  } finally { await f.dispose() }
})

test('caller cancellation during fresh-source validation never reaches the Reader', async () => {
  const f = await fixture(), controller = new AbortController()
  try {
    f.sourceRead(async active => { controller.abort(new Error('cancelled navigation')); active.throwIfAborted() })
    await assert.rejects(f.run({}, controller.signal), /cancelled navigation/)
    assert.equal(f.counts().reads, 1)
    assert.equal(f.counts().pins, 0)
  } finally { await f.dispose() }
})
