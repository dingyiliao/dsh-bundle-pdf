import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { registerPdfAgentTools } from '../../../../src/surfaces/host/tools/agent-tools.ts'
import { createPdfRetrieval } from '../../../../src/layers/facade/search/host-retrieval.ts'
import { createPdfService } from '../../../../src/capabilities/pdfium/index.ts'
import { EmbeddingRegistry } from '../../../../src/engines/embedding/sdk/index.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256, prepareTextSelectionEvidence,
  type PdfTextEvidence } from '../../../../src/layers/facade/evidence/index.ts'
import { createAgentNavigation, createReaderContexts } from '../../../../src/layers/facade/navigation/index.ts'
import { NativeDocument } from '../../../../src/surfaces/client/viewer/rendering/document.ts'
import { navigateAgentRequest } from '../../../../src/surfaces/client/viewer/controllers/agent-text-navigation.ts'
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
const sessionId = 'native-reference-with-unmapped-page'
const agent = { session: { id: sessionId, header: {} } }
const passage = 'Training error does not certify generalization.'
type Tool = { name: string; execute(input: unknown, execution: unknown): Promise<unknown> }

async function fixture() {
  const state = memoryWorkspace(await partialTextMappingFixture())
  let recognitions = 0
  const pdf = createPdfService(state.workspaces, { executable, subprocess: new NativeTestSubprocess(),
    textRecovery: { async recognize() {
      recognitions++
      throw new Error('Page text reads must not trigger automatic local OCR')
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

test('pages with unmapped symbols keep native text for Reader, selection evidence, search, annotation and navigation without OCR',
  { skip: !existsSync(executable) }, async () => {
    const f = await fixture()
    let visible: NativeDocument | undefined
    try {
      const id = f.opened.documentId
      const native = await f.pdf.readPageText(sessionId, id, 2, signal)
      assert.ok(native.content.quality!.unmappedCharacters > 0, 'the real PDF has a damaged Unicode mapping')
      assert.ok(joinPageText(native.content.items).includes(passage))
      const result = await f.run('pdf_semantic_search', { documentId: id, query: 'generalization', topK: 4 }) as {
        status: string; candidates: Array<{ page: number; quote: string; annotationStatus: string; evidence: PdfTextEvidence }> }
      assert.equal(result.status, 'complete')
      const hit = result.candidates.find(candidate => candidate.page === 2 && candidate.quote.includes(passage))!
      assert.ok(hit)
      assert.equal(hit.annotationStatus, 'unavailable', 'quality warnings are reported conservatively')
      assert.equal(hit.evidence.extraction, undefined)

      const narrowed = await f.run('pdf_evidence_read', { documentId: id, refId: hit.evidence.refId, quote: passage }) as {
        refId: string; pages: PdfTextEvidence[] }
      assert.equal(narrowed.pages[0]!.snapshot.text, passage)
      assert.equal(narrowed.pages[0]!.extraction, undefined)

      const pageRead = await f.run('pdf_page_read', { documentId: id, page: 2 }) as {
        text: string; limitations?: string[]; evidence: PdfTextEvidence }
      assert.ok(pageRead.text.includes(passage))
      assert.match(pageRead.limitations?.[0] ?? '', /undecodable characters/)
      assert.equal(f.recognitions(), 0, 'page reads keep native text without starting OCR')
      // Whole-page reference includes undecodable glyphs and must be narrowed before markup.
      await assert.rejects(f.run('pdf_annotation_create', { documentId: id, expectedRevision: 0,
        subtype: 'Highlight', target: { kind: 'reference', refId: pageRead.evidence.refId } }),
      { code: 'pdf/text-geometry-unavailable' })

      // Explanation-mode text selection succeeds on the clean passage of the same page,
      // and fails closed with selection-unverifiable when selecting the undecodable run.
      const cleanItem = native.content.items.find(item => item.str.includes(passage))!
      const cleanBox: [number, number, number, number] = [38, 495, 40 + cleanItem.width + 2, 520]
      const cleanSelection = await prepareTextSelectionEvidence(f.state.workspaces, f.pdf, f.references, {
        sessionId, documentId: id, expectedRevision: 0,
        expectedContentVersion: f.state.workspaces.readSnapshot(sessionId, id).contentVersion,
        quote: passage,
        fragments: [{ page: 2, rect: cleanBox,
          quadPoints: [cleanBox[0], cleanBox[3], cleanBox[2], cleanBox[3], cleanBox[0], cleanBox[1], cleanBox[2], cleanBox[1]] }],
      }, signal, async (_session, observed) => ({ path: observed.path, digest: evidenceSha256(observed.bytes) }))
      assert.equal(cleanSelection.text, passage)

      const brokenItem = native.content.items.find(item => item.str.includes('\ufffd'))!
      const brokenBox: [number, number, number, number] = [38, 345, 40 + brokenItem.width + 2, 370]
      await assert.rejects(prepareTextSelectionEvidence(f.state.workspaces, f.pdf, f.references, {
        sessionId, documentId: id, expectedRevision: 0,
        expectedContentVersion: f.state.workspaces.readSnapshot(sessionId, id).contentVersion,
        quote: brokenItem.str,
        fragments: [{ page: 2, rect: brokenBox,
          quadPoints: [brokenBox[0], brokenBox[3], brokenBox[2], brokenBox[3], brokenBox[0], brokenBox[1], brokenBox[2], brokenBox[1]] }],
      }, signal, async (_session, observed) => ({ path: observed.path, digest: evidenceSha256(observed.bytes) })),
      { code: 'pdf/selection-unverifiable' })

      const changed = await f.run('pdf_annotation_create', { documentId: id, expectedRevision: 0,
        subtype: 'Highlight', target: { kind: 'reference', refId: narrowed.refId } }) as {
        revision: number; annotationId: string; resolvedTarget: { rectPdf: number[] }; savedToFile: boolean }
      assert.equal(changed.revision, 1)
      assert.equal(changed.savedToFile, false)
      assert.ok(changed.resolvedTarget.rectPdf[1]! > 480)
      const snapshot = await f.pdf.dispatch(sessionId, { action: 'open', sessionId,
        address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as WorkspaceSnapshot
      const api = { async text(owner, documentId, reader, page, active) {
        return await f.pdf.native(owner, { action: 'text', sessionId: owner, id: documentId,
          bytesHash: reader.bytesHash, page }, agent, active ?? signal) as NativeTextContent
      } } as NativeReaderApi
      visible = new NativeDocument(snapshot, sessionId, api)
      assert.ok(joinPageText((await visible.text(2, signal)).items).includes(passage))
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
      assert.equal(f.recognitions(), 0)
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
      assert.ok(child.pages.every(page => page.extraction === undefined))
      assert.equal(f.recognitions(), 0)
      assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.documentId).revision, 0)
      assert.equal(f.state.writes(), 0)
    } finally { await f.dispose() }
  })
