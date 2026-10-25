import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { createMemoryEvidenceReferenceStore, type PdfTextEvidence } from '../../../../src/modules/evidence/index.ts'
import { createAgentNavigation, createReaderContexts } from '../../../../src/modules/navigation/index.ts'
import { EmbeddingRegistry, type EmbeddingEngine } from '../../../../src/embedding/index.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'
import type { AgentNavigationRequest } from '../../../../src/contracts/navigation.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'
import { nativeTestSubprocess } from '../../../native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const native = { skip: !existsSync(executable) }
const signal = new AbortController().signal
const sessionId = 'synthetic-retrieval-integration'
const agent = { session: { id: sessionId, header: {} } }
type Tool = { name: string; execute(input: unknown, context: unknown): Promise<unknown> }

// Deterministic wiring fixture only. Real retrieval quality is measured separately
// by bench/retrieval.ts using the supplied Qwen model, never these vectors.
function testEngine(): EmbeddingEngine {
  return { descriptor: { id: 'fixture', name: 'Fixture encoder', execution: 'local', version: '1' },
    describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1',
      dimensions: 2, maxBatchSize: 8, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'fixture-v1' }),
    async embed(request) { return request.texts.map(text => /atomic|rollback|all.or.nothing/i.test(text) ? [1, 0] : [0, 1]) } }
}

test('hybrid tools reuse original evidence for shared-draft annotation and acknowledged exact navigation', native, async () => {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica)
  for (const text of ['A short introduction about databases.',
    'Atomic operations are all-or-nothing.', 'Indexes accelerate queries by storing ordered keys.']) {
    document.addPage([500, 300]).drawText(text, { x: 40, y: 220, size: 12, font })
  }
  const state = memoryWorkspace(await document.save())
  const pdf = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const refs = createMemoryEvidenceReferenceStore(), contexts = createReaderContexts(state.workspaces)
  const navigation = createAgentNavigation(state.workspaces, contexts, 2000)
  const registry = new EmbeddingRegistry()
  const remove = registry.register(testEngine())
  const retrieval = createPdfRetrieval(state.workspaces, pdf, refs,
    { embeddings: registry, settings: () => ({ ...defaultSettings, embeddingEngine: 'fixture' }) })
  const tools = new Map<string, Tool>()
  const dispose = registerPdfAgentTools({ get: () => undefined,
    tools: { register(tool: Tool) { tools.set(tool.name, tool) } },
  } as unknown as Parameters<typeof registerPdfAgentTools>[0], state.workspaces, pdf, contexts, refs,
  state.files, navigation, retrieval)
  const run = (name: string, input: unknown, owner = agent) => tools.get(name)!.execute(input, { agent: owner, signal })
  try {
    const opened = await run('pdf_open', { path: '/fixtures/native.pdf' }) as { documentId: string }
    const status = await run('pdf_status', { documentId: opened.documentId }) as { capabilities: { semanticSearch: boolean } }
    assert.equal(status.capabilities.semanticSearch, true)
    const input = { documentId: opened.documentId, query: 'all-or-nothing rollback', mode: 'hybrid', topK: 2 }
    const related = await run('pdf_find_related', input) as {
      status: string; effectiveMode: string; revision: number; coverage: { visual: string; totalPages: number }
      candidates: { page: number; quote: string; evidence: PdfTextEvidence }[]
    }
    assert.equal(related.status, 'complete')
    assert.equal(related.effectiveMode, 'hybrid')
    assert.equal(related.coverage.totalPages, 3)
    assert.equal(related.coverage.visual, 'not-indexed')
    assert.equal(related.candidates[0]!.page, 2)
    const hit = related.candidates[0]!
    assert.equal(hit.evidence.snapshot.text, hit.quote)
    const changed = await run('pdf_annotate', { documentId: opened.documentId,
      expectedRevision: related.revision, subtype: 'Highlight', target: { kind: 'reference', refId: hit.evidence.refId } }) as {
      revision: number; dirty: boolean; annotationId: string
    }
    assert.equal(changed.dirty, true)
    assert.equal(state.writes(), 0, 'retrieval and annotation never save the source')
    const ui = await state.workspaces.execute(sessionId, { action: 'open', sessionId, owner: 'ui',
      referenceId: 'view', address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
    assert.ok('bytes' in ui)
    assert.equal(ui.id, opened.documentId)
    assert.ok(ui.document.annotations.some(annotation => annotation.id === changed.annotationId))
    const lease = { sessionId, tabId: 'reader', leaseId: 'lease', documentId: ui.id, contentVersion: ui.contentVersion }
    contexts.update(sessionId, { action: 'set', ...lease, sequence: 1, page: 1 })
    const pending = navigation.dispatch(sessionId, { action: 'wait', ...lease }, signal)
    const jump = run('pdf_navigate', { documentId: ui.id, refId: hit.evidence.refId })
    const request = await pending as AgentNavigationRequest
    assert.equal(request.page, 2)
    assert.ok(request.target?.quadPoints.length)
    await navigation.dispatch(sessionId, { action: 'complete', ...lease, requestId: request.requestId,
      status: 'opened', targetRevision: request.target!.revision, sourceDigest: request.target!.sourceDigest }, signal)
    assert.equal((await jump as { status: string }).status, 'opened')
    await assert.rejects(run('pdf_find_related', input, { session: { id: 'foreign', header: {} } }))
    remove()
    const unloaded = await run('pdf_status', { documentId: opened.documentId }) as { capabilities: { semanticSearch: boolean } }
    assert.equal(unloaded.capabilities.semanticSearch, false)
    await assert.rejects(run('pdf_find_related', input), { code: 'pdf/retrieval-engine-unavailable' })
    const fallback = await run('pdf_find_related', { ...input, mode: 'auto' }) as { effectiveMode: string; fallbackReason: string }
    assert.equal(fallback.effectiveMode, 'lexical')
    assert.ok(fallback.fallbackReason)
  } finally {
    await dispose(); navigation.dispose(); contexts.dispose(); registry.dispose()
    await pdf.dispose(); await state.workspaces.dispose()
  }
})
