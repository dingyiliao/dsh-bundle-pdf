import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/index.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { createAgentNavigation, createReaderContexts } from '../../../../src/modules/navigation/index.ts'
import { evidenceSha256, type PdfTextEvidence } from '../../../../src/modules/evidence/index.ts'
import type { AgentNavigationRequest } from '../../../../src/contracts/navigation.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'
import { nativeTestSubprocess } from '../../../native-test-subprocess.ts'

const signal = new AbortController().signal
const sessionId = 'evidence-loop-session'
const caller = (id = sessionId) => ({ session: { id, header: {} } })
const quote = 'Repeated evidence'
const nativeExecutable = process.env.DSH_PDF_NATIVE_HELPER
  ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(nativeExecutable)) {
  throw new Error('Native tests require a built helper')
}
const native = { skip: !existsSync(nativeExecutable) }
type CapturedTool = { name: string; execute(raw: unknown, exec: unknown): Promise<unknown> }
type SearchResult = { revision: number; searchId: string; hasMore: boolean;
  matches: Array<{ page: number; offset: number; evidence: PdfTextEvidence }> }
type AnnotationResult = { status: string; revision: number; annotationId: string; dirty: boolean; canUndo: boolean;
  coverage: { complete: true; pages: Array<{ annotationId: string; refId: string; text: string; startUtf16: number }> } }

async function pdfFixture() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([400, 400])
  page.drawText(quote, { x: 60, y: 300, size: 12, font })
  page.drawText('An unrelated middle paragraph', { x: 60, y: 230, size: 12, font })
  page.drawText(quote, { x: 60, y: 160, size: 12, font })
  return pdf.save()
}

async function fixture() {
  const state = memoryWorkspace(await pdfFixture())
  const pdf = createPdfService(state.workspaces, { executable: nativeExecutable, subprocess: nativeTestSubprocess })
  const contexts = createReaderContexts(state.workspaces)
  const navigation = createAgentNavigation(state.workspaces, contexts, 2000)
  const tools = new Map<string, CapturedTool>()
  const ctx = { get() { return undefined }, tools: { register(tool: CapturedTool) {
    tools.set(tool.name, tool); return () => { tools.delete(tool.name) }
  } } } as unknown as Parameters<typeof registerPdfAgentTools>[0]
  let navigationCalls = 0, afterRead: (() => void) | undefined
  const dispose = registerPdfAgentTools(ctx, state.workspaces, { ...pdf,
    async readPageText(...args: Parameters<typeof pdf.readPageText>) {
      const result = await pdf.readPageText(...args)
      afterRead?.()
      return result
    },
  }, contexts, undefined, state.files, { navigate(...args) {
    navigationCalls++
    return navigation.navigate(...args)
  } })
  const run = (name: string, raw: unknown, inputSignal = signal, owner = sessionId) => {
    const tool = tools.get(name)
    assert.ok(tool, `${name} must be registered`)
    return tool.execute(raw, { signal: inputSignal, agent: caller(owner) })
  }
  const opened = await run('pdf_open', { path: '/fixtures/native.pdf' }) as {
    documentId: string; revision: number; contentVersion: string; readerUiOpened: boolean
  }
  assert.equal(opened.readerUiOpened, false)
  const search = await run('pdf_keyword_search', { documentId: opened.documentId, query: quote }) as SearchResult
  assert.match(search.searchId, /^txt_[a-f0-9]{12}$/)
  assert.equal(search.hasMore, false)
  assert.equal('nextCursor' in search, false)
  assert.equal(search.matches.length, 2)
  assert.equal(search.matches[0]!.evidence.snapshot.text, quote)
  assert.equal(search.matches[1]!.evidence.snapshot.text, quote)
  assert.ok(search.matches[1]!.evidence.locator.startUtf16 > search.matches[0]!.evidence.locator.startUtf16)
  const refId = search.matches[1]!.evidence.refId
  const annotation = { documentId: opened.documentId, expectedRevision: search.revision,
    subtype: 'Highlight', target: { kind: 'reference', refId } }
  const showReader = async (owner = sessionId, documentId = opened.documentId) => {
    const snapshot = state.workspaces.readSnapshot(owner, documentId)
    const takeover = await state.workspaces.execute(owner, { action: 'open', sessionId: owner,
      owner: 'ui', referenceId: `view-${owner}`, address: `dsh-resource://file/session/${owner}//fixtures/native.pdf` }, caller(owner), signal)
    assert.ok('bytes' in takeover)
    assert.equal(takeover.id, documentId, 'UI takeover must reuse the same shared draft')
    const lease = { sessionId: owner, tabId: `tab-${owner}`, leaseId: `lease-${owner}`,
      documentId, contentVersion: snapshot.contentVersion }
    contexts.update(owner, { action: 'set', ...lease, sequence: 1, page: 1 })
    return lease
  }
  return { state, pdf, contexts, navigation, run, opened, search, refId, annotation, showReader,
    navigationCalls: () => navigationCalls, afterRead(callback: () => void) { afterRead = callback },
    async dispose() { navigation.dispose(); contexts.dispose(); await dispose(); await pdf.dispose(); await state.workspaces.dispose() } }
}

test('registered tools search the exact duplicate, annotate the shared draft, then revalidate the old reference for an acknowledged precise jump', native, async () => {
  const f = await fixture(), waitLifetime = new AbortController()
  try {
    const result = await f.run('pdf_annotation_create', f.annotation) as AnnotationResult
    assert.equal(result.status, 'updated')
    assert.equal(result.revision, f.search.revision + 1)
    assert.equal(result.dirty, true)
    assert.equal(result.canUndo, true)
    assert.equal(result.coverage.complete, true)
    assert.equal(result.coverage.pages[0]!.refId, f.refId)
    assert.equal(result.coverage.pages[0]!.startUtf16, f.search.matches[1]!.offset)
    assert.equal(result.coverage.pages[0]!.text, quote)
    const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.documentId)
    const mark = draft.document.annotations.find(item => item.id === result.annotationId)!
    assert.ok(mark.rect)
    assert.ok(mark.rect[1] < 160 && mark.rect[3] > 160)
    assert.ok(mark.rect[3] < 220, 'not the first repeated phrase at y=300 or middle paragraph')
    assert.ok(mark.quadPoints && mark.quadPoints.length >= 8)
    assert.equal(f.state.writes(), 0)
    const lease = await f.showReader()
    const waiting = f.navigation.dispatch(sessionId, { action: 'wait', ...lease }, waitLifetime.signal)
    const jump = f.run('pdf_page_jump', { documentId: f.opened.documentId, refId: f.refId })
    const request = await waiting as AgentNavigationRequest
    assert.equal(request.documentId, f.opened.documentId)
    assert.equal(request.page, 1)
    assert.equal(request.target!.refId, f.refId)
    assert.equal(request.target!.revision, result.revision, 'old evidence must be revalidated after annotation revision')
    assert.equal(request.target!.sourceDigest, evidenceSha256(draft.bytes))
    assert.deepEqual(request.target!.rectPdf, mark.rect)
    assert.deepEqual(request.target!.quadPoints, mark.quadPoints)
    assert.equal(request.target!.startUtf16, f.search.matches[1]!.offset)
    assert.deepEqual(await f.navigation.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, status: 'opened' }, signal), { accepted: false }, 'unattested legacy ack must not complete a precise jump')
    assert.deepEqual(await f.navigation.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, targetRevision: f.search.revision,
      sourceDigest: request.target!.sourceDigest, status: 'opened' }, signal), { accepted: false })
    assert.deepEqual(await f.navigation.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, targetRevision: request.target!.revision,
      sourceDigest: request.target!.sourceDigest, status: 'opened' }, signal), { accepted: true })
    assert.equal((await jump as { status: string }).status, 'opened')
    assert.equal(f.navigationCalls(), 1)
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.documentId).revision, result.revision,
      'navigation must not create a draft mutation')
    const undone = await f.state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: f.opened.documentId, revision: result.revision }, caller(), signal)
    assert.ok('bytes' in undone)
    assert.equal(undone.document.annotations.some(item => item.id === result.annotationId), false)
    assert.equal(f.state.writes(), 0)
  } finally { waitLifetime.abort(); await f.dispose() }
})

test('registered reference tools reject another session even when it opens the identical PDF path', native, async () => {
  const f = await fixture()
  try {
    const owner = 'other-evidence-session'
    const foreign = await f.run('pdf_open', { path: '/fixtures/native.pdf' }, signal, owner) as {
      documentId: string; revision: number
    }
    await f.showReader(owner, foreign.documentId)
    await assert.rejects(f.run('pdf_annotation_create', { ...f.annotation, documentId: foreign.documentId,
      expectedRevision: foreign.revision }, signal, owner), { code: 'pdf/reference-unavailable' })
    await assert.rejects(f.run('pdf_page_jump', { documentId: foreign.documentId, refId: f.refId }, signal, owner),
      { code: 'pdf/reference-unavailable' })
    assert.equal(f.navigationCalls(), 0)
    assert.equal(f.state.workspaces.readSnapshot(owner, foreign.documentId).revision, foreign.revision)
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.documentId).revision, f.opened.revision)
    assert.equal(f.state.writes(), 0)
  } finally { await f.dispose() }
})

test('an external source replacement cannot be annotated or shown as still-current evidence', native, async () => {
  const f = await fixture()
  try {
    await f.showReader()
    const replacement = Buffer.concat([await pdfFixture(), Buffer.from('\n% external revision\n')])
    await f.state.files.save(caller(), '/fixtures/native.pdf', replacement,
      evidenceSha256(f.state.current()), { signal })
    await assert.rejects(f.run('pdf_annotation_create', f.annotation), { code: 'pdf/stale-reader' })
    await assert.rejects(f.run('pdf_page_jump', { documentId: f.opened.documentId, refId: f.refId }), { code: 'pdf/stale-reader' })
    assert.equal(f.navigationCalls(), 0)
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.documentId).revision, f.opened.revision)
    assert.equal(f.state.writes(), 1, 'only the simulated external writer changed the source')
  } finally { await f.dispose() }
})

test('cancelling registered reference resolution during native extraction neither mutates nor dispatches a jump', native, async () => {
  const f = await fixture()
  try {
    await f.showReader()
    for (const tool of ['pdf_annotation_create', 'pdf_page_jump'] as const) {
      const controller = new AbortController()
      f.afterRead(() => controller.abort())
      await assert.rejects(f.run(tool, tool === 'pdf_annotation_create' ? f.annotation
        : { documentId: f.opened.documentId, refId: f.refId }, controller.signal), { name: 'AbortError' })
      assert.equal(f.state.workspaces.listDocuments().find(item => item.id === f.opened.documentId)!.pins, 0)
    }
    assert.equal(f.navigationCalls(), 0)
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.documentId).revision, f.opened.revision)
    assert.equal(f.state.writes(), 0)
  } finally { await f.dispose() }
})

test('a newer shared-draft revision during the Reader handoff cannot be acknowledged as an opened old target', native, async () => {
  const f = await fixture(), waitLifetime = new AbortController()
  try {
    const lease = await f.showReader()
    const waiting = f.navigation.dispatch(sessionId, { action: 'wait', ...lease }, waitLifetime.signal)
    const jump = f.run('pdf_page_jump', { documentId: f.opened.documentId, refId: f.refId })
    const request = await waiting as AgentNavigationRequest
    await f.run('pdf_annotation_create', f.annotation)
    assert.deepEqual(await f.navigation.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, targetRevision: request.target!.revision,
      sourceDigest: request.target!.sourceDigest, status: 'opened' }, signal), { accepted: true })
    assert.equal((await jump as { status: string }).status, 'stale')
  } finally { waitLifetime.abort(); await f.dispose() }
})
