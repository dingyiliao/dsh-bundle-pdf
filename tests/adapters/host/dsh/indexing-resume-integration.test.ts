import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { createDocumentIndexes } from '../../../../src/adapters/host/dsh/document-indexes.ts'
import { createPdfIndexing } from '../../../../src/adapters/host/dsh/indexing.ts'
import { createPdfPageContent } from '../../../../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { createRetrievalPrefetch } from '../../../../src/adapters/host/dsh/retrieval-prefetch.ts'
import { createRetrievalStore } from '../../../../src/adapters/host/filesystem/retrieval-store.ts'
import { EmbeddingRegistry } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../../../../src/modules/evidence/index.ts'
import { HostImageUnderstandingService } from '../../../../src/modules/image-understanding/index.ts'
import { HostOcrService } from '../../../../src/modules/ocr/index.ts'
import { createDocumentIndexPolicies, settingsForIndexPlan, type ResolvedIndexPlan } from '../../../../src/modules/retrieval/document-policy.ts'
import type { HostWorkspaceSnapshot, OpenWorkingCopyDocument } from '../../../../src/modules/working-copy/index.ts'
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
    attemptedEmbeddings: [] as string[], plans: [] as ResolvedIndexPlan[],
    preparations: [] as { plan: ResolvedIndexPlan; input: { documentId: string; rebuild?: boolean; rebuildToken?: string } }[],
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
        const boundSettings = settingsForIndexPlan(plan, settings)
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

test('real Host resume preserves an OCR-only plan after desired changes, then explicit start adds images using durable layers and vectors', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const pending = pause(); f.state.embedPause = pending
  try {
    await pending.started
    const interruptedPlan = f.host.indexes.selection(f.documents[0]!)!
    assert.deepEqual(f.state.ocr, [2, 3])
    assert.deepEqual(f.state.embeddings, [pageText(1), pageText(2)])
    await f.configure(true, true)
    assert.deepEqual(f.host.indexes.selection(f.documents[0]!), interruptedPlan, 'editing desired settings leaves the running plan intact')
    await f.dispatch('cancel')
    await f.waitFor(() => f.host.prefetch.status().state === 'idle', 'cancel did not drain its embedding call')
    const checkpoint = f.task()!.progress!
    assert.ok(checkpoint.indexedPages >= 2 && checkpoint.embeddedChunks >= 2)
    const resumed = await f.dispatch('resume')
    assert.ok(resumed.tasks[0]!.progress!.indexedPages >= checkpoint.indexedPages, 'resuming keeps the known checkpoint visible')
    await f.waitFor(() => f.task()?.state === 'ready', 'old OCR-only plan did not finish')
    assert.deepEqual(f.state.image, [])
    assert.equal(f.host.indexes.settings('a', 'doc-a').pending, true)
    assertNoRepeatedCompletedWork(f.state)
    assert.ok(f.host.store.diagnostics().diskWrites > 0)
    const completed = [...f.state.embeddings]

    await f.restart()
    await f.waitFor(() => f.task()?.state === 'ready', 'SQLite checkpoint did not restore after complete Host restart')
    assert.ok(f.host.store.diagnostics().diskReads > 0, 'the replacement Host really opens persisted records')
    assert.deepEqual(f.state.embeddings, completed)
    assert.deepEqual(f.state.image, [])
    assertNoRepeatedCompletedWork(f.state)

    await f.dispatch('start')
    await f.waitFor(() => f.task()?.state === 'ready' && !f.host.indexes.settings('a', 'doc-a').pending, 'explicit update did not activate image descriptions')
    assert.deepEqual(f.state.image, [1, 2, 3])
    assertNoRepeatedCompletedWork(f.state)
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

test('an incomplete SQLite checkpoint survives complete Host shutdown and resumes without repeating successful OCR or vectors', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const firstPause = pause(); f.state.embedPause = firstPause
  try {
    await firstPause.started
    await f.configure(true, true)
    await f.dispatch('cancel')
    await f.waitFor(() => f.host.prefetch.status().state === 'idle', 'the first task did not finish cancellation')
    let savedPages = 0, cursor: string | undefined
    do {
      const batch = await f.host.store.scan('index_page_', cursor)
      savedPages += batch.entries.length; cursor = batch.nextKey
    } while (cursor)
    assert.ok(savedPages >= 3, 'every extracted page has a real durable checkpoint')
    assert.deepEqual(f.state.embeddings, [pageText(1), pageText(2)])
    assert.deepEqual(f.state.ocr, [2, 3])

    const restoredPause = pause(); f.state.embedPause = restoredPause
    await f.restart()
    await restoredPause.started
    assert.ok(f.host.store.diagnostics().diskReads > 0)
    assert.deepEqual(f.state.embeddings, [pageText(1), pageText(2)], 'successful vectors are read from disk before reaching the interrupted batch')
    assert.deepEqual(f.state.ocr, [2, 3], 'accepted OCR layers survive the entire Host/runtime/store lifetime')
    assert.deepEqual(f.state.native, [1, 2, 3])
    assert.deepEqual(f.state.image, [], 'reopening does not silently apply edited desired settings')
    await f.dispatch('cancel')
    await f.waitFor(() => f.host.prefetch.status().state === 'idle', 'the restored task did not finish cancellation')
    await f.dispatch('resume')
    await f.waitFor(() => f.task()?.state === 'ready', 'the restored checkpoint did not complete')
    assertNoRepeatedCompletedWork(f.state)
    assert.equal(f.host.indexes.settings('a', 'doc-a').pending, true)
    assert.deepEqual(f.state.image, [])
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

for (const interrupted of ['cancelled', 'failed'] as const) {
  test(`a partial forced candidate retains its rebuild token and old plan when ${interrupted}, even after desired is edited`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { scan: false })
    try {
      await f.waitFor(() => f.task()?.state === 'ready', 'initial native-only plan did not finish')
      await f.configure(true, false)
      const pending = pause()
      if (interrupted === 'cancelled') f.state.embedPause = pending
      else f.state.failEmbedding = true
      await f.dispatch('rebuild')
      if (interrupted === 'cancelled') await pending.started
      else await f.waitFor(() => f.task()?.state === 'failed', 'the embedding fault was not visible')
      const candidate = f.host.indexes.selection(f.documents[0]!)!
      const oldPlans = f.state.preparations.filter(value => value.plan.policy.indexScanPages && !value.plan.policy.indexImageDescriptions)
      assert.ok(oldPlans.length > 0)
      assert.ok(oldPlans.every(value => value.input.rebuild && value.input.rebuildToken === candidate.planId))
      await f.configure(true, true)
      if (interrupted === 'cancelled') await f.dispatch('cancel')
      await f.waitFor(() => f.host.prefetch.status().state === 'idle', 'the interrupted candidate did not drain')
      assert.deepEqual(f.host.indexes.selection(f.documents[0]!), candidate, 'desired edits do not silently stage a replacement')
      const previousOccurrence = f.task()!.occurrence
      await f.dispatch('resume')
      await f.waitFor(() => f.task()?.state === 'ready', 'the interrupted candidate did not finish under its original plan')
      assert.ok(f.task()!.occurrence > previousOccurrence)
      assert.deepEqual(f.state.image, [])
      const resumedPlans = f.state.preparations.filter(value => value.plan.policy.indexScanPages && !value.plan.policy.indexImageDescriptions)
      assert.ok(resumedPlans.length > oldPlans.length)
      assert.ok(resumedPlans.every(value => value.input.rebuildToken === candidate.planId), 'resume never generates a replacement force token')
      const settings = f.host.indexes.settings('a', 'doc-a')
      assert.equal(settings.pending, true)
      assert.deepEqual(settings.activePolicy, { indexScanPages: true, indexImageDescriptions: false })
      assertNoRepeatedCompletedWork(f.state)

      await f.dispatch('start')
      await f.waitFor(() => f.task()?.state === 'ready' && !f.host.indexes.settings('a', 'doc-a').pending, 'explicit start did not apply the newer desired plan')
      assert.deepEqual(f.state.image, [1, 2, 3])
      assertNoRepeatedCompletedWork(f.state)
    } finally { await f.dispose() }
  })
}

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
