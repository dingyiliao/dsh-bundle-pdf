import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { EmbeddingRegistry, type EmbeddingEngine } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore, type PdfTextEvidence } from '../../../../src/modules/evidence/index.ts'
import { createAgentNavigation, createReaderContexts } from '../../../../src/modules/navigation/index.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'
import type { AgentNavigationRequest } from '../../../../src/contracts/navigation.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'
import { nativeTestSubprocess } from '../../../native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER
  ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const signal = new AbortController().signal
const sessionId = 'retrieval-paragraph-annotation'
const agent = { session: { id: sessionId, header: {} } }
const paragraph = [
  'A model may memorize examples in its training set and still fail on',
  'unfamiliar data. This gap is known as overfitting.',
].join('\n')
type Tool = { name: string; execute(input: unknown, context: unknown): Promise<unknown> }

async function sampleDocument() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([540, 720]).drawText('Learning algorithms fit examples.', { x: 42, y: 505, size: 15, font })
  const page = pdf.addPage([540, 720])
  const draw = (text: string, y: number, size: number) => page.drawText(text, { x: 42, y, size, font })
  draw('MACHINE LEARNING / FIELD NOTES', 632, 10)
  draw('02 / GENERALIZATION', 606, 9)
  draw('When memorization fails', 558, 25)
  paragraph.split('\n').forEach((line, index) => draw(line, 505 - index * 25, 15))
  draw('Good generalization means learning patterns that remain useful', 429, 15)
  draw('beyond the examples seen during training.', 404, 15)
  draw('Evaluate the model on held-out data. A low training error together', 353, 15)
  draw('with a much larger validation error is a warning sign.', 328, 15)
  draw('DSH PDF READER / EXAMPLE DOCUMENT', 44, 9)
  pdf.addPage([540, 720]).drawText('Regularization discourages overly complex solutions.',
    { x: 42, y: 505, size: 15, font })
  return pdf.save()
}

// The deterministic encoder isolates the range contract; actual retrieval quality
// is checked separately by the opt-in real local-model integration benchmark.
const engine: EmbeddingEngine = {
  descriptor: { id: 'range-fixture', name: 'Range fixture', execution: 'local', version: '1' },
  describe: () => ({ engineId: 'range-fixture', engineVersion: '1', model: 'range-fixture', modelRevision: '1',
    dimensions: 2, maxBatchSize: 8, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'range-fixture-v1' }),
  async embed(request) {
    return request.texts.map(text => request.purpose === 'query' || text.includes('overfitting') ? [1, 0] : [0, 1])
  },
}

test('short-page semantic evidence highlights only the matched wrapped paragraph and navigates to the same range',
  { skip: !existsSync(executable) }, async () => {
    const state = memoryWorkspace(await sampleDocument())
    const pdf = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
    const references = createMemoryEvidenceReferenceStore(), contexts = createReaderContexts(state.workspaces)
    const navigation = createAgentNavigation(state.workspaces, contexts, 2000)
    const embeddings = new EmbeddingRegistry()
    embeddings.register(engine)
    const retrieval = createPdfRetrieval(state.workspaces, pdf, references, { embeddings,
      settings: () => ({ ...defaultSettings, embeddingEngine: engine.descriptor.id }) })
    const tools = new Map<string, Tool>()
    const dispose = registerPdfAgentTools({ get: () => undefined,
      tools: { register(tool: Tool) { tools.set(tool.name, tool) } },
    } as unknown as Parameters<typeof registerPdfAgentTools>[0], state.workspaces, pdf, contexts, references,
    state.files, navigation, retrieval)
    const run = (name: string, input: unknown) => tools.get(name)!.execute(input, { agent, signal })
    try {
      const opened = await run('pdf_open', { path: '/fixtures/native.pdf' }) as { documentId: string }
      const related = await run('pdf_semantic_search', { documentId: opened.documentId,
        query: '为什么练习题都能做对，换一批题就不行了？', topK: 1 }) as {
        status: string; effectiveMode: string; revision: number
        coverage: { totalChunks: number }
        candidates: { page: number; quote: string; evidence: PdfTextEvidence }[]
      }
      assert.equal(related.status, 'complete')
      assert.equal(related.effectiveMode, 'semantic')
      assert.ok(related.coverage.totalChunks <= 12, 'wrapped lines must not each become a separate indexed chunk')
      const hit = related.candidates[0]!
      assert.equal(hit.page, 2)
      assert.equal(hit.quote, paragraph, 'the retrieval reference must exclude the heading, adjacent paragraphs and footer')
      assert.equal(hit.evidence.snapshot.text, paragraph)
      const changed = await run('pdf_annotation_create', { documentId: opened.documentId,
        expectedRevision: related.revision, subtype: 'Highlight',
        target: { kind: 'reference', refId: hit.evidence.refId } }) as {
        revision: number; dirty: boolean; canUndo: boolean; savedToFile: boolean; annotationId: string
        coverage: { pages: { text: string }[] }
      }
      assert.equal(changed.dirty, true)
      assert.equal(changed.canUndo, true)
      assert.equal(changed.savedToFile, false)
      assert.deepEqual(changed.coverage.pages.map(page => page.text), [paragraph])
      const snapshot = state.workspaces.readSnapshot(sessionId, opened.documentId)
      const mark = snapshot.document.annotations.find(annotation => annotation.id === changed.annotationId)!
      assert.ok(mark.rect)
      assert.ok(mark.rect[1] > 450 && mark.rect[3] < 520, 'native geometry must cover only the two matching lines')
      assert.equal(mark.quadPoints?.length, 16)
      const ui = await state.workspaces.execute(sessionId, { action: 'open', sessionId, owner: 'ui',
        referenceId: 'reader-view', address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
      assert.ok('bytes' in ui)
      assert.equal(ui.id, opened.documentId)
      assert.ok(ui.document.annotations.some(annotation => annotation.id === changed.annotationId))
      const lease = { sessionId, tabId: 'reader', leaseId: 'lease', documentId: ui.id, contentVersion: ui.contentVersion }
      contexts.update(sessionId, { action: 'set', ...lease, sequence: 1, page: 1 })
      const pending = navigation.dispatch(sessionId, { action: 'wait', ...lease }, signal)
      const jump = run('pdf_page_jump', { documentId: ui.id, refId: hit.evidence.refId })
      const request = await pending as AgentNavigationRequest
      assert.equal(request.page, 2)
      assert.deepEqual(request.target!.rectPdf, mark.rect)
      await navigation.dispatch(sessionId, { action: 'complete', ...lease, requestId: request.requestId,
        status: 'opened', targetRevision: request.target!.revision, sourceDigest: request.target!.sourceDigest }, signal)
      assert.equal((await jump as { status: string }).status, 'opened')
      const undone = await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
        id: ui.id, revision: changed.revision }, agent, signal)
      assert.ok('bytes' in undone)
      assert.ok(!undone.document.annotations.some(annotation => annotation.id === changed.annotationId))

      // Context deliberately retains a whole page. Selecting a subquote must
      // retain that parent anchor while narrowing both markup and navigation.
      const context = await run('pdf_page_read', { documentId: ui.id, page: 2 }) as { evidence: PdfTextEvidence }
      const parent = context.evidence
      assert.match(parent.snapshot.text, /MACHINE LEARNING/)
      assert.match(parent.snapshot.text, /EXAMPLE DOCUMENT/)
      const narrowed = await run('pdf_evidence_read', { documentId: ui.id, refId: parent.refId, quote: paragraph }) as { refId: string }
      const refined = await run('pdf_annotation_create', { documentId: ui.id,
        expectedRevision: undone.revision, subtype: 'Highlight',
        target: { kind: 'reference', refId: narrowed.refId } }) as {
        revision: number; annotationId: string
        resolvedTarget: { refId: string; quote: string; rectPdf: number[] }
        coverage: { pages: { text: string }[] }
      }
      assert.equal(refined.resolvedTarget.refId, narrowed.refId)
      assert.deepEqual(refined.coverage.pages.map(page => page.text), [paragraph])
      const nextRequest = navigation.dispatch(sessionId, { action: 'wait', ...lease }, signal)
      const preciseJump = run('pdf_page_jump', { documentId: ui.id, refId: narrowed.refId })
      const preciseRequest = await nextRequest as AgentNavigationRequest
      assert.deepEqual(preciseRequest.target!.rectPdf, refined.resolvedTarget.rectPdf)
      await navigation.dispatch(sessionId, { action: 'complete', ...lease, requestId: preciseRequest.requestId,
        status: 'opened', targetRevision: preciseRequest.target!.revision,
        sourceDigest: preciseRequest.target!.sourceDigest }, signal)
      assert.equal((await preciseJump as { status: string }).status, 'opened')
      const unrefined = await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
        id: ui.id, revision: refined.revision }, agent, signal)
      assert.ok('bytes' in unrefined)
      const wholePage = await run('pdf_annotation_create', { documentId: ui.id,
        expectedRevision: unrefined.revision, subtype: 'Highlight',
        target: { kind: 'reference', refId: parent.refId } }) as {
        revision: number; coverage: { pages: { text: string }[] }
      }
      assert.equal(wholePage.coverage.pages[0]!.text, parent.snapshot.text,
        'a deliberately broad reference must not be silently truncated')
      await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
        id: ui.id, revision: wholePage.revision }, agent, signal)
      assert.equal(state.writes(), 0, 'model annotation and navigation must not save over the source PDF')
    } finally {
      await dispose(); navigation.dispose(); contexts.dispose(); embeddings.dispose()
      await pdf.dispose(); await state.workspaces.dispose()
    }
  })
