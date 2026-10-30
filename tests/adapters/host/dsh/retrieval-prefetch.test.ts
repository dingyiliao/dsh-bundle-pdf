import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalPrefetch, type RetrievalPrefetchDocument } from '../../../../src/adapters/host/dsh/retrieval-prefetch.ts'
import type { RetrievalProgress } from '../../../../src/modules/retrieval/index.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const document = (id: string): RetrievalPrefetchDocument => ({ sessionId: 'session', id,
  contentVersion: 'content-1', sourceDigest: 'sha256:source-1', conflict: false })

test('background indexing is deferred, shared by duplicate owners and disabled until an engine is selected', async () => {
  let selected: { identity: string } | undefined
  let documents = [document('a'), document('a'), document('b')]
  const calls: string[] = []
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => selected,
    async prepare(sessionId, input) { assert.equal(sessionId, 'session'); calls.push(input.documentId) } })
  try {
    await turn()
    assert.deepEqual(calls, [])
    selected = { identity: 'model-binding-1' }
    prefetch.refresh()
    assert.deepEqual(calls, [], 'opening a document cannot synchronously perform model work')
    await turn()
    assert.deepEqual(calls, ['a', 'b'])
    assert.deepEqual(prefetch.status().documents.map(row => row.state), ['ready', 'ready'])
    prefetch.refresh(); prefetch.refresh()
    await turn()
    assert.deepEqual(calls, ['a', 'b'], 'equivalent opens and notifications keep the prepared index')
    documents = [document('b')]
    prefetch.refresh(); await turn()
    assert.deepEqual(prefetch.status().documents.map(row => row.id), ['b'])
  } finally { await prefetch.dispose() }
})

test('one bounded background lane waits for a cancelled old owner to drain before starting the next document', async () => {
  const gates = [deferred(), deferred()]
  const calls: Array<{ id: string; signal: AbortSignal }> = []
  let documents = [document('a'), document('b'), document('c')]
  const prefetch = createRetrievalPrefetch({ documents: () => documents, maxDocuments: 2,
    selection: () => ({ identity: 'engine' }), async prepare(_session, input, signal) {
      calls.push({ id: input.documentId, signal })
      await gates[calls.length - 1]!.promise
    } })
  try {
    await turn()
    assert.deepEqual(calls.map(call => call.id), ['a'])
    assert.equal(prefetch.status().skippedDocuments, 1)
    assert.equal(prefetch.status().documents.length, 2)
    documents = [document('b')]
    prefetch.refresh(); await turn()
    assert.equal(calls[0]!.signal.aborted, true)
    assert.equal(calls.length, 1, 'an abort-ignoring task still owns the background lane until it drains')
    gates[0]!.resolve(); await turn()
    assert.deepEqual(calls.map(call => call.id), ['a', 'b'])
    gates[1]!.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { for (const gate of gates) gate.resolve(); await prefetch.dispose() }
})

test('source and saved engine changes cancel outdated preparation and retain only the latest generation', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const calls: AbortSignal[] = []
  let current = document('a'), identity = 'binding-1'
  const prefetch = createRetrievalPrefetch({ documents: () => [current], selection: () => ({ identity }),
    async prepare(_session, _input, signal) { calls.push(signal); await gates[calls.length - 1]!.promise } })
  try {
    await turn()
    current = { ...current, contentVersion: 'content-2', sourceDigest: 'sha256:source-2' }
    prefetch.refresh(); await turn()
    assert.equal(calls[0]!.aborted, true)
    gates[0]!.resolve(); await turn()
    assert.equal(calls.length, 2)
    identity = 'binding-2'
    prefetch.refresh(); await turn()
    assert.equal(calls[1]!.aborted, true)
    gates[1]!.resolve(); await turn()
    assert.equal(calls.length, 3)
    gates[2]!.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.contentVersion, 'content-2')
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { for (const gate of gates) gate.resolve(); await prefetch.dispose() }
})

test('the default background document budget bounds preparation at 64 owned documents', async () => {
  const documents = Array.from({ length: 67 }, (_, index) => document(`document-${index}`))
  let calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }),
    async prepare() { calls++ } })
  try {
    await turn()
    assert.equal(calls, 64)
    assert.equal(prefetch.status().documents.length, 64)
    assert.equal(prefetch.status().skippedDocuments, 3)
    assert.equal(prefetch.status().state, 'idle')
  } finally { await prefetch.dispose() }
})

test('failed generations remain diagnosable without an automatic retry loop or leaking provider messages', async () => {
  let identity = 'broken-binding', calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity }),
    async prepare() {
      calls++
      if (identity === 'broken-binding') throw Object.assign(new Error('private PDF text and API key'), { code: 'embedding/unavailable' })
    }, onChange() { throw new Error('observer failure') } })
  try {
    await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'failed')
    assert.equal(prefetch.status().documents[0]!.failureCode, 'embedding/unavailable')
    assert.equal(JSON.stringify(prefetch.status()).includes('private'), false)
    prefetch.refresh(); prefetch.refresh(); await turn()
    assert.equal(calls, 1)
    identity = 'fixed-binding'
    prefetch.refresh(); await turn()
    assert.equal(calls, 2)
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { await prefetch.dispose() }
})

test('reset suspension stops admission immediately, drains active work and prepares open files afresh after resume', async () => {
  const gate = deferred(), calls: AbortSignal[] = []
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a'), document('b')],
    selection: () => ({ identity: 'engine' }), async prepare(_session, _input, signal) {
      calls.push(signal)
      if (calls.length === 1) await gate.promise
    } })
  try {
    await turn()
    let drained = false
    const suspend = prefetch.suspend().then(() => { drained = true })
    assert.equal(calls[0]!.aborted, true)
    assert.equal(prefetch.status().state, 'suspended')
    prefetch.refresh(); await turn()
    assert.equal(calls.length, 1)
    assert.equal(drained, false)
    gate.resolve(); await suspend
    assert.equal(prefetch.status().documents.length, 0)
    prefetch.resume(); await turn()
    assert.equal(calls.length, 3, 'both still-open files receive fresh preparation after the cache reset')
    assert.deepEqual(prefetch.status().documents.map(row => row.state), ['ready', 'ready'])
  } finally { gate.resolve(); await prefetch.dispose() }
})

test('conflicted and disabled documents are cancelled, and disposal unsubscribes and drains late work', async () => {
  let selected: { identity: string } | undefined = { identity: 'engine' }
  let current = document('a'), notify!: () => void, removed = 0
  const gates = [deferred(), deferred()]
  const calls: AbortSignal[] = []
  const prefetch = createRetrievalPrefetch({ documents: () => [current], selection: () => selected,
    subscribe(listener) { notify = listener; return () => { removed++ } },
    async prepare(_session, _input, signal) { calls.push(signal); await gates[calls.length - 1]!.promise } })
  try {
    await turn()
    current = { ...current, conflict: true }
    notify(); await turn()
    assert.equal(calls[0]!.aborted, true)
    gates[0]!.resolve(); await turn()
    assert.equal(prefetch.status().documents.length, 0)
    current = { ...current, conflict: false }
    notify(); await turn()
    assert.equal(calls.length, 2)
    selected = undefined
    notify(); await turn()
    assert.equal(calls[1]!.aborted, true)
    const disposing = prefetch.dispose()
    assert.equal(removed, 1)
    assert.equal(prefetch.status().state, 'disposed')
    gates[1]!.resolve(); await disposing
    selected = { identity: 'engine' }; notify(); prefetch.resume(); await turn()
    assert.equal(calls.length, 2)
    await prefetch.dispose()
    assert.equal(removed, 1)
  } finally { for (const gate of gates) gate.resolve(); await prefetch.dispose() }
})

test('invalid settings probes become bounded diagnostic failures and recover only after another refresh', async () => {
  let broken = true, calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection() {
    if (broken) throw new Error('private configuration')
    return { identity: 'engine' }
  }, async prepare() { calls++ } })
  try {
    await turn()
    assert.equal(prefetch.status().failureCode, 'pdf/retrieval-prefetch-failed')
    assert.equal(calls, 0)
    broken = false; prefetch.refresh(); await turn()
    assert.equal(calls, 1)
    assert.equal(prefetch.status().failureCode, undefined)
  } finally { await prefetch.dispose() }
  for (const maxDocuments of [0, -1, 0.5, 1025]) {
    assert.throws(() => createRetrievalPrefetch({ documents: () => [], selection: () => undefined,
      async prepare() {}, maxDocuments }), RangeError)
  }
})

test('a failing subscription disposer still drains active work and cannot detach twice', async () => {
  const gate = deferred()
  let signal!: AbortSignal, unsubscribes = 0, settled = false
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity: 'engine' }),
    subscribe() { return () => { unsubscribes++; throw new Error('subscription cleanup failed') } },
    async prepare(_session, _input, active) { signal = active; await gate.promise } })
  await turn()
  const disposing = prefetch.dispose()
  const rejected = assert.rejects(disposing, /subscription cleanup failed/).then(() => { settled = true })
  assert.strictEqual(prefetch.dispose(), disposing)
  assert.equal(signal.aborted, true)
  await turn()
  assert.equal(settled, false, 'unsubscribe failure must not skip draining non-cooperative preparation')
  gate.resolve(); await rejected
  assert.equal(unsubscribes, 1)
  assert.equal(prefetch.status().state, 'disposed')
})

test('progress snapshots update revisions only when changed and cannot mutate internal state', async () => {
  const gate = deferred()
  let progress!: (progress: RetrievalProgress) => void, updates = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity: 'engine' }),
    async prepare(_session, _input, _signal, report) { progress = report!; await gate.promise } })
  const stop = prefetch.subscribe(() => { updates++ })
  const stopThrowing = prefetch.subscribe(() => { throw new Error('observer failure') })
  const stopRejecting = prefetch.subscribe(async () => { throw new Error('asynchronous observer failure') })
  try {
    await turn()
    const started = prefetch.status(), occurrence = started.documents[0]!.occurrence
    const snapshot: RetrievalProgress = { indexedPages: 2, totalPages: 5, embeddedChunks: 1, totalChunks: 4,
      phase: 'restoring', reusedChunks: 1, computedChunks: 0 }
    progress(snapshot)
    const current = prefetch.status()
    assert.notEqual(current.revision, started.revision)
    assert.deepEqual(current.documents[0]!.progress, snapshot)
    assert.equal(current.documents[0]!.occurrence, occurrence)
    snapshot.indexedPages = 3
    current.documents[0]!.progress!.indexedPages = 4
    assert.equal(prefetch.status().documents[0]!.progress!.indexedPages, 2)
    const before = prefetch.status().revision, count = updates
    progress({ indexedPages: 2, totalPages: 5, embeddedChunks: 1, totalChunks: 4,
      phase: 'restoring', reusedChunks: 1, computedChunks: 0 })
    prefetch.refresh(); await turn()
    assert.equal(prefetch.status().revision, before)
    assert.equal(updates, count)
    progress({ indexedPages: 9, totalPages: 5, embeddedChunks: 1, totalChunks: 4 })
    assert.equal(prefetch.status().revision, before, 'invalid progress does not wake subscribers')
    progress({ indexedPages: 2, totalPages: 5, embeddedChunks: 1, totalChunks: 4,
      phase: 'embedding', reusedChunks: 1, computedChunks: 1 })
    assert.equal(prefetch.status().revision, before, 'work counts cannot exceed completed vector coverage')
    gate.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
    const ended = updates
    stop(); stopThrowing(); stopRejecting()
    await prefetch.dispose()
    assert.equal(updates, ended)
  } finally { gate.resolve(); stop(); stopThrowing(); stopRejecting(); await prefetch.dispose() }
})

test('manual cancellation holds the generation stopped, fences late progress and permits a new occurrence', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const calls: Array<{ signal: AbortSignal; progress: (progress: RetrievalProgress) => void }> = []
  let documents = [document('a')]
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }),
    async prepare(_session, _input, signal, progress) { calls.push({ signal, progress: progress! }); await gates[calls.length - 1]!.promise } })
  try {
    await turn()
    calls[0]!.progress({ indexedPages: 1, totalPages: 3, embeddedChunks: 0, totalChunks: 2 })
    const firstOccurrence = prefetch.status().documents[0]!.occurrence
    prefetch.cancel('session', 'a')
    const cancelled = prefetch.status()
    assert.equal(cancelled.documents[0]!.state, 'cancelled')
    assert.equal(calls[0]!.signal.aborted, true)
    calls[0]!.progress({ indexedPages: 3, totalPages: 3, embeddedChunks: 2, totalChunks: 2 })
    assert.equal(prefetch.status().revision, cancelled.revision)
    prefetch.refresh(); prefetch.refresh(); await turn()
    assert.equal(calls.length, 1)
    gates[0]!.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'cancelled')
    prefetch.start('session', 'a'); await turn()
    assert.equal(calls.length, 2)
    assert.ok(prefetch.status().documents[0]!.occurrence > firstOccurrence)
    calls[0]!.progress({ indexedPages: 3, totalPages: 3, embeddedChunks: 2, totalChunks: 2 })
    assert.equal(prefetch.status().documents[0]!.progress, undefined, 'a new occurrence does not inherit the cancelled task counts')
    gates[1]!.resolve(); await turn()
    const ready = prefetch.status()
    prefetch.start('session', 'a'); await turn()
    assert.equal(calls.length, 2, 'a ready generation needs no duplicate preparation')
    assert.equal(prefetch.status().revision, ready.revision)
    documents = []; prefetch.refresh(); await turn()
    documents = [document('a')]; prefetch.refresh(); await turn()
    assert.equal(calls.length, 3, 'a genuine close and reopen starts a new open lifecycle')
    gates[2]!.resolve()
  } finally { for (const gate of gates) gate.resolve(); await prefetch.dispose() }
})

test('a queued cancellation is retained until its source changes', async () => {
  const gate = deferred(), calls: string[] = []
  let documents = [document('a'), document('b')]
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }),
    async prepare(_session, input) { calls.push(input.documentId); if (input.documentId === 'a') await gate.promise } })
  try {
    await turn()
    prefetch.cancel('session', 'b')
    assert.equal(prefetch.status().documents.find(row => row.id === 'b')!.state, 'cancelled')
    gate.resolve(); await turn()
    prefetch.refresh(); await turn()
    assert.deepEqual(calls, ['a'])
    documents = [document('a'), { ...document('b'), sourceDigest: 'source-2' }]
    prefetch.refresh(); await turn()
    assert.deepEqual(calls, ['a', 'b'])
    assert.equal(prefetch.status().documents.find(row => row.id === 'b')!.state, 'ready')
  } finally { gate.resolve(); await prefetch.dispose() }
})

test('manual start retries a failed occurrence and prioritizes skipped owned documents within the same budget', async () => {
  const calls: string[] = []
  let failA = true
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a'), document('b'), document('c')],
    maxDocuments: 2, selection: () => ({ identity: 'engine' }), async prepare(_session, input) {
      calls.push(input.documentId)
      if (input.documentId === 'a' && failA) throw new Error('private failure')
    } })
  try {
    await turn()
    assert.deepEqual(calls, ['a', 'b'])
    const failed = prefetch.status().documents.find(row => row.id === 'a')!
    failA = false
    prefetch.start('session', 'a'); await turn()
    assert.deepEqual(calls, ['a', 'b', 'a'])
    assert.ok(prefetch.status().documents.find(row => row.id === 'a')!.occurrence > failed.occurrence)
    prefetch.start('session', 'c'); await turn()
    assert.deepEqual(calls, ['a', 'b', 'a', 'c'])
    assert.equal(prefetch.status().documents.length, 2)
    assert.equal(prefetch.status().skippedDocuments, 1)
    assert.equal(prefetch.status().documents.find(row => row.id === 'c')!.state, 'ready')
    prefetch.refresh(); await turn()
    assert.deepEqual(calls, ['a', 'b', 'a', 'c'], 'manual priority survives automatic reconciliation')
  } finally { await prefetch.dispose() }
})

test('manual actions reject foreign or unavailable documents without implicitly enabling an engine', async () => {
  let selected: { identity: string } | undefined
  let current = document('a'), calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [current], selection: () => selected,
    async prepare() { calls++ } })
  const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected)
  try {
    assert.throws(() => prefetch.start('another-session', 'a'), code('pdf/unknown-document'))
    assert.throws(() => prefetch.cancel('another-session', 'a'), code('pdf/unknown-document'))
    assert.throws(() => prefetch.start('session', 'missing'), code('pdf/unknown-document'))
    assert.throws(() => prefetch.start('session', 'a'), code('pdf/retrieval-engine-unavailable'))
    selected = { identity: 'engine' }; current = { ...current, conflict: true }
    assert.throws(() => prefetch.start('session', 'a'), code('pdf/stale-reader'))
    current = { ...current, conflict: false }
    await prefetch.suspend()
    assert.throws(() => prefetch.start('session', 'a'), code('pdf/retrieval-busy'))
    assert.equal(calls, 0)
  } finally { await prefetch.dispose() }
  assert.throws(() => prefetch.start('session', 'a'), code('pdf/cancelled'))
})

test('manual rebuild replaces a ready occurrence and coalesces repeated requests while the new task runs', async () => {
  const gate = deferred()
  const calls: Array<{ documentId: string; rebuild?: boolean }> = []
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a'), document('b')],
    selection: () => ({ identity: 'engine' }), async prepare(_session, input) {
      calls.push(input)
      if (input.rebuild) await gate.promise
    } })
  try {
    await turn()
    const initial = prefetch.status().documents.find(row => row.id === 'a')!
    const other = prefetch.status().documents.find(row => row.id === 'b')!
    assert.equal(initial.state, 'ready')
    prefetch.rebuild('session', 'a'); await turn()
    const rebuilding = prefetch.status().documents.find(row => row.id === 'a')!
    assert.equal(rebuilding.state, 'running')
    assert.ok(rebuilding.occurrence > initial.occurrence)
    assert.deepEqual(calls, [{ documentId: 'a' }, { documentId: 'b' }, { documentId: 'a', rebuild: true }])
    prefetch.rebuild('session', 'a'); await turn()
    assert.equal(calls.length, 3)
    assert.equal(prefetch.status().documents.find(row => row.id === 'a')!.occurrence, rebuilding.occurrence)
    assert.deepEqual(prefetch.status().documents.find(row => row.id === 'b'), other)
    gate.resolve(); await turn()
    assert.equal(prefetch.status().documents.find(row => row.id === 'a')!.state, 'ready')
  } finally { gate.resolve(); await prefetch.dispose() }
})

test('manual rebuild fences an active old occurrence and waits for its real drain before fresh work', async () => {
  const gate = deferred(), calls: Array<{ rebuild?: boolean; signal: AbortSignal }> = []
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity: 'engine' }),
    async prepare(_session, input, signal) {
      calls.push({ ...input, signal })
      if (!input.rebuild) await gate.promise
    } })
  try {
    await turn()
    prefetch.rebuild('session', 'a'); await turn()
    assert.equal(calls[0]!.signal.aborted, true)
    assert.equal(calls.length, 1)
    assert.equal(prefetch.status().documents[0]!.state, 'queued')
    gate.resolve(); await turn()
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.rebuild, true)
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { gate.resolve(); await prefetch.dispose() }
})
