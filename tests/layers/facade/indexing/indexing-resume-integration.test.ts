import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { createDocumentIndexes } from '../../../../src/layers/facade/indexing/document-indexes.ts'
import { createPdfIndexing } from '../../../../src/layers/facade/indexing/indexing.ts'
import { createPdfPageContent } from '../../../../src/layers/facade/search/retrieval/page-content.ts'
import { createPdfRetrieval } from '../../../../src/layers/facade/search/host-retrieval.ts'
import { createRetrievalPrefetch } from '../../../../src/layers/facade/indexing/retrieval-prefetch.ts'
import { createRetrievalStore } from '../../../../src/layers/derived/storage/retrieval-store.ts'
import { EmbeddingRegistry } from '../../../../src/engines/embedding/sdk/index.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../../../../src/layers/facade/evidence/index.ts'
import { HostImageUnderstandingService } from '../../../../src/engines/image/service/index.ts'
import { HostOcrService } from '../../../../src/engines/ocr/service/index.ts'
import { createDocumentIndexPolicies, settingsForRetrievalBinding, type ResolvedRetrievalBinding } from '../../../../src/layers/facade/indexing/document-policy.ts'
import type { HostWorkspaceSnapshot, OpenWorkingCopyDocument } from '../../../../src/layers/document/working-copy/index.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'
import { defaultSettings, type PdfSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const pageText = (page: number) => page === 1 ? 'Native chapter explains reliable document search.' : `Recognized scanned paragraph on page ${page}.`

function pause() {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  return { started, entered, async wait(active: AbortSignal) {
    entered()
    await new Promise<void>(resolve => {
      active.addEventListener('abort', () => resolve(), { once: true })
      if (active.aborted) resolve()
    })
    active.throwIfAborted()
  } }
}

async function fixture(t: TestContext, options: { scan?: boolean; failOcr?: number[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-host-index-resume-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settings: PdfSettings = { ...defaultSettings, embeddingEngine: 'test-embedding', ocrEngine: 'test-ocr',
    imageEngine: 'test-image', indexScanPages: options.scan ?? true, indexImageDescriptions: false }
  const state = { native: [] as number[], ocr: [] as number[], image: [] as number[], embeddings: [] as string[],
    attemptedEmbeddings: [] as string[], plans: [] as ResolvedRetrievalBinding[],
    preparations: [] as { plan: ResolvedRetrievalBinding; input: { documentId: string; rebuild?: boolean; rebuildToken?: string } }[],
    embedPause: undefined as ReturnType<typeof pause> | undefined, failEmbedding: false,
    failOcr: new Set(options.failOcr), pins: 0 }
  const bytes = new Uint8Array([1, 2, 3])
  const documents: OpenWorkingCopyDocument[] = [{ sessionId: 'a', id: 'doc-a', title: 'Resume.pdf',
    path: '/synthetic/resume.pdf', contentVersion: 'content-v1', sourceDigest: evidenceSha256(bytes), conflict: false }]
  const snapshot = (sessionId: string, id: string): HostWorkspaceSnapshot => {
    if (!documents.some(document => document.sessionId === sessionId && document.id === id)) {
      throw Object.assign(new Error('PDF access denied'), { code: 'pdf/access-denied' })
    }
    return { id, path: documents[0]!.path!, bytes, sourceVersion: 'source-v1', contentVersion: 'content-v1',
      revision: 0, dirty: false, conflict: false, canUndo: false, canRedo: false,
      document: { pageCount: 3, signed: false, encrypted: false, readOnly: false, annotations: [],
        pages: [1, 2, 3].map(page => ({ page, cropBox: [0, 0, 200, 300], rotation: 0, userUnit: 1 })) } }
  }
  const workspaces = { readSnapshot: snapshot }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText(sessionId, id, page, active) {
      active.throwIfAborted(); state.native.push(page)
      const text = page === 1 ? pageText(page) : ''
      const content: NativeTextContent = { items: text ? [{ str: text, transform: [10, 0, 0, 10, 10, 200],
        width: 180, height: 10, dir: 'ltr', fontName: 'fixture', hasEOL: false }] : [], styles: {}, lang: null }
      return { snapshot: snapshot(sessionId, id), content }
    },
    async renderOcrImage(sessionId, id, page, _region, _edge, active) {
      active.throwIfAborted()
      const png = Buffer.alloc(25)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12)
      png.writeUInt32BE(200, 16); png.writeUInt32BE(300, 20); png[24] = page
      return { snapshot: snapshot(sessionId, id), png, width: 200, height: 300, pdfRegion: [0, 0, 200, 300] }
    },
  }
  const ocr = new HostOcrService(() => 'test-ocr')
  ocr.register({ descriptor: { id: 'test-ocr', name: 'Test OCR', version: '1', execution: 'local',
    capabilities: ['ocr-text'], geometry: [], confidence: false },
    async cacheIdentity() { return 'stable-ocr' }, async availability() { return { status: 'available' } },
    async recognize(request) {
      request.signal?.throwIfAborted()
      const page = (request.image as Uint8Array)[24]!
      state.ocr.push(page)
      if (state.failOcr.has(page)) throw new Error('Simulated OCR failure')
      return { text: pageText(page), status: 'complete', blocks: [], lines: [], words: [],
        confidence: null, coverage: [], warnings: [] }
    } })
  const image = new HostImageUnderstandingService(() => 'test-image')
  image.register({ descriptor: { id: 'test-image', name: 'Test image', version: '1', execution: 'local' },
    async cacheIdentity() { return 'stable-image' }, async availability() { return { available: true } },
    async understand(request) {
      request.signal.throwIfAborted()
      const page = request.image.data[24]!
      state.image.push(page)
      return { text: `Image description for page ${page}: a distinct diagram.`, model: 'test-vision' }
    } })
  const embeddings = new EmbeddingRegistry()
  embeddings.register({ descriptor: { id: 'test-embedding', name: 'Test embedding', version: '1', execution: 'local' },
    describe: () => ({ engineId: 'test-embedding', engineVersion: '1', model: 'test', modelRevision: '1', dimensions: 2,
      maxBatchSize: 1, maxInputCharacters: 1200, encoding: 'test', fingerprint: 'stable-embedding' }),
    async availability() { return { status: 'available' } }, async embed(request) {
      request.signal.throwIfAborted()
      if (request.purpose === 'document') {
        state.attemptedEmbeddings.push(...request.texts)
        if (request.texts.includes(pageText(3))) {
          if (state.failEmbedding) { state.failEmbedding = false; throw new Error('Simulated embedding disconnect') }
          if (state.embedPause) {
            const pending = state.embedPause; state.embedPause = undefined
            await pending.wait(request.signal)
          }
        }
        request.signal.throwIfAborted()
        state.embeddings.push(...request.texts)
      }
      return request.texts.map(() => [1, 0])
    } })

  function openHost() {
    const store = createRetrievalStore({ directory: join(directory, 'index'), maxMemoryBytes: 0 })
    const policyDb = new DatabaseSync(join(directory, 'policies.sqlite'))
    policyDb.exec('CREATE TABLE IF NOT EXISTS policies (path TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const policies = createDocumentIndexPolicies({ key: path => path,
      get: key => {
        const row = policyDb.prepare('SELECT value FROM policies WHERE path=?').get(key)
        return row ? JSON.parse(String(row.value)) : undefined
      }, async put(key, value) {
        policyDb.prepare('INSERT OR REPLACE INTO policies(path,value) VALUES(?,?)').run(key, JSON.stringify(value))
      } }, () => settings)
    const indexes = createDocumentIndexes({ policies, documents: () => documents, async clearCache() { await store.clear() },
      create(plan) {
        state.plans.push(structuredClone(plan))
        const boundSettings = settingsForRetrievalBinding(plan, settings)
        const content = createPdfPageContent(workspaces, pages, { settings: () => boundSettings, ocr: () => ocr, image: () => image, cache: store })
        const retrieval = createPdfRetrieval(workspaces, pages, createMemoryEvidenceReferenceStore(), {
          cache: store, embeddings, settings: () => boundSettings, content,
          limits: { pagesPerStep: 1, embeddingBatchesPerStep: 1 },
          async freshSource(sessionId, id, active) { active.throwIfAborted(); snapshot(sessionId, id) },
          async retain(sessionId, id, active) {
            active.throwIfAborted(); snapshot(sessionId, id); state.pins++
            return () => { state.pins-- }
          },
        })
        return { ...retrieval, prepareSlice(sessionId, input, active, progress, occurrence) {
          state.preparations.push({ plan: structuredClone(plan), input: { ...input } })
          return retrieval.prepareSlice!(sessionId, input, active, progress, occurrence)
        }, async dispose() { await retrieval.dispose(); content.dispose() } }
      } })
    const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: document => indexes.selection(document),
      prepare: (...args) => indexes.prepare(...args), prepareSlice: (...args) => indexes.prepareSlice(...args),
      subscribe: listener => indexes.subscribe(listener) })
    const indexing = createPdfIndexing(prefetch, { documents: () => documents, enabled: () => policies.enabled(), indexes })
    return { store, policies, indexes, prefetch, indexing, async dispose() {
      indexing.dispose(); await prefetch.dispose(); await indexes.dispose(); await store.dispose(); policyDb.close()
    } }
  }
  let host = openHost()
  const dispatch = (action: 'start' | 'resume' | 'rebuild' | 'cancel') =>
    host.indexing.dispatch('a', { action, sessionId: 'a', documentId: 'doc-a' }, signal)
  async function configure(scan: boolean, describe: boolean) {
    const current = host.indexes.settings('a', 'doc-a')
    await host.indexing.dispatch('a', { action: 'configure', sessionId: 'a', documentId: 'doc-a',
      revision: current.revision, policy: { indexScanPages: scan, indexImageDescriptions: describe } }, signal)
  }
  const task = () => host.indexing.snapshot('a').tasks[0]
  async function waitFor(predicate: () => boolean, description: string) {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`${description}: ${JSON.stringify(host.prefetch.status())}`)
      await turn()
    }
  }
  return { state, documents, settings, get host() { return host }, dispatch, configure, task, waitFor,
    async restart() { await host.dispose(); host = openHost() },
    async dispose() { await host.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose() } }
}

function assertNoRepeatedCompletedWork(state: Awaited<ReturnType<typeof fixture>>['state']) {
  assert.deepEqual([...state.native].sort(), [1, 2, 3], 'native page layers are durable across plan changes and restart')
  assert.deepEqual([...state.ocr].sort(), [2, 3], 'completed OCR is never repeated')
  for (const page of [1, 2, 3]) assert.equal(state.embeddings.filter(text => text === pageText(page)).length, 1,
    `the completed vector for page ${page} is reused across old/new plans and restart`)
}

test('one retry visits later failed OCR pages across scheduler slices and retains successful work', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { failOcr: [2, 3] })
  try {
    await f.waitFor(() => f.task()?.state === 'failed', 'initial indexing did not report incomplete OCR')
    assert.equal(f.task()!.progress!.indexedPages, 1, 'empty scanned pages have no usable content until OCR succeeds')
    assert.equal(f.task()!.progress!.failedPages, 2)

    const first = f.task()!.occurrence
    const previousCalls = f.state.ocr.length
    f.state.failOcr.delete(3)
    await f.dispatch('resume')
    await f.waitFor(() => f.task()?.state === 'failed' && f.task()!.occurrence !== first,
      'retry did not finish the failed-page pass')
    assert.deepEqual(f.state.ocr.slice(previousCalls), [2, 3])
    assert.equal(f.task()!.progress!.failedPages, 1)
    assert.deepEqual(f.state.embeddings, [pageText(1), pageText(3)])

    f.state.failOcr.delete(2)
    await f.dispatch('resume')
    await f.waitFor(() => f.task()?.state === 'ready', 'second retry did not finish indexing')
    assert.deepEqual(f.state.ocr.slice(previousCalls), [2, 3, 2])
    assert.equal(f.task()!.progress!.failedPages, undefined)
    assert.deepEqual([...f.state.native].sort(), [1, 2, 3])
    assert.deepEqual(f.state.embeddings, [pageText(1), pageText(3), pageText(2)])
  } finally { await f.dispose() }
})

test('resume authorization rejects another Session before touching the real task, checkpoint or models', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const pending = pause(); f.state.embedPause = pending
  try {
    await pending.started
    await f.dispatch('cancel')
    await f.waitFor(() => f.host.prefetch.status().state === 'idle', 'cancel did not drain')
    const before = f.host.indexing.snapshot('a'), plan = f.host.indexes.selection(f.documents[0]!)
    const calls = { ocr: [...f.state.ocr], images: [...f.state.image], embedding: [...f.state.attemptedEmbeddings] }
    await assert.rejects(f.host.indexing.dispatch('b', { action: 'resume', sessionId: 'a', documentId: 'doc-a' }, signal), { code: 'pdf/session-mismatch' })
    await assert.rejects(f.host.indexing.dispatch('b', { action: 'resume', sessionId: 'b', documentId: 'doc-a' }, signal), { code: 'pdf/unknown-document' })
    assert.deepEqual(f.host.indexing.snapshot('a'), before)
    assert.deepEqual(f.host.indexing.snapshot('b').tasks, [])
    assert.deepEqual(f.host.indexes.selection(f.documents[0]!), plan)
    assert.deepEqual({ ocr: f.state.ocr, images: f.state.image, embedding: f.state.attemptedEmbeddings }, calls)
    await f.dispatch('resume')
    await f.waitFor(() => f.task()?.state === 'ready', 'the authorized caller could not resume its task')
    assertNoRepeatedCompletedWork(f.state)
  } finally { await f.dispose() }
})
