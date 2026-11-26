import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'
import { createDocumentIndexes } from '../../../../src/layers/facade/indexing/document-indexes.ts'
import { createDocumentIndexPolicies, type ResolvedRetrievalBinding } from '../../../../src/layers/facade/indexing/document-policy.ts'
import type { PdfRetrieval } from '../../../../src/layers/facade/search/host-retrieval.ts'
import type { OpenWorkingCopyDocument } from '../../../../src/layers/document/working-copy/index.ts'
import type { PdfDocumentIndexPolicy } from '../../../../src/contracts/indexing.ts'
import { defaultSettings, type PdfSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
interface Call { kind: string; runtime: number; sessionId?: string; documentId?: string; rebuild?: boolean; rebuildToken?: string; fromPage?: number; maxPages?: number }
interface Runtime {
  id: number; plan: ResolvedRetrievalBinding; closed: boolean; cancelled: string[]
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
    onPrepareSlice: undefined as ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<boolean>) | undefined,
    onSearch: undefined as ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<void>) | undefined,
    onAvailability: undefined as ((runtime: Runtime, call: Call, active: AbortSignal) => Promise<void>) | undefined,
    onDispose: undefined as ((runtime: Runtime) => Promise<void>) | undefined,
    onClear: undefined as (() => Promise<void>) | undefined,
    onPut: undefined as (() => Promise<void>) | undefined }
  function create(plan: ResolvedRetrievalBinding): PdfRetrieval {
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
      async prepareSlice(sessionId, input, active, progress) {
        let complete = true
        await run({ kind: 'prepareSlice', runtime: runtime.id, sessionId, ...input }, active,
          async (...args) => { complete = await state.onPrepareSlice?.(...args) ?? true })
        progress?.({ indexedPages: 1, totalPages: complete ? 1 : 2, embeddedChunks: 1, totalChunks: complete ? 1 : 2,
          phase: complete ? 'ready' : 'extracting', reusedChunks: 0, computedChunks: 1 })
        return complete
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

test('search resolves the current engine and content policy without staging a plan', async () => {
  const f = fixture()
  try {
    await f.search()
    assert.equal(f.runtimes[0]?.plan.policy.embeddingEngine, 'embed-a')
    f.updateDefaults({ embeddingEngine: 'embed-b' })
    await f.search('b', 'doc-b')
    assert.equal(f.runtimes[1]?.plan.policy.embeddingEngine, 'embed-b')
    assert.equal(f.api.settings('a', 'doc-a').revision, 0)
    await f.api.configure('a', 'doc-a', 0, { indexScanPages: false, indexImageDescriptions: true })
    await f.search()
    assert.equal(f.runtimes[2]?.plan.policy.indexScanPages, false)
    assert.equal(f.runtimes[2]?.plan.policy.indexImageDescriptions, true)
    assert.deepEqual(f.records.get('/book.pdf'), { version: 3, revision: 1,
      policy: { indexScanPages: false, indexImageDescriptions: true } })
  } finally { await f.api.dispose() }
})

test('explicit rebuild uses a fresh token and returns queries to the current cache identity', async () => {
  const f = fixture()
  try {
    await f.search()
    await f.api.stage('a', 'doc-a', true)
    const queued = f.api.selection(f.documents[0]!)!
    assert.notEqual(queued.bindingId, f.api.selection(f.documents[2]!)?.bindingId)
    await f.api.prepare('a', { documentId: 'doc-a', bindingId: queued.bindingId }, signal)
    const build = f.calls.find(call => call.kind === 'prepare')!
    assert.equal(build.rebuild, true)
    assert.equal(build.rebuildToken, queued.bindingId)
    await f.search()
    assert.equal(f.runtimes.at(-1)?.plan.policy.embeddingEngine, 'embed-a')
  } finally { await f.api.dispose() }
})

test('document ownership gates access to configuration and search', async () => {
  const f = fixture()
  try {
    assert.throws(() => f.api.settings('b', 'doc-a'), { code: 'pdf/unknown-document' })
    await assert.rejects(f.api.prepare('b', { documentId: 'doc-a' }, signal), { code: 'pdf/unknown-document' })
    await assert.rejects(f.api.search('b', { documentId: 'doc-a', query: 'query', mode: 'semantic' }, signal),
      { code: 'pdf/unknown-document' })
  } finally { await f.api.dispose() }
})

test('global disable gates search without rewriting document preferences', async () => {
  const f = fixture()
  try {
    await f.search()
    f.updateDefaults({ embeddingEngine: 'none' }); f.api.refresh()
    assert.equal(f.api.settings('a', 'doc-a').enabled, false)
    await assert.rejects(f.search(), { code: 'pdf/retrieval-engine-unavailable' })
    f.updateDefaults({ embeddingEngine: 'embed-a' }); f.api.refresh()
    await f.search()
    assert.equal(f.api.settings('a', 'doc-a').enabled, true)
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
    f.updateDefaults({ embeddingEngine: 'embed-a' })
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
    gate.resolve(); await assert.rejects(search, { code: 'pdf/stale-reader' })
    await f.api.prepare('a', { documentId: 'other' }, signal)
  } finally { gate.resolve(); await f.api.dispose() }
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
    assert.ok(notifications >= 1)
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


test('the LRU evicts the least recently used idle runtime and ignores owners without canonical paths', async () => {
  const f = fixture(2)
  try {
    await f.search()
    await f.configure('embed-b', 'other'); await f.api.stage('a', 'other')
    await f.api.prepare('a', { documentId: 'other' }, signal)
    f.updateDefaults({ embeddingEngine: 'embed-a' })
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
      assert.equal(f.runtimes.length, 3, 'the current cache identity can allocate a replacement after a forced rebuild')
    } finally { gate.resolve(); await f.api.dispose() }
  })
}
