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

test('a verified annotation-only save retains a ready index while a new body or path queues work', async () => {
  const body = `sha256:${'a'.repeat(64)}`
  let current = { ...document('a'), path: '/book.pdf', indexContentDigest: body }, calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [current], selection: () => ({ identity: 'engine' }),
    async prepare() { calls++ } })
  try {
    await turn()
    const ready = prefetch.status()
    assert.equal(ready.documents[0]?.state, 'ready')
    current = { ...current, sourceDigest: 'saved-note' }
    prefetch.refresh(); await turn()
    assert.deepEqual(prefetch.status(), ready, 'saving annotations does not publish a replacement task')
    assert.equal(calls, 1)
    current = { ...current, sourceDigest: 'saved-text', indexContentDigest: `sha256:${'b'.repeat(64)}` }
    prefetch.refresh(); await turn()
    assert.equal(calls, 2, 'body changes require a new index')
    current = { ...current, path: '/another.pdf' }
    prefetch.refresh(); await turn()
    assert.equal(calls, 3, 'save as requires the destination index namespace')
  } finally { await prefetch.dispose() }
})

test('a verified annotation-only save still fences an in-flight index read to its original bytes', async () => {
  const gate = deferred(), signals: AbortSignal[] = []
  let current = { ...document('a'), path: '/book.pdf', indexContentDigest: `sha256:${'a'.repeat(64)}` }
  const prefetch = createRetrievalPrefetch({ documents: () => [current], selection: () => ({ identity: 'engine' }),
    async prepare(_session, _input, signal) { signals.push(signal); if (signals.length === 1) await gate.promise } })
  try {
    await turn()
    assert.equal(prefetch.status().documents[0]?.state, 'running')
    current = { ...current, sourceDigest: 'saved-note' }
    prefetch.refresh(); await turn()
    assert.equal(signals[0]?.aborted, true)
    assert.equal(signals.length, 1)
    gate.resolve(); await turn()
    assert.equal(signals.length, 2)
    assert.equal(prefetch.status().documents[0]?.state, 'ready')
  } finally { gate.resolve(); await prefetch.dispose() }
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

test('resume keeps the interrupted plan and progress while the old uncooperative request drains', async () => {
  const gates = [deferred(), deferred()]
  const calls: Array<{ input: { documentId: string; indexPlanId?: string }; signal: AbortSignal; report: (progress: RetrievalProgress) => void }> = []
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')],
    selection: () => ({ identity: 'accepted-ocr', planId: 'accepted-ocr-plan' }),
    async prepare(_session, input, signal, report) { calls.push({ input, signal, report: report! }); await gates[calls.length - 1]!.promise } })
  try {
    await turn()
    calls[0]!.report({ indexedPages: 40, totalPages: 100, embeddedChunks: 20, totalChunks: 50,
      phase: 'embedding', computedChunks: 15, reusedChunks: 5 })
    const firstOccurrence = prefetch.status().documents[0]!.occurrence
    prefetch.cancel('session', 'a')
    prefetch.resumeTask('session', 'a')
    const resumed = prefetch.status().documents[0]!
    assert.ok(resumed.occurrence > firstOccurrence)
    assert.equal(resumed.state, 'queued')
    assert.deepEqual(resumed.progress, { indexedPages: 40, totalPages: 100, embeddedChunks: 20, totalChunks: 50,
      phase: 'restoring', computedChunks: 0, reusedChunks: 20 })
    prefetch.resumeTask('session', 'a')
    assert.equal(prefetch.status().documents[0]!.occurrence, resumed.occurrence, 'repeated resume does not replace an admitted task')
    calls[0]!.report({ indexedPages: 100, totalPages: 100, embeddedChunks: 100, totalChunks: 100 })
    await turn()
    assert.equal(calls.length, 1, 'the cancelled request retains its slot until it actually finishes')
    assert.deepEqual(prefetch.status().documents[0]!.progress, resumed.progress, 'late old progress cannot rewrite the retained checkpoint')
    gates[0]!.resolve(); await turn()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]!.input, { documentId: 'a', indexPlanId: 'accepted-ocr-plan' })
    assert.equal(prefetch.status().documents[0]!.state, 'running')
    assert.deepEqual(prefetch.status().documents[0]!.progress, resumed.progress, 'retained counters remain until Host reports actual restored work')
    prefetch.resumeTask('session', 'a')
    assert.equal(prefetch.status().documents[0]!.occurrence, resumed.occurrence)
    calls[1]!.report({ indexedPages: 50, totalPages: 100, embeddedChunks: 30, totalChunks: 60,
      phase: 'embedding', computedChunks: 10, reusedChunks: 20 })
    assert.equal(prefetch.status().documents[0]!.progress!.computedChunks, 10)
    assert.equal(prefetch.status().documents[0]!.progress!.reusedChunks, 20)
    gates[1]!.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
    assert.throws(() => prefetch.resumeTask('session', 'a'), { code: 'pdf/index-resume-unavailable' })
  } finally { for (const gate of gates) gate.resolve(); await prefetch.dispose() }
})

test('resume resets computed work for its new occurrence and accumulates only new quanta', async () => {
  const first = deferred(), resumed = deferred(), final = deferred()
  let calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity: 'engine' }),
    async prepare() { throw new Error('slices expected') },
    async prepareSlice(_session, _input, _signal, report) {
      calls++
      if (calls === 1) {
        report!({ indexedPages: 5, totalPages: 10, embeddedChunks: 12, totalChunks: 20, computedChunks: 10, reusedChunks: 2 })
        await first.promise; return false
      }
      if (calls === 2) {
        report!({ indexedPages: 7, totalPages: 10, embeddedChunks: 16, totalChunks: 20, computedChunks: 4, reusedChunks: 12 })
        await resumed.promise; return false
      }
      report!({ indexedPages: 10, totalPages: 10, embeddedChunks: 20, totalChunks: 20, computedChunks: 4, reusedChunks: 16 })
      await final.promise; return true
    } })
  try {
    await turn()
    prefetch.cancel('session', 'a'); prefetch.resumeTask('session', 'a')
    assert.equal(prefetch.status().documents[0]!.progress!.computedChunks, 0)
    first.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.progress!.computedChunks, 4)
    resumed.resolve(); await turn(); await turn()
    assert.equal(prefetch.status().documents[0]!.progress!.computedChunks, 8)
    assert.equal(prefetch.status().documents[0]!.progress!.reusedChunks, 12)
    final.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { first.resolve(); resumed.resolve(); final.resolve(); await prefetch.dispose() }
})

test('failed-task resume clears failure metadata and preserves source counters without a progress report', async () => {
  const gate = deferred()
  let calls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity: 'engine' }),
    async prepare(_session, _input, _signal, report) {
      if (++calls === 1) {
        report!({ indexedPages: 3, totalPages: 10, embeddedChunks: 2, totalChunks: 4 })
        throw Object.assign(new Error('model unavailable'), { code: 'embedding/unavailable' })
      }
      await gate.promise
    } })
  try {
    await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'failed')
    assert.equal(prefetch.status().documents[0]!.failureCode, 'embedding/unavailable')
    prefetch.resumeTask('session', 'a')
    assert.equal(prefetch.status().documents[0]!.failureCode, undefined)
    assert.deepEqual(prefetch.status().documents[0]!.progress,
      { indexedPages: 3, totalPages: 10, embeddedChunks: 2, totalChunks: 4, phase: 'restoring' })
    await turn(); assert.equal(calls, 2)
    gate.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { gate.resolve(); await prefetch.dispose() }
})

for (const change of ['identity', 'plan', 'source', 'disabled', 'unavailable'] as const) {
  test(`resume rejects ${change} changes instead of silently replacing the interrupted plan`, async () => {
    const gate = deferred()
    let current = document('a'), selection: { identity: string; planId?: string } | undefined = { identity: 'ocr', planId: 'ocr-plan' }
    let unavailable = false, calls = 0
    const prefetch = createRetrievalPrefetch({ documents: () => [current], selection() {
      if (unavailable) throw new Error('private engine discovery error')
      return selection
    }, async prepare() { calls++; await gate.promise } })
    try {
      await turn(); prefetch.cancel('session', 'a')
      const before = prefetch.status()
      if (change === 'identity') selection = { identity: 'image', planId: 'ocr-plan' }
      if (change === 'plan') selection = { identity: 'ocr', planId: 'new-plan' }
      if (change === 'source') current = { ...current, sourceDigest: 'changed-source' }
      if (change === 'disabled') selection = undefined
      if (change === 'unavailable') unavailable = true
      assert.throws(() => prefetch.resumeTask('session', 'a'), { code: 'pdf/index-settings-changed' })
      assert.deepEqual(prefetch.status(), before, 'a rejected resume cannot enqueue a new plan or clear the interrupted task')
      assert.equal(calls, 1)
    } finally { gate.resolve(); await prefetch.dispose() }
  })
}

test('resume of a forced rebuild preserves the prior plan identity and rebuild flag', async () => {
  const gates = [deferred(), deferred()]
  const inputs: Array<{ documentId: string; indexPlanId?: string; rebuild?: boolean }> = []
  let rebuildCalls = 0
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')],
    selection: () => ({ identity: 'forced-attempt', planId: 'forced-attempt-token' }),
    async prepare(_session, input) {
      inputs.push(input)
      if (input.rebuild) await gates[rebuildCalls++]!.promise
    } })
  try {
    await turn()
    prefetch.rebuild('session', 'a'); await turn()
    prefetch.cancel('session', 'a'); prefetch.resumeTask('session', 'a')
    gates[0]!.resolve(); await turn()
    assert.deepEqual(inputs.slice(1), [
      { documentId: 'a', indexPlanId: 'forced-attempt-token', rebuild: true },
      { documentId: 'a', indexPlanId: 'forced-attempt-token', rebuild: true },
    ])
    gates[1]!.resolve(); await turn()
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
  } finally { for (const gate of gates) gate.resolve(); await prefetch.dispose() }
})

test('resume rejects unknown tasks, foreign owners, conflicts, suspension and disposal without starting work', async () => {
  let current = document('a')
  const prefetch = createRetrievalPrefetch({ documents: () => [current], selection: () => undefined,
    async prepare() { throw new Error('unexpected work') } })
  try {
    assert.throws(() => prefetch.resumeTask('session', 'a'), { code: 'pdf/index-resume-unavailable' })
    assert.throws(() => prefetch.resumeTask('foreign-session', 'a'), { code: 'pdf/unknown-document' })
    current = { ...current, conflict: true }
    assert.throws(() => prefetch.resumeTask('session', 'a'), { code: 'pdf/stale-reader' })
    current = { ...current, conflict: false }
    await prefetch.suspend()
    assert.throws(() => prefetch.resumeTask('session', 'a'), { code: 'pdf/retrieval-busy' })
  } finally { await prefetch.dispose() }
  assert.throws(() => prefetch.resumeTask('session', 'a'), { code: 'pdf/cancelled' })
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

test('run diagnostics retain each occurrence and terminal error without allowing observers to mutate or fail the lane', async () => {
  type Event = import('../../../../src/adapters/host/dsh/indexing-diagnostics.ts').PrefetchDiagnosticEvent
  const events: Event[] = []
  let calls = 0
  const failure = Object.assign(new Error('private provider response'), { code: 'embedding/unavailable' })
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')], selection: () => ({ identity: 'engine' }),
    async prepare(_session, _input, _signal, report) {
      calls++
      report!({ indexedPages: 2, totalPages: 4, embeddedChunks: 0, totalChunks: 0, phase: 'extracting' })
      if (calls === 1) throw failure
    }, onDiagnostic(event) {
      events.push({ ...event, ...(event.progress ? { progress: { ...event.progress } } : {}) })
      if (event.progress) event.progress.indexedPages = 999
      if (event.event === 'started') throw new Error('failed diagnostic observer')
    } })
  try {
    await turn()
    assert.deepEqual(events.map(event => event.event), ['queued', 'started', 'progress', 'failed'])
    assert.equal(events.at(-1)?.error, failure)
    assert.equal(prefetch.status().documents[0]?.progress?.indexedPages, 2)
    prefetch.start('session', 'a'); await turn()
    assert.deepEqual(events.slice(4).map(event => event.event), ['queued', 'started', 'progress', 'ready'])
    assert.ok(events.slice(0, 4).every(event => event.occurrence === 1))
    assert.ok(events.slice(4).every(event => event.occurrence === 2))
    assert.equal(prefetch.status().documents[0]?.state, 'ready')
  } finally { await prefetch.dispose() }
  assert.equal(events.filter(event => event.event === 'cancelled').length, 0, 'disposing a completed task cannot invent cancellation')
})

test('diagnostics explain queued cancellation, replacement and close exactly once while old work drains', async () => {
  type Event = import('../../../../src/adapters/host/dsh/indexing-diagnostics.ts').PrefetchDiagnosticEvent
  const events: Event[] = [], gate = deferred()
  let documents = [document('a'), document('b')]
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }),
    async prepare() { await gate.promise }, onDiagnostic: event => events.push(event) })
  try {
    await turn()
    prefetch.cancel('session', 'b'); prefetch.cancel('session', 'b')
    prefetch.rebuild('session', 'a')
    documents = []; prefetch.refresh(); await turn()
    const cancellations = events.filter(event => event.event === 'cancelled')
    assert.deepEqual(cancellations.map(event => [event.documentId, event.occurrence, event.reason]),
      [['b', 2, 'user'], ['a', 1, 'replaced'], ['a', 3, 'closed']])
    gate.resolve(); await turn()
    assert.equal(events.filter(event => event.event === 'ready' || event.event === 'failed').length, 0)
  } finally { gate.resolve(); await prefetch.dispose() }
  assert.equal(events.filter(event => event.event === 'cancelled').length, 3)
})

test('diagnostics distinguish source replacement, configuration retirement, suspension and unloading', async () => {
  type Event = import('../../../../src/adapters/host/dsh/indexing-diagnostics.ts').PrefetchDiagnosticEvent
  for (const reason of ['replaced', 'configuration', 'settings-error', 'suspended', 'disposed'] as const) {
    const events: Event[] = [], gate = deferred()
    let source = document('a'), selected = true, throws = false
    const prefetch = createRetrievalPrefetch({ documents: () => [source, document('b')], selection() {
      if (throws) throw new Error('private configuration')
      return selected ? { identity: 'engine' } : undefined
    }, async prepare() { await gate.promise }, onDiagnostic: event => events.push(event) })
    try {
      await turn()
      if (reason === 'replaced') { source = { ...source, contentVersion: 'new' }; prefetch.refresh() }
      else if (reason === 'configuration') { selected = false; prefetch.refresh() }
      else if (reason === 'settings-error') { throws = true; prefetch.refresh() }
      else if (reason === 'suspended') void prefetch.suspend()
      else void prefetch.dispose()
      await turn()
      const cancellations = events.filter(event => event.event === 'cancelled')
      assert.equal(cancellations[0]?.reason, reason === 'settings-error' ? 'configuration' : reason)
      assert.ok(!cancellations.some((event, index) => cancellations.slice(index + 1).some(other => other.occurrence === event.occurrence)))
      if (reason === 'suspended') assert.equal(cancellations.length, 2, 'queued and running tasks both retain suspension reasons')
      if (reason === 'disposed') assert.equal(cancellations.length, 2, 'queued and running tasks both retain unload reasons')
    } finally { gate.resolve(); await prefetch.dispose() }
  }
})

test('plan-scoped diagnostics remain passive even when the observer rejects asynchronously', async () => {
  const events: string[] = []
  const prefetch = createRetrievalPrefetch({ documents: () => [document('a')],
    selection: () => ({ identity: 'engine', planId: 'saved-plan' }),
    async prepare(_session, input, _signal, report) {
      assert.equal(input.indexPlanId, 'saved-plan')
      report!({ indexedPages: 1, totalPages: 1, embeddedChunks: 0, totalChunks: 0, phase: 'ready' })
    }, async onDiagnostic(event) { events.push(event.event); throw new Error('isolated asynchronous observer') } })
  try {
    await turn()
    assert.equal(prefetch.status().documents[0]?.state, 'ready')
    assert.deepEqual(events, ['queued', 'started', 'progress', 'ready'])
  } finally { await prefetch.dispose() }
})
