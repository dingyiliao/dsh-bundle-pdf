import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { EmbeddingRegistry } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore, type PdfTextEvidence } from '../../../../src/modules/evidence/index.ts'
import { createAgentNavigation, createReaderContexts } from '../../../../src/modules/navigation/index.ts'
import { NativeDocument } from '../../../../src/client/viewer/rendering/document.ts'
import { navigateAgentRequest } from '../../../../src/client/viewer/controllers/agent-text-navigation.ts'
import { defaultSettings, type WorkspaceSnapshot } from '../../../../src/shared/contracts.ts'
import { joinPageText } from '../../../../src/shared/page-text.ts'
import type { NativeReaderApi, NativeTextContent } from '../../../../src/shared/native.ts'
import type { AgentNavigationRequest } from '../../../../src/contracts/navigation.ts'
import { partialTextMappingFixture } from '../../../fixtures/broken-text-mapping.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'
import { NativeTestSubprocess } from '../../../native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER
  ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const signal = new AbortController().signal
const sessionId = 'native-reference-with-repairable-page'
const agent = { session: { id: sessionId, header: {} } }
const passage = 'Training error does not certify generalization.'
type Tool = { name: string; execute(input: unknown, execution: unknown): Promise<unknown> }

async function fixture() {
  const state = memoryWorkspace(await partialTextMappingFixture())
  let recognitions = 0
  const pdf = createPdfService(state.workspaces, { executable, subprocess: new NativeTestSubprocess(),
    // Recognition itself is isolated; native Unicode failure, rendering,
    // reference resolution, draft changes and Client navigation are real.
    textRecovery: { async recognize() {
      recognitions++
      const text = `OCR transcription: ${passage} BAD MAPPING`
      return { text, status: 'complete', blocks: [], lines: [],
        words: [{ id: 'recognized-line', parentId: 'line', text,
          box: { x0: 40, y0: 40, x1: 400, y1: 100 }, confidence: null }],
        confidence: null, coverage: [], warnings: [] }
    }, async dispose() {} } })
  const references = createMemoryEvidenceReferenceStore(), contexts = createReaderContexts(state.workspaces)
  const navigation = createAgentNavigation(state.workspaces, contexts, 2000)
  const embeddings = new EmbeddingRegistry()
  embeddings.register({ descriptor: { id: 'representation-fixture', name: 'Fixture', version: '1', execution: 'local' },
    describe: () => ({ engineId: 'representation-fixture', engineVersion: '1', model: 'fixture', modelRevision: '1',
      dimensions: 2, maxBatchSize: 8, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'representation-v1' }),
    async embed(request) { return request.texts.map(text => request.purpose === 'query' || text.includes(passage) ? [1, 0] : [0, 1]) } })
  const retrieval = createPdfRetrieval(state.workspaces, pdf, references, { embeddings,
    settings: () => ({ ...defaultSettings, embeddingEngine: 'representation-fixture' }) })
  const tools = new Map<string, Tool>()
  const dispose = registerPdfAgentTools({ get: () => undefined,
    tools: { register(tool: Tool) { tools.set(tool.name, tool) } } } as never,
  state.workspaces, pdf, contexts, references, state.files, navigation, retrieval)
  const run = (name: string, input: unknown) => tools.get(name)!.execute(input, { agent, signal })
  const opened = await run('pdf_open', { path: '/fixtures/native.pdf' }) as { documentId: string }
  return { state, pdf, references, contexts, navigation, run, opened,
    recognitions: () => recognitions,
    async dispose() { await dispose(); navigation.dispose(); contexts.dispose(); embeddings.dispose()
      await pdf.dispose(); await state.workspaces.dispose() } }
}

test('native search references remain readable and precisely navigable when the same page also has cached OCR',
  { skip: !existsSync(executable) }, async () => {
    const f = await fixture()
    let visible: NativeDocument | undefined
    try {
      const id = f.opened.documentId
      const native = await f.pdf.readPageText(sessionId, id, 2, signal, { recover: false })
      assert.ok(native.content.quality!.unmappedCharacters > 0, 'the real PDF has a damaged Unicode mapping')
      assert.ok(joinPageText(native.content.items).includes(passage))
      const result = await f.run('pdf_semantic_search', { documentId: id, query: 'generalization', topK: 4 }) as {
        status: string; candidates: Array<{ page: number; quote: string; annotationStatus: string; evidence: PdfTextEvidence }> }
      assert.equal(result.status, 'complete')
      const hit = result.candidates.find(candidate => candidate.page === 2 && candidate.quote.includes(passage))!
      assert.ok(hit)
      assert.equal(hit.annotationStatus, 'unavailable', 'quality warnings are reported conservatively')
      assert.equal(hit.evidence.extraction, undefined)

      // The original failure occurred here: rereading immediately switched to
      // OCR and invalidated the newly issued native reference.
      const narrowed = await f.run('pdf_evidence_read', { documentId: id, refId: hit.evidence.refId, quote: passage }) as {
        refId: string; pages: PdfTextEvidence[] }
      assert.equal(narrowed.pages[0]!.snapshot.text, passage)
      assert.equal(narrowed.pages[0]!.extraction, undefined)
      assert.equal(f.recognitions(), 0, 'revalidating native evidence must not start OCR')

      const repaired = await f.run('pdf_page_read', { documentId: id, page: 2 }) as { extraction: string; evidence: PdfTextEvidence }
      assert.equal(repaired.extraction, 'local-ocr')
      assert.equal(f.recognitions(), 1)
      const repeated = await f.run('pdf_evidence_read', { documentId: id, refId: hit.evidence.refId, quote: passage }) as {
        pages: PdfTextEvidence[] }
      assert.equal(repeated.pages[0]!.snapshot.text, passage, 'cached OCR cannot replace a native parent representation')
      await assert.rejects(f.run('pdf_annotation_create', { documentId: id, expectedRevision: 0,
        subtype: 'Highlight', target: { kind: 'reference', refId: repaired.evidence.refId } }),
      { code: 'pdf/text-geometry-unavailable' })

      // A valid native run on a partially damaged page is still decided by
      // fresh selected-glyph geometry, never by a capability-report flag.
      const changed = await f.run('pdf_annotation_create', { documentId: id, expectedRevision: 0,
        subtype: 'Highlight', target: { kind: 'reference', refId: narrowed.refId } }) as {
        revision: number; annotationId: string; resolvedTarget: { rectPdf: number[] }; savedToFile: boolean }
      assert.equal(changed.revision, 1)
      assert.equal(changed.savedToFile, false)
      assert.ok(changed.resolvedTarget.rectPdf[1]! > 480)
      const snapshot = await f.pdf.dispatch(sessionId, { action: 'open', sessionId,
        address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as WorkspaceSnapshot
      const api = { async text(owner, documentId, reader, page, active, options) {
        return await f.pdf.native(owner, { action: 'text', sessionId: owner, id: documentId,
          bytesHash: reader.bytesHash, page, ...(options ? { recover: options.recover } : {}) }, agent,
        active ?? signal) as NativeTextContent
      } } as NativeReaderApi
      visible = new NativeDocument(snapshot, sessionId, api)
      assert.equal((await visible.text(2, signal)).extraction, 'local-ocr', 'the visible Reader may already cache repaired text')
      const lease = { sessionId, tabId: 'reader', leaseId: 'lease', documentId: id, contentVersion: snapshot.contentVersion }
      f.contexts.update(sessionId, { action: 'set', ...lease, sequence: 1, page: 1 })
      const awaited = f.navigation.dispatch(sessionId, { action: 'wait', ...lease }, signal)
      const jumping = f.run('pdf_page_jump', { documentId: id, refId: narrowed.refId })
      const request = await awaited as AgentNavigationRequest
      assert.equal(request.page, 2)
      assert.deepEqual(request.target!.rectPdf, changed.resolvedTarget.rectPdf)
      let jumps = 0
      const status = await navigateAgentRequest(request, signal, {
        current: () => ({ snapshot, document: visible!, visible: true, ready: true, viewportHeight: 600 }),
        subscribe: () => () => {}, async jump(page, _position, remember, guard) {
          guard!.validate(); assert.equal(page, 2); assert.equal(remember, true); jumps++; return true
        } })
      await f.navigation.dispatch(sessionId, { action: 'complete', ...lease, requestId: request.requestId, status,
        targetRevision: request.target!.revision, sourceDigest: request.target!.sourceDigest }, signal)
      assert.equal(status, 'opened')
      assert.equal((await jumping as { status: string }).status, 'opened')
      assert.equal(jumps, 1)
      assert.equal(f.recognitions(), 1, 'native navigation does not rerun cached OCR or use its offsets')
      assert.equal(f.state.writes(), 0, 'model edits and navigation leave the original PDF untouched')
    } finally { await visible?.dispose(); await f.dispose() }
  })

test('continuous native capture and narrowing keep raw text through a repairable page without invoking OCR',
  { skip: !existsSync(executable) }, async () => {
    const f = await fixture()
    try {
      const range = await f.run('pdf_evidence_read', { documentId: f.opened.documentId,
        range: { start: { page: 1, quote: 'Opening page' }, end: { page: 2, quote: passage } } }) as {
        refId: string; pages: PdfTextEvidence[] }
      assert.deepEqual(range.pages.map(page => page.page), [1, 2])
      const child = await f.run('pdf_evidence_read', { documentId: f.opened.documentId, refId: range.refId,
        quote: passage }) as { pages: PdfTextEvidence[] }
      assert.equal(child.pages[0]!.snapshot.text, passage)
      assert.ok(child.pages.every(page => !page.extraction))
      assert.equal(f.recognitions(), 0)
      assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.documentId).revision, 0)
      assert.equal(f.state.writes(), 0)
    } finally { await f.dispose() }
  })
