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
import { EmbeddingError, EmbeddingRegistry, type EmbeddingEngine } from '../../../../src/embedding/index.ts'
import { createOpenAiCompatibleEmbeddingEngine } from '../../../../src/adapters/host/embedding/openai-compatible.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'
import type { AgentNavigationRequest } from '../../../../src/contracts/navigation.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'
import { nativeTestSubprocess } from '../../../native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const native = { skip: !existsSync(executable) }
const signal = new AbortController().signal
const sessionId = 'synthetic-retrieval-integration'
const agent = { session: { id: sessionId, header: {} } }
type Tool = { name: string; description: string; execute(input: unknown, context: unknown): Promise<unknown> }

// Deterministic wiring fixture only. Real retrieval quality is measured separately
// by bench/retrieval.ts using the supplied Qwen model, never these vectors.
function testEngine(): EmbeddingEngine {
  return { descriptor: { id: 'fixture', name: 'Fixture encoder', execution: 'local', version: '1' },
    describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1',
      dimensions: 2, maxBatchSize: 8, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'fixture-v1' }),
    async embed(request) { return request.texts.map(text => /atomic|rollback|all.or.nothing/i.test(text) ? [1, 0] : [0, 1]) } }
}

function adapterFixture(options: NonNullable<Parameters<typeof createPdfRetrieval>[3]> = {}) {
  const snapshot: HostWorkspaceSnapshot = { id: 'document', path: '/synthetic.pdf', bytes: new Uint8Array([1, 2, 3]),
    sourceVersion: 'source-1', contentVersion: 'content-1', revision: 0,
    dirty: false, conflict: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false } }
  const state = { snapshot, text: 'Atomic operations roll back all changes.', reads: 0, savedReferences: 0,
    texts: new Map<number, string>(), unmappedPages: new Set<number>(), warnings: new Map<number, string[]>(), failedPages: new Set<number>(),
    onRead: undefined as ((read: number) => void) | undefined }
  const references = createMemoryEvidenceReferenceStore()
  const put = references.put.bind(references)
  references.put = async (...args) => { state.savedReferences++; await put(...args) }
  const retrieval = createPdfRetrieval({ readSnapshot: () => state.snapshot }, {
    async readPageText(_sessionId, _id, page) {
      state.onRead?.(++state.reads)
      if (state.failedPages.has(page)) throw Object.assign(new Error('Fixture extraction failure'), { code: 'pdf/fixture-extraction' })
      return { snapshot: state.snapshot, content: { items: [{ str: state.texts.get(page) ?? state.text, transform: [1, 0, 0, 1, 0, 0],
        width: 100, height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }], styles: {}, lang: null,
        ...(state.unmappedPages.has(page) ? { quality: { unmappedCharacters: 1 } } : {}),
        ...(state.warnings.has(page) ? { warnings: state.warnings.get(page)! } : {}) } }
    },
  }, references, options)
  return { state, retrieval }
}

const fixtureSettings = () => ({ ...defaultSettings, embeddingEngine: 'fixture' })

test('semantic quality warnings summarize a book once and identify affected candidates without implying index failure', async () => {
  const registry = new EmbeddingRegistry()
  registry.register(testEngine())
  const { state, retrieval } = adapterFixture({ embeddings: registry, settings: fixtureSettings })
  state.snapshot.document.pageCount = 1151
  for (let page = 1; page <= 1151; page++) state.unmappedPages.add(page)
  try {
    await retrieval.prepare(sessionId, { documentId: 'document' }, signal)
    const result = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'semantic', topK: 2 }, signal)
    assert.equal(result.status, 'complete')
    assert.equal(result.effectiveMode, 'semantic')
    assert.deepEqual(result.coverage.failedPages, [])
    assert.equal(result.coverage.indexedPages, 1151)
    const warnings = result.coverage.qualityWarnings
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!.message, /native characters could not be decoded/)
    assert.equal(warnings[0]!.affectedPageCount, 1151)
    assert.deepEqual(warnings[0]!.candidatePages, result.candidates.map(candidate => candidate.page).sort((a, b) => a - b))
    assert.equal(warnings[0]!.sampleOtherPages.length, 8)
    assert.ok(warnings[0]!.sampleOtherPages.every(page => !warnings[0]!.candidatePages.includes(page)))
    assert.equal(warnings[0]!.omittedPageCount, 1141)
    assert.ok(result.candidates.every(candidate => candidate.annotationStatus === 'unavailable'))
    assert.ok(JSON.stringify(warnings).length < 600, 'thousands of repeated page warnings must not dominate tool output')
    assert.equal('qualityWarningsOmitted' in result.coverage, false)
  } finally { await retrieval.dispose(); registry.dispose() }
})

test('quality summaries deduplicate each page, preserve unknown messages and distinguish unrelated page warnings', async () => {
  const { state, retrieval } = adapterFixture()
  state.snapshot.document.pageCount = 3
  state.warnings.set(2, ['Custom extraction issue', 'Custom extraction issue'])
  state.warnings.set(3, ['Custom extraction issue', 'Another issue'])
  state.texts.set(2, 'An unrelated topic.')
  state.texts.set(3, 'A different section.')
  try {
    const result = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'lexical', topK: 1 }, signal)
    assert.equal(result.status, 'complete')
    assert.equal(result.candidates[0]!.page, 1)
    assert.deepEqual(result.coverage.qualityWarnings, [
      { message: 'Custom extraction issue', affectedPageCount: 2, candidatePages: [], sampleOtherPages: [2, 3], omittedPageCount: 0 },
      { message: 'Another issue', affectedPageCount: 1, candidatePages: [], sampleOtherPages: [3], omittedPageCount: 0 },
    ])
    assert.equal(result.candidates[0]!.annotationStatus, 'requires-geometry-check')
  } finally { await retrieval.dispose() }
})

test('quality warning types are bounded with explicit omissions and candidate issues come first', async () => {
  const { state, retrieval } = adapterFixture()
  state.snapshot.document.pageCount = 12
  for (let page = 1; page <= 12; page++) state.warnings.set(page, [`Issue on page ${page}`])
  try {
    const result = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'lexical', topK: 1 }, signal)
    assert.equal(result.coverage.qualityWarnings.length, 8)
    assert.deepEqual(result.coverage.qualityWarnings[0]!.candidatePages, result.candidates.map(candidate => candidate.page))
    assert.deepEqual(result.coverage.qualityWarningsOmitted, { warningTypes: 4, affectedPageCount: 4, candidatePages: [] })
  } finally { await retrieval.dispose() }
})

test('quality summaries preserve empty warnings and real extraction failures', async () => {
  const { state, retrieval } = adapterFixture()
  try {
    const clean = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'lexical' }, signal)
    assert.deepEqual(clean.coverage.qualityWarnings, [])
    assert.equal('qualityWarningsOmitted' in clean.coverage, false)
    state.snapshot = { ...state.snapshot, bytes: new Uint8Array([4, 5]), contentVersion: 'next',
      document: { ...state.snapshot.document, pageCount: 2 } }
    state.failedPages.add(2)
    state.unmappedPages.add(1)
    const incomplete = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'lexical' }, signal)
    assert.equal(incomplete.status, 'incomplete')
    assert.deepEqual(incomplete.coverage.failedPages, [{ page: 2, attempts: 1, code: 'pdf/fixture-extraction' }])
    assert.equal(incomplete.coverage.qualityWarnings[0]!.affectedPageCount, 1)
    assert.deepEqual(incomplete.candidates, [])
  } finally { await retrieval.dispose() }
})

test('omitted warning types still identify affected candidate pages', async () => {
  const { state, retrieval } = adapterFixture()
  state.warnings.set(1, Array.from({ length: 12 }, (_, index) => `Issue ${index}`))
  try {
    const result = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'lexical' }, signal)
    assert.ok(result.coverage.qualityWarnings.every(warning => warning.candidatePages.includes(1)))
    assert.deepEqual(result.coverage.qualityWarningsOmitted, { warningTypes: 4, affectedPageCount: 1, candidatePages: [1] })
  } finally { await retrieval.dispose() }
})

for (const scenario of ['disabled', 'missing-engine', 'not-configured', 'engine-disabled', 'missing-registry', 'offline'] as const) {
  test(`semantic tools report ${scenario} before reading pages and reject direct execution without fallback`, async () => {
    const registry = new EmbeddingRegistry()
    const engine = testEngine()
    let embeds = 0, pins = 0
    registry.register({ ...engine,
      describe(config) {
        if (scenario === 'not-configured') throw new EmbeddingError('not-configured', 'Private configuration details')
        if (scenario === 'engine-disabled') throw new EmbeddingError('disabled', 'Private engine details')
        return engine.describe(config)
      },
      async availability() { return { status: scenario === 'offline' ? 'unavailable' : 'available' } },
      async embed(request, config) { embeds++; return engine.embed(request, config) },
    })
    const selected = scenario === 'disabled' ? 'none' : scenario === 'missing-engine' ? 'missing' : 'fixture'
    const { retrieval, state } = adapterFixture({
      ...(scenario === 'missing-registry' ? {} : { embeddings: registry }),
      settings: () => ({ ...defaultSettings, embeddingEngine: selected }),
    })
    const workspaces = { readSnapshot: () => state.snapshot, listDocuments: () => [],
      onIdle: () => () => {}, touch() {}, async acquire() { pins++; return () => { pins-- } } }
    const tools = new Map<string, Tool>()
    const dispose = registerPdfAgentTools({ get: () => undefined,
      tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
    } as never, workspaces as never, {} as never, { current: () => [] } as never,
    undefined, undefined, undefined, retrieval)
    const run = (name: string, input: unknown) => tools.get(name)!.execute(input, { agent, signal })
    const reasons = { disabled: /disabled in PDF settings/,
      'missing-engine': /not installed or is no longer available/,
      'not-configured': /needs configuration in PDF settings/,
      'engine-disabled': /selected embedding engine is disabled/,
      'missing-registry': /registry is not installed/,
      offline: /not currently available/ }
    try {
      const status = await run('pdf_status', { documentId: 'document' }) as {
        capabilities: Record<string, boolean>; capabilityDetails: { semanticSearch: { available: boolean; reason: string } }
      }
      assert.equal(status.capabilities.semanticSearch, false)
      assert.equal('findRelatedText' in status.capabilities, false, 'removed composite capability must not promise a usable search')
      assert.equal(status.capabilityDetails.semanticSearch.available, false)
      assert.match(status.capabilityDetails.semanticSearch.reason, reasons[scenario])
      assert.match(status.capabilityDetails.semanticSearch.reason, /pdf_keyword_search/)
      assert.doesNotMatch(status.capabilityDetails.semanticSearch.reason, /Private/)
      assert.match(tools.get('pdf_semantic_search')!.description, /pdf_status.*capabilities\.semanticSearch=true/)
      assert.match(tools.get('pdf_status')!.description, /before starting pdf_semantic_search/)
      await assert.rejects(run('pdf_semantic_search', { documentId: 'document', query: 'Explain atomic rollback',
        topK: 10, fromPage: 1, maxPages: 1151 }), error => {
        assert.equal((error as { code: string }).code, 'pdf/semantic-unavailable')
        assert.match((error as Error).message, reasons[scenario])
        return true
      })
      assert.equal(state.reads, 0, 'an unavailable semantic tool cannot start indexing or silently search keywords')
      assert.equal(state.savedReferences, 0)
      assert.equal(embeds, 0)
      assert.equal(pins, 0, 'status and failed searches release their working-copy pins')
    } finally { await dispose(); registry.dispose() }
  })
}

test('unavailable embedding probes preserve lexical retrieval without advertising semantic search', async () => {
  for (const code of ['engine-unavailable', 'not-configured', 'timeout'] as const) {
    const registry = new EmbeddingRegistry()
    registry.register({ ...testEngine(), async availability() { throw new EmbeddingError(code, 'Fixture unavailable') } })
    const { retrieval } = adapterFixture({ embeddings: registry, settings: fixtureSettings })
    try {
      const availability = await retrieval.availability(sessionId, signal)
      assert.equal(availability.status, 'unavailable')
      assert.match(availability.reason!, /pdf_keyword_search remains available/)
      const result = await retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'auto' }, signal)
      assert.equal(result.effectiveMode, 'lexical')
      assert.equal(result.candidates.length, 1)
      await assert.rejects(retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'semantic' }, signal),
      { code: 'pdf/retrieval-engine-unavailable' })
    } finally { await retrieval.dispose(); registry.dispose() }
  }
})

test('background preparation rejects an unavailable embedding engine before extraction and releases its document pin', async () => {
  const registry = new EmbeddingRegistry()
  let pins = 0, releases = 0, freshChecks = 0, embeds = 0
  registry.register({ ...testEngine(), async availability() { return { status: 'unavailable' } },
    async embed() { embeds++; throw new Error('An unavailable engine must not receive document text') } })
  const { retrieval, state } = adapterFixture({ embeddings: registry, settings: fixtureSettings,
    async retain() { pins++; return () => { pins--; releases++ } },
    async freshSource() { freshChecks++ },
  })
  try {
    await assert.rejects(retrieval.prepare(sessionId, { documentId: 'document' }, signal), error => {
      assert.equal((error as { code: string }).code, 'pdf/retrieval-engine-unavailable')
      assert.match((error as Error).message, /not currently available/)
      return true
    })
    assert.equal(pins, 0)
    assert.equal(releases, 1)
    assert.equal(freshChecks, 1)
    assert.equal(state.reads, 0)
    assert.equal(state.savedReferences, 0)
    assert.equal(embeds, 0)
  } finally { await retrieval.dispose(); registry.dispose() }
})

test('embedding probe contract errors and caller cancellation are not disguised as unavailable engines', async () => {
  const registry = new EmbeddingRegistry()
  const controller = new AbortController()
  const cancellation = new Error('Stop capability probe')
  let cancel = false
  registry.register({ ...testEngine(), async availability() {
    if (cancel) controller.abort(cancellation)
    throw new EmbeddingError('invalid-result', 'Invalid fixture metadata')
  } })
  const { retrieval } = adapterFixture({ embeddings: registry, settings: fixtureSettings })
  try {
    await assert.rejects(retrieval.availability(sessionId, signal), { code: 'invalid-result' })
    cancel = true
    await assert.rejects(retrieval.availability(sessionId, controller.signal), error => error === cancellation)
  } finally { await retrieval.dispose(); registry.dispose() }
})

test('Host index rebuild clears shared derived records while preserving document and draft snapshots', async () => {
  const registry = new EmbeddingRegistry(), engine = testEngine(), records = new Map<string, unknown>()
  let documentEmbeds = 0
  registry.register({ ...engine, async embed(request, config) {
    if (request.purpose === 'document') documentEmbeds++
    return engine.embed(request, config)
  } })
  const cache = { get: async (key: string) => records.get(key),
    set: async (key: string, value: unknown) => { records.set(key, value) },
    clear: async () => { records.clear() } }
  const { retrieval, state } = adapterFixture({ embeddings: registry, cache, settings: fixtureSettings })
  state.snapshot = { ...state.snapshot, dirty: true, revision: 7, canUndo: true }
  const unchanged = structuredClone(state.snapshot)
  const input = { documentId: 'document', query: 'atomic', mode: 'semantic' as const }
  try {
    const before = await retrieval.search(sessionId, input, signal)
    assert.ok(records.size > 0)
    assert.equal(documentEmbeds, 1)
    await retrieval.search(sessionId, input, signal)
    assert.equal(documentEmbeds, 1, 'an ordinary warm search keeps the existing vectors')
    await retrieval.rebuild()
    assert.equal(records.size, 0)
    assert.deepEqual(state.snapshot, unchanged)
    const after = await retrieval.search(sessionId, input, signal)
    assert.notEqual(after.indexGeneration, before.indexGeneration)
    assert.equal(documentEmbeds, 2)
    assert.deepEqual(after.candidates.map(candidate => candidate.quote), before.candidates.map(candidate => candidate.quote))
    assert.deepEqual(state.snapshot, unchanged)
  } finally { await retrieval.dispose(); registry.dispose() }
})

test('failed and running index resets report unavailable capabilities until a successful retry', async () => {
  const registry = new EmbeddingRegistry()
  registry.register(testEngine())
  const cache = { get: async () => undefined, set: async () => {}, clear: async (): Promise<void> => { throw new Error('disk offline') } }
  const { retrieval } = adapterFixture({ embeddings: registry, settings: fixtureSettings, cache })
  try {
    assert.equal((await retrieval.availability(sessionId, signal)).status, 'available')
    await assert.rejects(retrieval.rebuild(), /disk offline/)
    const failed = await retrieval.availability(sessionId, signal)
    assert.equal(failed.status, 'unavailable')
    assert.match(failed.reason!, /Retry Rebuild index/)
    await assert.rejects(retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'semantic' }, signal),
      { code: 'pdf/retrieval-cache-unavailable' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    cache.clear = async () => { await gate }
    const reset = retrieval.rebuild()
    const running = await retrieval.availability(sessionId, signal)
    assert.equal(running.status, 'unavailable')
    assert.match(running.reason!, /being reset/)
    release(); await reset
    assert.equal((await retrieval.availability(sessionId, signal)).status, 'available')
  } finally { await retrieval.dispose(); registry.dispose() }
  assert.equal((await retrieval.availability(sessionId, signal)).status, 'unavailable')
})

test('availability allows one learned model identity but rejects a continuously changing model', async () => {
  for (const stable of [true, false]) {
    const registry = new EmbeddingRegistry(), engine = testEngine()
    let revision = 'unknown', probes = 0
    registry.register({ ...engine, describe(config) {
      return { ...engine.describe(config), modelRevision: revision, fingerprint: `fixture-${revision}` }
    }, async availability() {
      probes++
      revision = stable ? 'learned' : `changing-${probes}`
      return { status: 'available' }
    } })
    const { retrieval, state } = adapterFixture({ embeddings: registry, settings: fixtureSettings })
    try {
      const available = await retrieval.availability(sessionId, signal)
      assert.equal(available.status, stable ? 'available' : 'unavailable')
      assert.equal(probes, 2)
      assert.equal(state.reads, 0)
      if (available.status === 'unavailable') assert.match(available.reason, /changed repeatedly/)
    } finally { await retrieval.dispose(); registry.dispose() }
  }
})

test('configuration changes during a probe cannot be mistaken for learned service metadata', async () => {
  const registry = new EmbeddingRegistry(), engine = testEngine()
  let endpoint = 'before', started!: () => void, finish!: () => void
  const probing = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  registry.register({ ...engine, descriptor: { ...engine.descriptor,
    configurationFields: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }] },
    describe(config) { return { ...engine.describe(config), fingerprint: `fixture-${config.endpoint}` } },
    async availability() { started(); await gate; return { status: 'available' } } })
  const { retrieval } = adapterFixture({ embeddings: registry, settings: () => ({ ...fixtureSettings(),
    engineConfigurations: { embedding: { fixture: { endpoint } } } }) })
  try {
    const pending = retrieval.availability(sessionId, signal)
    await probing
    endpoint = 'after'; finish()
    const result = await pending
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason!, /engine changed during/)
  } finally { finish(); await retrieval.dispose(); registry.dispose() }
})

test('service metadata updates rebuild warm vectors before querying and survive adapter restart without a user revision', async () => {
  const records = new Map<string, unknown>()
  const cache = { get: async (key: string) => records.get(key),
    set: async (key: string, value: unknown) => { records.set(key, value) }, clear: async () => { records.clear() } }
  let revision = 'A'
  const requests: Array<{ revision: string; purpose: 'document' | 'query' }> = []
  const engine = () => createOpenAiCompatibleEmbeddingEngine({ fetch: (async (url, init) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture-embedding', embedding: {
      revision, dimensions: 2, truncation: false, maxInputCharacters: 16000,
      maxBatchSize: 8, queryEncoding: 'client-instruction',
    } }] }))
    const { input } = JSON.parse(String(init?.body)) as { input: string[] }
    requests.push({ revision, purpose: input[0]!.startsWith('Instruct:') ? 'query' : 'document' })
    return new Response(JSON.stringify({ model: 'fixture-embedding', model_revision: revision,
      data: input.map((_text, index) => ({ index, embedding: revision === 'A' ? [1, 0] : [0, 1] })) }))
  }) as typeof fetch })
  const settings = () => ({ ...defaultSettings, embeddingEngine: 'local-qwen3-embedding',
    engineConfigurations: { embedding: { 'local-qwen3-embedding': { endpoint: 'https://fixture.example/v1/embeddings',
      model: 'fixture-embedding', dimensions: 2, queryInstruction: 'Find the relevant passage' } } } })
  const start = () => {
    const registry = new EmbeddingRegistry()
    registry.register(engine())
    return { registry, ...adapterFixture({ embeddings: registry, settings, cache }) }
  }
  let runtime = start()
  const input = { documentId: 'document', query: 'atomic', mode: 'semantic' as const }
  try {
    const cold = await runtime.retrieval.search(sessionId, input, signal)
    const warm = await runtime.retrieval.search(sessionId, input, signal)
    assert.equal(warm.indexGeneration, cold.indexGeneration)
    assert.deepEqual(requests, [{ revision: 'A', purpose: 'document' }, { revision: 'A', purpose: 'query' }, { revision: 'A', purpose: 'query' }])
    revision = 'B'
    const changed = await runtime.retrieval.search(sessionId, input, signal)
    assert.notEqual(changed.indexGeneration, warm.indexGeneration)
    assert.deepEqual(requests.slice(3), [{ revision: 'B', purpose: 'document' }, { revision: 'B', purpose: 'query' }])
    await runtime.retrieval.dispose(); runtime.registry.dispose()
    runtime = start()
    await runtime.retrieval.search(sessionId, input, signal)
    assert.deepEqual(requests.slice(5), [{ revision: 'B', purpose: 'query' }], 'learning the same revision after restart must reuse persisted document vectors')
  } finally { await runtime.retrieval.dispose(); runtime.registry.dispose() }
})

test('changing the selected engine during an availability probe invalidates its answer', async () => {
  const registry = new EmbeddingRegistry()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  let selected = 'fixture'
  registry.register({ ...testEngine(), async availability() {
    started = true
    await gate
    return { status: 'available' }
  } })
  const { retrieval } = adapterFixture({ embeddings: registry,
    settings: () => ({ ...defaultSettings, embeddingEngine: selected }) })
  try {
    const pending = retrieval.availability(sessionId, signal)
    assert.equal(started, true)
    selected = 'none'
    release()
    const result = await pending
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason!, /engine changed during the availability check/)
  } finally { release(); await retrieval.dispose(); registry.dispose() }
})

test('a mismatched embedding result identity cannot produce retrieval evidence', async () => {
  const registry = new EmbeddingRegistry()
  registry.register(testEngine())
  const embed = registry.embed.bind(registry)
  registry.embed = async (...args) => {
    const result = await embed(...args)
    return { ...result, model: { ...result.model, fingerprint: 'unexpected-model' } }
  }
  const { retrieval, state } = adapterFixture({ embeddings: registry, settings: fixtureSettings })
  try {
    await assert.rejects(retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'hybrid' }, signal),
      { code: 'pdf/stale-reader' })
    assert.equal(state.savedReferences, 0)
  } finally { await retrieval.dispose(); registry.dispose() }
})

test('changed page text cannot be signed as evidence for an earlier retrieval index', async () => {
  const { retrieval, state } = adapterFixture()
  state.onRead = read => { if (read === 2) state.text = 'The extractor now reports different original text.' }
  try {
    await assert.rejects(retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'lexical' }, signal),
      { code: 'pdf/stale-reader', message: 'Indexed PDF text changed; rebuild the search' })
    assert.equal(state.reads, 2, 'candidates must be checked against re-read page text')
    assert.equal(state.savedReferences, 0)
  } finally { await retrieval.dispose() }
})

test('a provider callback cannot change the working copy between result validation and evidence capture', async () => {
  const registry = new EmbeddingRegistry()
  const engine = testEngine()
  let invalidate: (() => void) | undefined
  registry.register({ ...engine, describe(config) {
    invalidate?.()
    return engine.describe(config)
  } })
  const { retrieval, state } = adapterFixture({ embeddings: registry, settings: fixtureSettings })
  state.onRead = read => {
    if (read === 2) invalidate = () => {
      invalidate = undefined
      state.snapshot = { ...state.snapshot, contentVersion: 'changed-during-provider-callback' }
    }
  }
  try {
    await assert.rejects(retrieval.search(sessionId, { documentId: 'document', query: 'atomic', mode: 'hybrid' }, signal),
      { code: 'pdf/stale-reader', message: 'PDF changed while resolving retrieval results' })
    assert.equal(state.savedReferences, 0)
  } finally { await retrieval.dispose(); registry.dispose() }
})

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
    const input = { documentId: opened.documentId, query: 'all-or-nothing rollback', topK: 2 }
    const related = await run('pdf_semantic_search', input) as {
      status: string; effectiveMode: string; revision: number; coverage: { visual: string; totalPages: number }
      candidates: { page: number; quote: string; evidence: PdfTextEvidence }[]
    }
    assert.equal(related.status, 'complete')
    assert.equal(related.effectiveMode, 'semantic')
    assert.equal(related.coverage.totalPages, 3)
    assert.equal(related.coverage.visual, 'not-indexed')
    assert.equal(related.candidates[0]!.page, 2)
    const hit = related.candidates[0]!
    assert.equal(hit.evidence.snapshot.text, hit.quote)
    const changed = await run('pdf_annotation_create', { documentId: opened.documentId,
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
    const jump = run('pdf_page_jump', { documentId: ui.id, refId: hit.evidence.refId })
    const request = await pending as AgentNavigationRequest
    assert.equal(request.page, 2)
    assert.ok(request.target?.quadPoints.length)
    await navigation.dispatch(sessionId, { action: 'complete', ...lease, requestId: request.requestId,
      status: 'opened', targetRevision: request.target!.revision, sourceDigest: request.target!.sourceDigest }, signal)
    assert.equal((await jump as { status: string }).status, 'opened')
    await assert.rejects(run('pdf_semantic_search', input, { session: { id: 'foreign', header: {} } }))
    remove()
    const unloaded = await run('pdf_status', { documentId: opened.documentId }) as { capabilities: { semanticSearch: boolean } }
    assert.equal(unloaded.capabilities.semanticSearch, false)
    await assert.rejects(run('pdf_semantic_search', input), { code: 'pdf/semantic-unavailable' })
    await assert.rejects(run('pdf_semantic_search', { ...input, mode: 'auto' }), /unrecognized|invalid/i)
  } finally {
    await dispose(); navigation.dispose(); contexts.dispose(); registry.dispose()
    await pdf.dispose(); await state.workspaces.dispose()
  }
})
