import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'
import { createDocumentIndexes } from '../../../../src/adapters/host/dsh/document-indexes.ts'
import { createDocumentIndexPolicies, type ResolvedIndexPlan } from '../../../../src/modules/retrieval/document-policy.ts'
import type { PdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import type { OpenWorkingCopyDocument } from '../../../../src/modules/working-copy/index.ts'
import type { PdfDocumentIndexPolicy } from '../../../../src/contracts/indexing.ts'
import type { RetrievalProgress } from '../../../../src/modules/retrieval/index.ts'
import { defaultSettings, type PdfSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
interface Call { kind: string; runtime: number; sessionId?: string; documentId?: string; rebuild?: boolean; fromPage?: number; maxPages?: number }
interface Runtime {
  id: number; plan: ResolvedIndexPlan; closed: boolean; cancelled: string[]
  lifetime: AbortController; pending: Set<Promise<unknown>>
}
function fixture(maxRuntimes?: number) {
  const records = new Map<string, unknown>()
  let defaults: PdfSettings = { ...defaultSettings, embeddingEngine: 'embed-a', ocrEngine: 'ocr-a', imageEngine: 'image-a',
    indexScanPages: true, indexImageDescriptions: false,
    engineConfigurations: { embedding: { 'embed-a': { model: 'alpha' }, 'embed-b': { model: 'beta' }, 'embed-c': { model: 'gamma' } } } }
  const policies = createDocumentIndexPolicies({ key: path => posix.normalize(path), get: key => structuredClone(records.get(key)),
    async put(key, value) { await state.onPut?.(); records.set(key, structuredClone(value)) } }, () => defaults)
  const documents: OpenWorkingCopyDocument[] = [
    { sessionId: 'a', id: 'doc-a', path: '/book.pdf', contentVersion: 'v1', sourceDigest: 'source-v1', conflict: false },
    { sessionId: 'b', id: 'doc-b', path: '/book.pdf', contentVersion: 'other-session-id', sourceDigest: 'source-v1', conflict: false },
    { sessionId: 'a', id: 'other', path: '/other.pdf', contentVersion: 'v1', sourceDigest: 'other-source', conflict: false },
  ]
  const runtimes: Runtime[] = [], calls: Call[] = []
  const state = { clears: 0, createError: undefined as Error | undefined,
    onPrepare: undefined as ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<void>) | undefined,
    onSearch: undefined as ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<void>) | undefined,
    onAvailability: undefined as ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<void>) | undefined,
    onDispose: undefined as ((runtime: Runtime) => Promise<void>) | undefined,
    onClear: undefined as (() => Promise<void>) | undefined,
    onPut: undefined as (() => Promise<void>) | undefined }
  function create(plan: ResolvedIndexPlan): PdfRetrieval {
    if (state.createError) throw state.createError
    const runtime: Runtime = { id: runtimes.length + 1, plan, closed: false, cancelled: [], lifetime: new AbortController(), pending: new Set() }
    runtimes.push(runtime)
    const run = async (call: Call, caller: AbortSignal,
      hook: ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<void>) | undefined) => {
      const active = AbortSignal.any([caller, runtime.lifetime.signal])
      active.throwIfAborted(); calls.push(call)
      const work = Promise.resolve().then(async () => { await hook?.(runtime, call, active); active.throwIfAborted() })
      runtime.pending.add(work)
      try { await work } finally { runtime.pending.delete(work) }
    }
    return {
      async availability(sessionId, active) {
        await run({ kind: 'availability', runtime: runtime.id, sessionId }, active, state.onAvailability)
        return plan.policy.embeddingEngine === 'none' ? { status: 'unavailable', reason: 'Disabled' } : { status: 'available' }
      },
      async prepare(sessionId, input, active, progress) {
        await run({ kind: 'prepare', runtime: runtime.id, sessionId, ...input }, active, state.onPrepare)
        progress?.({ indexedPages: 1, totalPages: 1, embeddedChunks: 1, totalChunks: 1, phase: 'ready', reusedChunks: 0, computedChunks: 1 })
      },
      async search(sessionId, input, active) {
        await run({ kind: 'search', runtime: runtime.id, sessionId, documentId: input.documentId }, active, state.onSearch)
        const owner = documents.find(doc => doc.sessionId === sessionId && doc.id === input.documentId)!
        return { status: 'complete', requestedMode: 'semantic', effectiveMode: 'semantic', indexGeneration: `runtime-${runtime.id}`,
          scope: { fromPage: 1, toPage: 1 }, documentId: input.documentId, path: owner.path!, sourceDigest: owner.sourceDigest,
          contentVersion: owner.contentVersion, sourceVersion: 'source-file-version', revision: 0,
          coverage: { indexedPages: 1, totalPages: 1, noTextPages: [], ocrPages: [], imageDescriptionPages: [], failedPages: [],
            qualityWarnings: [], embeddedChunks: 1, totalChunks: 1, visual: 'not-indexed' }, candidates: [], limitations: [] }
      },
      cancelSession(sessionId) { runtime.cancelled.push(sessionId) },
      async rebuild() { throw new Error('A document operation must not call the global runtime reset') },
      async dispose() {
        runtime.closed = true; runtime.lifetime.abort(new Error('Runtime closed'))
        await Promise.allSettled([...runtime.pending]); await state.onDispose?.(runtime)
      },
    }
  }
  const api = createDocumentIndexes({ documents: () => documents, policies, create,
    async clearCache() { state.clears++; await state.onClear?.() }, ...(maxRuntimes === undefined ? {} : { maxRuntimes }) })
  const configure = async (engine: string, documentId = 'doc-a') => {
    const current = api.settings('a', documentId)
    defaults = { ...defaults, embeddingEngine: engine }
    api.refresh()
    const policy = current.policy
    await api.configure('a', documentId, current.revision, policy)
    return policy
  }
  const search = (sessionId = 'a', documentId = 'doc-a') => api.search(sessionId, { documentId, query: 'synthetic question', mode: 'semantic' }, signal)
  return { api, policies, records, documents, runtimes, calls, state, configure, search,
    updateDefaults(change: Partial<PdfSettings>) { defaults = { ...defaults, ...change } },
    policy: (): PdfDocumentIndexPolicy => ({ indexScanPages: true, indexImageDescriptions: false }) }
}

test('queries retain the ready plan until a full candidate succeeds, then all views of that resource see the new plan', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    const first = await f.search()
    await f.search('a', 'other')
    await f.configure('embed-b')
    assert.equal(f.runtimes.length, 1, 'saving preferences alone neither allocates a replacement nor invokes a model')
    assert.equal(f.api.settings('a', 'doc-a').pending, true)
    await f.api.stage('a', 'doc-a')
    const queued = f.api.selection(f.documents[0]!)!
    f.state.onPrepare = async runtime => { assert.equal(runtime.plan.policy.embeddingEngine, 'embed-b'); entered.resolve(); await gate.promise }
    const updating = f.api.prepare('a', { documentId: 'doc-a', indexPlanId: queued.planId }, signal)
    await entered.promise
    assert.equal((await f.search()).indexGeneration, first.indexGeneration)
    assert.equal((await f.search('b', 'doc-b')).indexGeneration, first.indexGeneration)
    gate.resolve(); await updating
    const updated = await f.search()
    assert.notEqual(updated.indexGeneration, first.indexGeneration)
    assert.equal(f.runtimes[1]!.plan.policy.embeddingEngine, 'embed-b')
    assert.equal(f.policies.active('/book.pdf').policy.embeddingEngine, 'embed-b')
    assert.equal(f.api.settings('a', 'doc-a').pending, false)
    assert.equal((await f.search('a', 'other')).indexGeneration, first.indexGeneration,
      'another file keeps its own settings and may share the identical immutable runtime')
  } finally { gate.resolve(); await f.api.dispose() }
})

test('per-file content flags survive saves and later engine selection always comes from global settings', async () => {
  const f = fixture()
  try {
    const first = f.api.settings('a', 'doc-a')
    await f.api.configure('a', 'doc-a', first.revision, { ...first.policy, indexImageDescriptions: true })
    f.documents[0]!.sourceDigest = 'saved-new-source'; f.documents[0]!.contentVersion = 'new-working-set'
    f.updateDefaults({ embeddingEngine: 'embed-c', ocrEngine: 'ocr-new', imageEngine: 'image-new', indexScanPages: false })
    assert.deepEqual(f.api.settings('b', 'doc-b').policy, { indexScanPages: true, indexImageDescriptions: true })
    assert.equal(f.policies.desired('/book.pdf').policy.embeddingEngine, 'embed-c')
    assert.equal(f.policies.desired('/book.pdf').policy.ocrEngine, 'ocr-new')
    assert.equal(f.policies.desired('/book.pdf').policy.imageEngine, 'image-new')
    assert.equal(f.api.settings('a', 'other').policy.indexScanPages, false)
    const snapshot = f.api.settings('a', 'doc-a')
    await f.api.configure('a', 'doc-a', snapshot.revision)
    assert.equal(f.api.settings('a', 'doc-a').policy.indexScanPages, false, 'only adopting content defaults is explicit')
    assert.equal(f.policies.active('/book.pdf').policy.embeddingEngine, 'embed-a')
    assert.equal(f.runtimes.length, 0, 'neither global nor document preferences allocate a replacement')
  } finally { await f.api.dispose() }
})

test('unowned documents cannot inspect settings, stage builds, allocate runtimes or start queries', async () => {
  const f = fixture()
  try {
    assert.throws(() => f.api.settings('a', 'doc-b'), { code: 'pdf/unknown-document' })
    await assert.rejects(f.api.configure('a', 'doc-b', 0, f.policy()), { code: 'pdf/unknown-document' })
    await assert.rejects(f.api.stage('a', 'doc-b'), { code: 'pdf/unknown-document' })
    await assert.rejects(f.api.prepare('a', { documentId: 'doc-b' }, signal), { code: 'pdf/unknown-document' })
    await assert.rejects(f.search('a', 'doc-b'), { code: 'pdf/unknown-document' })
    await assert.rejects(f.api.availability('a', signal, 'doc-b'), { code: 'pdf/unknown-document' })
    assert.equal(f.runtimes.length, 0); assert.equal(f.records.size, 0)
    assert.equal(f.api.selection({ ...f.documents[0]!, path: undefined }), undefined)
    assert.equal((await f.api.availability('a', signal)).status, 'unavailable')
    const abort = new AbortController(); abort.abort(new Error('caller left'))
    await assert.rejects(f.api.availability('a', abort.signal), /caller left/)
  } finally { await f.api.dispose() }
})

test('a failed candidate and a cancelled candidate leave the accepted active plan available for retry', async () => {
  const f = fixture()
  try {
    const original = await f.search()
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    f.state.onPrepare = async () => { throw new Error('candidate model is offline') }
    await assert.rejects(f.api.prepare('a', { documentId: 'doc-a' }, signal), /offline/)
    assert.equal((await f.search()).indexGeneration, original.indexGeneration)
    assert.equal(f.api.settings('a', 'doc-a').pending, true)
    const entered = deferred(), gate = deferred(), caller = new AbortController()
    f.state.onPrepare = async () => { entered.resolve(); await gate.promise }
    const pending = f.api.prepare('a', { documentId: 'doc-a' }, caller.signal)
    const rejected = assert.rejects(pending, /cancel candidate/)
    await entered.promise; caller.abort(new Error('cancel candidate')); gate.resolve(); await rejected
    assert.equal((await f.search()).indexGeneration, original.indexGeneration)
    f.state.onPrepare = undefined
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    assert.equal(f.api.settings('a', 'doc-a').pending, false)
  } finally { await f.api.dispose() }
})

test('a queued or superseded candidate cannot promote an obsolete policy and partial candidates cannot activate', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    const previous = f.api.selection(f.documents[0]!)!
    await assert.rejects(f.api.prepare('a', { documentId: 'doc-a', indexPlanId: 'outdated' }, signal), { code: 'pdf/stale-reader' })
    for (const bounds of [{ fromPage: 2 }, { maxPages: 1 }]) {
      await assert.rejects(f.api.prepare('a', { documentId: 'doc-a', ...bounds }, signal), { code: 'pdf/invalid-request' })
    }
    f.state.onPrepare = async () => { entered.resolve(); await gate.promise }
    const pending = f.api.prepare('a', { documentId: 'doc-a', indexPlanId: previous.planId }, signal)
    const rejected = assert.rejects(pending, { code: 'pdf/stale-reader' })
    await entered.promise; await f.configure('embed-c'); await f.api.stage('a', 'doc-a')
    gate.resolve(); await rejected
    assert.equal(f.policies.active('/book.pdf').policy.embeddingEngine, 'embed-a')
    assert.equal(f.policies.desired('/book.pdf').policy.embeddingEngine, 'embed-c')
  } finally { gate.resolve(); await f.api.dispose() }
})

test('a search crossing successful plan promotion is rejected rather than returning evidence from the retired plan', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    await f.search()
    f.state.onSearch = async runtime => { if (runtime.plan.policy.embeddingEngine === 'embed-a') { entered.resolve(); await gate.promise } }
    const pending = f.search(), rejected = assert.rejects(pending, { code: 'pdf/stale-reader' })
    await entered.promise; await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    gate.resolve(); await rejected
  } finally { gate.resolve(); await f.api.dispose() }
})

test('global disable gates every operation while preserving the ready forced runtime and its durable plan', async () => {
  const f = fixture()
  try {
    await f.search(); await f.api.stage('a', 'doc-a', true)
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    const forced = await f.search(), selection = f.api.selection(f.documents[0]!)!
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    await f.configure('none')
    const disabled = f.api.settings('a', 'doc-a')
    assert.equal(disabled.enabled, false); assert.equal(disabled.activeEnabled, false)
    assert.equal(f.api.selection(f.documents[0]!), undefined)
    assert.equal(f.policies.active('/book.pdf').policy.embeddingEngine, 'none')
    assert.equal((f.records.get('/book.pdf') as { active: ResolvedIndexPlan }).active.policy.embeddingEngine, 'embed-a')
    await f.api.stage('a', 'doc-a')
    assert.deepEqual(await f.api.availability('a', signal, 'doc-a'),
      { status: 'unavailable', reason: 'Semantic search is disabled in PDF settings.' })
    await assert.rejects(f.search(), { code: 'pdf/retrieval-engine-unavailable', message: 'Semantic search is disabled in PDF settings.' })
    await assert.rejects(f.api.prepare('a', { documentId: 'doc-a' }, signal), { code: 'pdf/retrieval-engine-unavailable' })
    assert.equal(f.runtimes.length, 2, 'disable never allocates a fake runtime or disposes the reusable index')
    await f.configure('embed-a')
    assert.deepEqual(f.api.selection(f.documents[0]!), selection, 'the force identity survives a reversible global disable')
    assert.equal((await f.search()).indexGeneration, forced.indexGeneration)
    assert.equal(f.api.settings('a', 'doc-a').pending, false)
  } finally { await f.api.dispose() }
})

test('enabling global search for a PDF opened while disabled asks for an explicit first build', async () => {
  const f = fixture()
  try {
    f.updateDefaults({ embeddingEngine: 'none' })
    assert.equal(f.api.settings('a', 'doc-a').enabled, false)
    await f.policies.settled('/book.pdf')
    f.updateDefaults({ embeddingEngine: 'embed-a' }); f.api.refresh()
    assert.equal(f.api.settings('a', 'doc-a').enabled, true)
    assert.equal(f.api.settings('a', 'doc-a').activeEnabled, false)
    const reason = 'Build or update this PDF\'s semantic index in the search panel before searching.'
    assert.deepEqual(await f.api.availability('a', signal, 'doc-a'), { status: 'unavailable', reason })
    await assert.rejects(f.search(), { code: 'pdf/retrieval-engine-unavailable', message: reason })
    assert.equal(f.runtimes.length, 0, 'enabling an engine must not silently allocate or build an index')
    await f.api.stage('a', 'doc-a'); await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    assert.equal((await f.api.availability('a', signal, 'doc-a')).status, 'available')
    assert.equal((await f.search()).effectiveMode, 'semantic')
    assert.equal(f.api.settings('a', 'doc-a').activeEnabled, true)
  } finally { await f.api.dispose() }
})

test('staging is idempotent, force creates one fresh runtime, and ordinary resume cannot resurrect the pre-force runtime', async () => {
  const f = fixture()
  try {
    const previous = await f.search()
    await f.api.stage('a', 'doc-a', true)
    const first = f.api.selection(f.documents[0]!)!
    await f.api.stage('a', 'doc-a', true)
    assert.deepEqual(f.api.selection(f.documents[0]!), first)
    const progress: RetrievalProgress[] = []
    await f.api.prepare('a', { documentId: 'doc-a', indexPlanId: first.planId }, signal, value => progress.push(value))
    const forced = await f.search()
    assert.notEqual(forced.indexGeneration, previous.indexGeneration)
    assert.equal(f.calls.find(call => call.kind === 'prepare')!.rebuild, true)
    assert.equal(progress.at(-1)?.phase, 'ready')
    await f.api.stage('a', 'doc-a')
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    assert.equal((await f.search()).indexGeneration, forced.indexGeneration)
    assert.equal(f.runtimes.length, 2, 'normal resume preserves the most recently refreshed runtime')
    assert.equal(f.calls.at(-2)!.rebuild, undefined)
  } finally { await f.api.dispose() }
})

test('LRU eviction waits for real runtime disposal and allocation failure does not poison the queue', async () => {
  const f = fixture(1), entered = deferred(), gate = deferred()
  try {
    await f.search()
    await f.configure('embed-b', 'other'); await f.api.stage('a', 'other')
    f.state.onDispose = async () => { entered.resolve(); await gate.promise }
    const pending = f.api.prepare('a', { documentId: 'other' }, signal)
    await entered.promise
    assert.equal(f.runtimes.length, 1, 'a replacement cannot be allocated before the old worker is drained')
    gate.resolve(); await pending
    assert.equal(f.runtimes[0]!.closed, true); assert.equal(f.runtimes.length, 2)
    f.state.onDispose = undefined
    f.state.createError = new Error('factory failed')
    await assert.rejects(f.search(), /factory failed/)
    f.state.createError = undefined
    assert.equal((await f.search()).status, 'complete')
  } finally { gate.resolve(); await f.api.dispose() }
})

test('runtimes with active users cannot be evicted and session cancellation reaches each resident API', async () => {
  const f = fixture(1), entered = deferred(), gate = deferred()
  try {
    f.state.onSearch = async () => { entered.resolve(); await gate.promise }
    const search = f.search(); await entered.promise
    await f.configure('embed-b', 'other'); await f.api.stage('a', 'other')
    await assert.rejects(f.api.prepare('a', { documentId: 'other' }, signal), { code: 'pdf/retrieval-busy' })
    assert.equal(f.runtimes.length, 1)
    f.api.cancelSession('a'); assert.deepEqual(f.runtimes[0]!.cancelled, ['a'])
    gate.resolve(); await search
    await f.api.prepare('a', { documentId: 'other' }, signal)
  } finally { gate.resolve(); await f.api.dispose() }
})

test('a scoped preparation forwards requested bounds only when no candidate is being activated', async () => {
  const f = fixture()
  try {
    await f.api.prepare('a', { documentId: 'doc-a', fromPage: 2, maxPages: 3 }, signal)
    assert.deepEqual(f.calls.at(-1), { kind: 'prepare', runtime: 1, sessionId: 'a', documentId: 'doc-a', fromPage: 2, maxPages: 3 })
    assert.equal(f.api.settings('a', 'doc-a').pending, false)
  } finally { await f.api.dispose() }
})

test('explicit global reset drains every runtime before clearing shared cache and blocks admissions until completion', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    await f.search(); await f.configure('embed-b', 'other'); await f.api.stage('a', 'other')
    await f.api.prepare('a', { documentId: 'other' }, signal)
    f.state.onClear = async () => { entered.resolve(); await gate.promise }
    const resetting = f.api.rebuild()
    assert.equal(f.api.rebuild(), resetting)
    await entered.promise
    assert.ok(f.runtimes.every(runtime => runtime.closed))
    await assert.rejects(f.search(), { code: 'pdf/retrieval-busy' })
    gate.resolve(); await resetting
    assert.equal(f.state.clears, 1)
    assert.equal((await f.search()).status, 'complete')
  } finally { gate.resolve(); await f.api.dispose() }
})

test('a failed runtime disposal or cache reset keeps admission closed until an explicit successful retry', async () => {
  for (const failure of ['runtime', 'storage']) {
    const f = fixture()
    try {
      await f.search()
      if (failure === 'runtime') f.state.onDispose = async () => { throw new Error('worker shutdown failed') }
      else f.state.onClear = async () => { throw new Error('cache deletion failed') }
      await assert.rejects(f.api.rebuild(), /failed/)
      await assert.rejects(f.search(), { code: 'pdf/retrieval-busy' })
      f.state.onDispose = undefined; f.state.onClear = undefined
      await f.api.rebuild()
      assert.equal((await f.search()).status, 'complete')
    } finally { await f.api.dispose() }
  }
})

test('passive listeners are isolated and disposal drains admitted work, closes future admissions and is idempotent', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  let notifications = 0
  f.api.subscribe(() => { throw new Error('passive listener failure') })
  const stop = f.api.subscribe(() => { notifications++ })
  try {
    const initial = f.api.settings('a', 'doc-a')
    await f.api.configure('a', 'doc-a', initial.revision, { ...initial.policy, indexImageDescriptions: true })
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    assert.ok(notifications >= 2)
    stop(); const before = notifications
    f.state.onPrepare = async () => { entered.resolve(); await gate.promise }
    const updating = f.api.prepare('a', { documentId: 'doc-a' }, signal)
    const cancelled = assert.rejects(updating, /Runtime closed/)
    await entered.promise
    const closing = f.api.dispose()
    assert.equal(f.api.dispose(), closing)
    let completed = false; void closing.then(() => { completed = true })
    await turn(); assert.equal(completed, false)
    await assert.rejects(f.search(), { code: 'pdf/cancelled' })
    await assert.rejects(f.api.rebuild(), /closed/)
    gate.resolve(); await Promise.all([cancelled, closing])
    assert.equal(notifications, before)
  } finally { gate.resolve(); await f.api.dispose() }
})

test('disposal reports worker failures after attempting every resident runtime', async () => {
  const f = fixture()
  await f.search(); await f.configure('embed-b', 'other'); await f.api.stage('a', 'other')
  await f.api.prepare('a', { documentId: 'other' }, signal)
  const attempts: number[] = []
  f.state.onDispose = async runtime => { attempts.push(runtime.id); throw new Error(`worker ${runtime.id} failed`) }
  await assert.rejects(f.api.dispose(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); return true
  })
  assert.deepEqual(attempts, [1, 2])
})

test('invalid runtime budgets are rejected before any document or engine is accessed', async () => {
  for (const maxRuntimes of [0, -1, 1.5, 17, NaN]) {
    assert.throws(() => createDocumentIndexes({ maxRuntimes, documents: () => [],
      policies: {} as never, create: () => { throw new Error('must not allocate') }, clearCache: async () => {} }), RangeError)
  }
})

test('a forced update retires an old shared runtime without evicting its current users or resurrecting it on another PDF', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    const old = await f.search()
    await f.search('a', 'other')
    f.state.onSearch = async (runtime, call) => {
      if (runtime.id === 1 && call.documentId === 'other') { entered.resolve(); await gate.promise }
    }
    const admitted = f.search('a', 'other'); await entered.promise
    await f.api.stage('a', 'doc-a', true)
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    await assert.rejects(f.search('a', 'other'), { code: 'pdf/retrieval-busy' })
    assert.equal(f.runtimes[0]!.closed, false, 'an admitted request retains the old runtime until it finishes')
    gate.resolve(); await admitted
    const refreshed = await f.search('a', 'other')
    assert.notEqual(refreshed.indexGeneration, old.indexGeneration)
    assert.equal(f.runtimes[0]!.closed, true)
    await f.configure('none'); await f.configure('embed-a'); await f.api.stage('a', 'doc-a')
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    assert.notEqual((await f.search()).indexGeneration, old.indexGeneration,
      'disabling and reenabling a document cannot restore a retired pre-force index')
  } finally { gate.resolve(); await f.api.dispose() }
})

test('closing during a failing explicit reset waits for admitted cleanup without reopening the service', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  await f.search()
  f.state.onClear = async () => { entered.resolve(); await gate.promise; throw new Error('cache reset failed during closing') }
  const resetting = f.api.rebuild(), failed = assert.rejects(resetting, /cache reset failed/)
  await entered.promise
  const closing = f.api.dispose()
  let completed = false
  void closing.then(() => { completed = true })
  await turn(); assert.equal(completed, false)
  gate.resolve(); await Promise.all([failed, closing])
  await assert.rejects(f.search(), { code: 'pdf/cancelled' })
  assert.ok(f.runtimes.every(runtime => runtime.closed))
})

test('ordinary start coalesces with a pending forced build instead of retiring its candidate', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    await f.search()
    let notifications = 0, activations = 0
    f.policies.subscribe(() => { notifications++ })
    const activate = f.policies.activate
    f.policies.activate = (...args) => { activations++; return activate(...args) }
    await f.api.stage('a', 'doc-a', true)
    const candidate = f.api.selection(f.documents[0]!)!
    f.state.onPrepare = async () => { entered.resolve(); await gate.promise }
    const build = f.api.prepare('a', { documentId: 'doc-a', indexPlanId: candidate.planId }, signal)
    await entered.promise
    await f.api.stage('a', 'doc-a')
    assert.deepEqual(f.api.selection(f.documents[0]!), candidate)
    gate.resolve(); await build
    assert.equal(f.runtimes.length, 2)
    assert.equal(f.calls.filter(call => call.kind === 'prepare').length, 1)
    assert.equal(f.api.selection(f.documents[0]!)!.identity, candidate.identity)
    assert.equal(activations, 1, 'the retained forced candidate is promoted exactly once')
    assert.equal(notifications, 0, 'a force refresh of the same saved plan does not manufacture preference revisions')
    assert.equal((await f.search()).indexGeneration, 'runtime-2')
  } finally { gate.resolve(); await f.api.dispose() }
})

test('closing the final owner releases the candidate but keeps preferences and reusable runtimes', async () => {
  const f = fixture()
  try {
    const original = await f.search()
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a', true)
    const candidate = f.api.selection(f.documents[0]!)!
    const first = { ...f.documents[0]! }, second = { ...f.documents[1]! }
    f.documents.splice(0, 1); f.api.refresh()
    assert.deepEqual(f.api.selection(second), candidate, 'another session still owns the same canonical PDF')
    f.documents.splice(f.documents.findIndex(owner => owner.id === 'doc-b'), 1)
    f.api.refresh(); await turn()
    assert.equal(f.runtimes[0]!.closed, false, 'resource closure does not dispose a plan shared through the LRU')
    f.updateDefaults({ embeddingEngine: 'embed-c' })
    f.documents.push(first)
    const restored = f.api.settings('a', 'doc-a')
    assert.equal(f.policies.desired('/book.pdf').policy.embeddingEngine, 'embed-c')
    assert.equal(f.policies.active('/book.pdf').policy.embeddingEngine, 'embed-a')
    assert.equal(restored.pending, true)
    assert.notEqual(f.api.selection(first)!.identity, candidate.identity, 'a closed candidate is not silently resumed')
    assert.equal((await f.search()).indexGeneration, original.indexGeneration)
  } finally { await f.api.dispose() }
})

test('last-owner closure drops the path-specific force identity while preserving the refreshed durable plan', async () => {
  const f = fixture()
  try {
    await f.search(); await f.api.stage('a', 'doc-a', true)
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    const first = { ...f.documents[0]! }, forced = f.api.selection(first)!
    f.documents.splice(0, 1); f.api.refresh()
    assert.equal(f.api.selection(f.documents[0]!)!.identity, forced.identity)
    f.documents.splice(f.documents.findIndex(owner => owner.id === 'doc-b'), 1); f.api.refresh(); await turn()
    f.documents.push(first)
    assert.notEqual(f.api.selection(first)!.identity, forced.identity)
    assert.equal(f.policies.active('/book.pdf').policy.embeddingEngine, 'embed-a')
    assert.equal(f.runtimes[1]!.closed, false, 'the runtime remains subject to the ordinary shared LRU budget')
  } finally { await f.api.dispose() }
})

test('an admitted content preference commits after the final view closes without rewriting its frozen active plan', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    const initial = f.api.settings('a', 'doc-a'); await f.policies.settled('/book.pdf')
    f.state.onPut = async () => { entered.resolve(); await gate.promise }
    const saving = f.api.configure('a', 'doc-a', initial.revision, { ...initial.policy, indexImageDescriptions: true })
    await entered.promise
    const first = { ...f.documents[0]! }
    f.documents.splice(0, 2); f.updateDefaults({ embeddingEngine: 'none' }); f.api.refresh()
    gate.resolve(); await saving; await turn()
    f.documents.push(first)
    const reopened = f.api.settings('a', 'doc-a')
    assert.equal(reopened.policy.indexImageDescriptions, true)
    assert.equal(reopened.enabled, false); assert.equal(reopened.activeEnabled, false)
    assert.equal((f.records.get('/book.pdf') as { active: ResolvedIndexPlan }).active.policy.embeddingEngine, 'embed-a')
    assert.equal(f.runtimes.length, 0)
  } finally { gate.resolve(); await f.api.dispose() }
})

test('global disable aborts a candidate and reenabling does not silently restart the expensive replacement', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    const original = await f.search(), originalSelection = f.api.selection(f.documents[0]!)!
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    let active!: AbortSignal
    f.state.onPrepare = async (_runtime, _call, signal) => { active = signal; entered.resolve(); await gate.promise }
    const preparing = f.api.prepare('a', { documentId: 'doc-a' }, signal)
    const rejected = assert.rejects(preparing, { code: 'pdf/retrieval-engine-unavailable' })
    await entered.promise
    f.updateDefaults({ embeddingEngine: 'none' }); f.api.refresh()
    assert.equal(active.aborted, true)
    gate.resolve(); await rejected
    f.updateDefaults({ embeddingEngine: 'embed-b' }); f.api.refresh()
    assert.deepEqual(f.api.selection(f.documents[0]!), originalSelection)
    assert.equal(f.api.settings('a', 'doc-a').pending, true)
    assert.equal((await f.search()).indexGeneration, original.indexGeneration)
    assert.equal(f.calls.filter(call => call.kind === 'prepare').length, 1)
  } finally { gate.resolve(); await f.api.dispose() }
})

test('availability checked across plan promotion cannot report the retired model as current', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  try {
    await f.search()
    f.state.onAvailability = async () => { entered.resolve(); await gate.promise }
    const availability = f.api.availability('a', signal, 'doc-a')
    await entered.promise
    await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    gate.resolve()
    const result = await availability
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason!, /settings changed/)
  } finally { gate.resolve(); await f.api.dispose() }
})

test('the LRU evicts the least recently used idle runtime and ignores owners without canonical paths', async () => {
  const f = fixture(2)
  try {
    await f.search()
    await f.configure('embed-b', 'other'); await f.api.stage('a', 'other')
    await f.api.prepare('a', { documentId: 'other' }, signal)
    await f.search()
    await f.configure('embed-c'); await f.api.stage('a', 'doc-a')
    await f.api.prepare('a', { documentId: 'doc-a' }, signal)
    assert.equal(f.runtimes[0]!.closed, false)
    assert.equal(f.runtimes[1]!.closed, true, 'the recently used first runtime survives instead of insertion-order eviction')
    f.documents.push({ sessionId: 'c', id: 'pathless', contentVersion: 'v1', sourceDigest: 'digest', conflict: false })
    f.api.refresh()
    assert.throws(() => f.api.settings('c', 'pathless'), { code: 'pdf/unknown-document' })
    assert.equal(f.runtimes.length, 3)
  } finally { await f.api.dispose() }
})

for (const kind of ['search', 'availability'] as const) {
  test(`global disable cancels an admitted ${kind} even when the forced ready identity is reenabled before it settles`, async () => {
    const f = fixture(), entered = deferred(), gate = deferred()
    try {
      await f.search(); await f.api.stage('a', 'doc-a', true)
      await f.api.prepare('a', { documentId: 'doc-a' }, signal)
      const ready = await f.search(), selected = f.api.selection(f.documents[0]!)!
      let active!: AbortSignal
      const wait = async (_runtime: Runtime, _call: Call, value: AbortSignal) => { active = value; entered.resolve(); await gate.promise }
      if (kind === 'search') f.state.onSearch = wait
      else f.state.onAvailability = wait
      const request = kind === 'search' ? f.search() : f.api.availability('a', signal, 'doc-a')
      const rejected = assert.rejects(request, { code: 'pdf/retrieval-engine-unavailable' })
      await entered.promise
      await f.configure('none')
      assert.equal(active.aborted, true)
      await f.configure('embed-a')
      assert.deepEqual(f.api.selection(f.documents[0]!), selected)
      gate.resolve(); await rejected
      f.state.onSearch = undefined; f.state.onAvailability = undefined
      assert.equal((await f.search()).indexGeneration, ready.indexGeneration)
      assert.equal(f.runtimes.length, 2, 'the ready index survives cancellation without allocating a disabled runtime')
    } finally { gate.resolve(); await f.api.dispose() }
  })
}

test('a global disable observed before its notification still prevents a completed candidate from being promoted', async () => {
  const f = fixture()
  try {
    await f.search(); await f.configure('embed-b'); await f.api.stage('a', 'doc-a')
    f.state.onPrepare = async () => { f.updateDefaults({ embeddingEngine: 'none' }) }
    await assert.rejects(f.api.prepare('a', { documentId: 'doc-a' }, signal), { code: 'pdf/retrieval-engine-unavailable' })
    assert.equal((f.records.get('/book.pdf') as { active: ResolvedIndexPlan }).active.policy.embeddingEngine, 'embed-a')
    f.updateDefaults({ embeddingEngine: 'embed-a' })
    assert.equal(f.api.settings('a', 'doc-a').pending, false)
  } finally { await f.api.dispose() }
})
