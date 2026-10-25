import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { EmbeddingRegistry, type EmbeddingEngine } from '../src/embedding/index.ts'
import { createOpenAiCompatibleEmbeddingEngine, LOCAL_QWEN3_REVISION } from '../src/adapters/host/embedding/openai-compatible.ts'
import { registerPdfAgentTools } from '../src/adapters/host/dsh/agent-tools.ts'
import { createPdfRetrieval } from '../src/adapters/host/dsh/retrieval.ts'
import { createPdfService } from '../src/adapters/host/pdfium/index.ts'
import { createRetrievalCache, type RetrievalCacheRecord } from '../src/adapters/host/storage/retrieval-cache.ts'
import { createMemoryEvidenceReferenceStore, type PdfTextEvidence } from '../src/modules/evidence/index.ts'
import { createAgentNavigation, createReaderContexts } from '../src/modules/navigation/index.ts'
import { defaultSettings } from '../src/shared/contracts.ts'
import type { AgentNavigationRequest } from '../src/contracts/navigation.ts'
import { memoryWorkspace } from '../tests/native-fixture.ts'
import { NativeTestSubprocess } from '../tests/native-test-subprocess.ts'
import { environmentMetadata } from './metadata.ts'

// Deliberately opt-in. This exercises a real local model and native PDFium, but
// the PDF is generated in memory and contains no user documents or credentials.
const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, 'model-revision': { type: 'string', default: LOCAL_QWEN3_REVISION },
  sdk: { type: 'string', default: 'source' }, out: { type: 'string' },
} })
if (!values.endpoint) throw new Error('Pass --endpoint http://127.0.0.1:8001/v1/embeddings to explicitly run local model integration.')
if (values.sdk !== 'source' && values.sdk !== 'dist') throw new Error('--sdk must be source or dist')
const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (!existsSync(executable)) throw new Error('The native PDFium helper is required; run the native build first.')
const Registry = values.sdk === 'dist'
  ? (await import(pathToFileURL(resolve('dist/embedding.js')).href) as { EmbeddingRegistry: typeof EmbeddingRegistry }).EmbeddingRegistry
  : EmbeddingRegistry
const paragraphs = [
  'A database index speeds up lookups by organizing keys in a separate structure. It uses extra storage and must be maintained after writes.',
  'A transaction is atomic: either all of its changes are committed, or none take effect. If one step fails, rollback removes earlier writes.',
  'Replication copies data to multiple servers. A replica may lag behind the primary server, so an immediate read can return an older value.',
  'A backup is a separate copy used to recover after deletion or corruption. Periodic restore tests check whether the copy can actually be read.',
  'An operating system schedules processes on the processor. Context switching lets several programs make progress while sharing the same hardware.',
  'Network latency is the time a message needs to reach another computer. Bandwidth describes the amount of information sent per second.',
]
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica)
for (const [index, text] of paragraphs.entries()) {
  const page = fixture.addPage([612, 792])
  page.drawText(`Synthetic retrieval fixture - page ${index + 1}`, { font, x: 48, y: 730, size: 12 })
  page.drawText(text, { font, x: 48, y: 670, size: 12, maxWidth: 500, lineHeight: 18 })
}
const bytes = await fixture.save()
const records = new Map<string, RetrievalCacheRecord>()
const sessionId = 'synthetic-real-embedding-retrieval'
const agent = { session: { id: sessionId, header: {} } }
const signal = AbortSignal.timeout(120_000)
const counts = { documents: 0, documentRequests: 0, queries: 0, queryRequests: 0 }
type Counts = typeof counts
type Tool = { name: string; execute(input: unknown, context: unknown): Promise<unknown> }
type Result = Omit<Awaited<ReturnType<ReturnType<typeof createPdfRetrieval>['search']>>, 'nextCursor'> & {
  searchId: string; hasMore: boolean
}
const difference = (start: Counts): Counts => Object.fromEntries(Object.entries(counts)
  .map(([key, value]) => [key, value - start[key as keyof Counts]])) as Counts

async function measured<T>(operation: () => Promise<T>) {
  const started = performance.now(), cpu = process.cpuUsage(), before = { ...counts }
  const result = await operation()
  const durationMs = performance.now() - started, used = process.cpuUsage(cpu)
  return { result, metrics: { durationMs, processCpuMs: (used.user + used.system) / 1000,
    processRssBytes: process.memoryUsage().rss, embedding: difference(before) } }
}

function createRuntime(maxBatchSize = 8) {
  const workspace = memoryWorkspace(bytes)
  const pdf = createPdfService(workspace.workspaces, { executable, subprocess: new NativeTestSubprocess() })
  const references = createMemoryEvidenceReferenceStore(), contexts = createReaderContexts(workspace.workspaces)
  const navigation = createAgentNavigation(workspace.workspaces, contexts, 2000)
  const registry = new Registry()
  const transport = createOpenAiCompatibleEmbeddingEngine()
  const counted: EmbeddingEngine = { ...transport, async embed(request, config) {
    if (request.purpose === 'document') { counts.documents += request.texts.length; counts.documentRequests++ }
    else { counts.queries += request.texts.length; counts.queryRequests++ }
    return transport.embed(request, config)
  } }
  registry.register(counted)
  const cache = createRetrievalCache({ get: key => records.get(key),
    async put(key, record) { records.set(key, structuredClone(record)) },
    async delete(key) { return records.delete(key) }, entries: () => records.entries(),
  } as Parameters<typeof createRetrievalCache>[0])
  const binding = { engineId: transport.descriptor.id,
    config: { endpoint: values.endpoint!, modelRevision: values['model-revision']!, maxBatchSize } }
  const retrieval = createPdfRetrieval(workspace.workspaces, pdf, references, {
    cache, embeddings: registry, settings: () => ({ ...defaultSettings, embeddingEngine: binding.engineId,
      engineConfigurations: { embedding: { [binding.engineId]: binding.config } } }),
  })
  const tools = new Map<string, Tool>()
  const disposeTools = registerPdfAgentTools({ get: () => undefined,
    tools: { register(tool: Tool) { tools.set(tool.name, tool) } },
  } as unknown as Parameters<typeof registerPdfAgentTools>[0], workspace.workspaces, pdf, contexts,
  references, workspace.files, navigation, retrieval)
  const run = (name: string, input: unknown) => tools.get(name)!.execute(input, { agent, signal })
  async function search(documentId: string) {
    const input = { documentId, query: '如果一次操作中途失败，如何保证已经完成的修改不会残留？', mode: 'hybrid', topK: 3 }
    let result = await run('pdf_find_related', input) as Result
    const searchId = result.searchId
    assert.match(searchId, /^rel_[a-f0-9]{12}$/)
    assert.equal('nextCursor' in result, false, 'The model must not receive internal cursor state')
    let steps = 1
    while (result.hasMore) {
      assert.ok(steps < 20, 'Synthetic fixture must finish within a bounded number of indexing steps')
      result = await run('pdf_find_related', { searchId: result.searchId }) as Result
      assert.equal(result.searchId, searchId, 'ID-only continuation retains the same search')
      assert.equal('nextCursor' in result, false)
      steps++
    }
    assert.equal(result.status, 'complete')
    assert.equal(result.effectiveMode, 'hybrid')
    assert.equal(result.coverage.indexedPages, paragraphs.length)
    assert.equal(result.coverage.visual, 'not-indexed')
    assert.equal(result.candidates[0]?.page, 2, 'Chinese intent must find the original English transaction passage')
    const hit = result.candidates[0]!
    assert.equal(hit.quote, hit.evidence.snapshot.text)
    return { ...result, steps }
  }
  return { workspace, registry, navigation, contexts, run, search,
    model: registry.describe(binding),
    async dispose() {
      await disposeTools()
      navigation.dispose(); contexts.dispose(); registry.dispose()
      await cache.dispose(); await pdf.dispose(); await workspace.workspaces.dispose()
    },
  }
}

let runtime = createRuntime()
try {
  const opened = await runtime.run('pdf_open', { path: '/fixtures/native.pdf' }) as { documentId: string }
  const cold = await measured(() => runtime.search(opened.documentId))
  assert.ok(cold.metrics.embedding.documents > 0)
  const warm = await measured(() => runtime.search(opened.documentId))
  assert.equal(warm.metrics.embedding.documents, 0, 'Warm searches must reuse document vectors')
  const evidence = warm.result.candidates[0]!.evidence as PdfTextEvidence
  const annotation = await measured(() => runtime.run('pdf_annotate', { documentId: opened.documentId,
    expectedRevision: warm.result.revision, subtype: 'Highlight', target: { kind: 'reference', refId: evidence.refId } }))
  const changed = annotation.result as { revision: number; dirty: boolean; annotationId: string; coverage: { complete: boolean } }
  assert.equal(changed.dirty, true)
  assert.equal(changed.coverage.complete, true)
  assert.equal(runtime.workspace.writes(), 0)
  const ui = await runtime.workspace.workspaces.execute(sessionId, { action: 'open', sessionId, owner: 'ui', referenceId: 'reader-view',
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in ui)
  assert.equal(ui.id, opened.documentId)
  assert.ok(ui.document.annotations.some(mark => mark.id === changed.annotationId && mark.page === 2 && mark.quadPoints?.length))
  const lease = { sessionId, tabId: 'reader', leaseId: 'lease', documentId: ui.id, contentVersion: ui.contentVersion }
  runtime.contexts.update(sessionId, { action: 'set', ...lease, sequence: 1, page: 1 })
  const pending = runtime.navigation.dispatch(sessionId, { action: 'wait', ...lease }, signal)
  const jumping = runtime.run('pdf_navigate', { documentId: ui.id, refId: evidence.refId })
  const request = await pending as AgentNavigationRequest
  assert.equal(request.page, 2)
  assert.ok(request.target?.quadPoints.length)
  await runtime.navigation.dispatch(sessionId, { action: 'complete', ...lease, requestId: request.requestId,
    status: 'opened', targetRevision: request.target!.revision, sourceDigest: request.target!.sourceDigest }, signal)
  assert.equal((await jumping as { status: string }).status, 'opened')
  const afterAnnotation = await measured(() => runtime.search(opened.documentId))
  assert.equal(afterAnnotation.metrics.embedding.documents, 0, 'Draft annotation does not re-embed unchanged source text')
  const model = runtime.model
  await runtime.dispose()
  const serializedCache = JSON.stringify([...records])
  // Re-create both the cache adapter and logical documents; only persisted cache
  // records survive. This is a cache-adapter restart, not a DSH process restart.
  records.clear()
  for (const [key, value] of JSON.parse(serializedCache) as [string, RetrievalCacheRecord][]) records.set(key, value)
  runtime = createRuntime()
  const reopened = await runtime.run('pdf_open', { path: '/fixtures/native.pdf' }) as { documentId: string }
  assert.notEqual(reopened.documentId, opened.documentId)
  const restored = await measured(() => runtime.search(reopened.documentId))
  assert.equal(restored.metrics.embedding.documents, 0, 'Restored derived cache must reuse document vectors with a new logical document ID')
  const measuredCache = { records: records.size, serializedBytes: Buffer.byteLength(serializedCache) }
  // Force a real continuation without introducing a large or private document:
  // six pages exceed four one-input embedding batches in a single indexing step.
  await runtime.dispose()
  runtime = createRuntime(1)
  const continuationDocument = await runtime.run('pdf_open', { path: '/fixtures/native.pdf' }) as { documentId: string }
  const continued = await runtime.search(continuationDocument.documentId)
  assert.ok(continued.steps > 1, 'The real model probe must exercise ID-only continuation')
  assert.equal(runtime.workspace.writes(), 0)
  const output = { benchmark: 'real-pdfium-local-embedding-integration-v1', ...environmentMetadata(),
    sdk: values.sdk, model, fixture: { kind: 'synthetic-memory-only', pages: paragraphs.length, bytes: bytes.length },
    coldIndex: cold.metrics, warmQuery: warm.metrics, annotation: annotation.metrics,
    afterAnnotation: afterAnnotation.metrics, reopenedCache: restored.metrics,
    cache: measuredCache,
    verified: { crossLanguageHitPage: 2, originalTextEvidence: true, exactReferenceAnnotation: true,
      sharedUiDraft: true, acknowledgedNavigation: true, originalFileWrites: 0, restoredCacheEmbeddings: 0,
      shortIdContinuation: { steps: continued.steps, embeddingBatchSize: 1, onlySearchId: true, complete: true } },
    limitations: ['Cold means empty retrieval cache; the separate MLX service may already be warm.',
      'CPU/RSS cover this Node benchmark process, excluding the PDFium child and external MLX server.',
      'Cache records survive JSON round-trip in memory; no DSH storage driver or full desktop UI is mounted.',
      'Navigation is an acknowledged Host contract, not a browser viewport or multi-level back interaction.',
      'Six synthetic text pages demonstrate the integration path, not general retrieval quality or large-document performance.'] }
  if (values.out) await writeFile(values.out, JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify(output, null, 2))
} finally { await runtime.dispose() }
