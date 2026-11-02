import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalPrefetch } from '../../../../src/adapters/host/dsh/retrieval-prefetch.ts'
import type { PrefetchDiagnosticEvent } from '../../../../src/adapters/host/dsh/indexing-diagnostics.ts'
import type { RetrievalProgress } from '../../../../src/modules/retrieval/index.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const document = (id: string) => ({ sessionId: 'session', id, contentVersion: 'content-1', sourceDigest: 'source-1', conflict: false })
const legacyPrepare = async () => { assert.fail('A sliced scheduler must not invoke full preparation') }

test('cooperative quanta let a cached document finish before a large OCR document and preserve its occurrence', async () => {
  const documents = [document('large'), document('cached')], calls: string[] = [], events: PrefetchDiagnosticEvent[] = []
  const first = deferred(), last = deferred()
  let largeSlices = 0
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine', planId: 'plan' }),
    prepare: legacyPrepare,
    async prepareSlice(_sessionId, input) {
      calls.push(input.documentId)
      assert.equal(input.indexPlanId, 'plan')
      if (input.documentId === 'cached') return true
      if (++largeSlices === 1) { await first.promise; return false }
      await last.promise; return true
    }, onDiagnostic: event => { events.push(event) } })
  try {
    await turn()
    const occurrence = prefetch.status().documents.find(entry => entry.id === 'large')!.occurrence
    first.resolve(); await turn(); await turn()
    assert.deepEqual(calls, ['large', 'cached', 'large'])
    const snapshot = prefetch.status()
    assert.equal(snapshot.documents.find(entry => entry.id === 'cached')!.state, 'ready')
    assert.equal(snapshot.documents.find(entry => entry.id === 'large')!.occurrence, occurrence)
    assert.equal(events.filter(event => event.documentId === 'large' && event.event === 'started').length, 1)
    assert.equal(events.some(event => event.event === 'failed' || event.event === 'cancelled'), false)
    last.resolve(); await turn()
    assert.ok(prefetch.status().documents.every(entry => entry.state === 'ready'))
  } finally { first.resolve(); last.resolve(); await prefetch.dispose() }
})

test('manual requests overtake automatic work but a repeated stream cannot starve an admitted document', async () => {
  const documents = [document('first'), document('automatic'), document('manual-a'), document('manual-b')]
  const calls: string[] = [], gates = Array.from({ length: 5 }, deferred)
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }), prepare: legacyPrepare,
    async prepareSlice(_sessionId, input) {
      const index = calls.length; calls.push(input.documentId)
      await gates[index]!.promise
      return false
    } })
  try {
    await turn()
    const before = prefetch.status().documents.map(entry => [entry.id, entry.occurrence])
    prefetch.start('session', 'manual-a')
    gates[0]!.resolve(); await turn(); await turn()
    assert.deepEqual(calls, ['first', 'manual-a'])
    prefetch.start('session', 'manual-b')
    gates[1]!.resolve(); await turn(); await turn()
    assert.equal(calls[2], 'manual-b')
    prefetch.start('session', 'manual-a')
    gates[2]!.resolve(); await turn(); await turn()
    assert.equal(calls[3], 'automatic', 'after two boosts, the oldest admitted automatic task must run')
    assert.deepEqual(prefetch.status().documents.map(entry => [entry.id, entry.occurrence]), before,
      'boosting an existing task does not replace its durable occurrence')
  } finally {
    const drain = prefetch.dispose()
    for (const gate of gates) gate.resolve()
    await drain
  }
})

test('cancelling a yielded quantum preserves its stopped occurrence and does not report a failure', async () => {
  const documents = [document('yielded'), document('blocking')], gate = deferred(), events: PrefetchDiagnosticEvent[] = []
  const calls: string[] = []
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }), prepare: legacyPrepare,
    async prepareSlice(_sessionId, input) {
      calls.push(input.documentId)
      if (input.documentId === 'yielded') return false
      await gate.promise; return true
    }, onDiagnostic: event => { events.push(event) } })
  try {
    await turn(); await turn()
    assert.deepEqual(calls, ['yielded', 'blocking'])
    const occurrence = prefetch.status().documents[0]!.occurrence
    prefetch.cancel('session', 'yielded'); gate.resolve(); await turn(); await turn()
    assert.deepEqual(calls, ['yielded', 'blocking'])
    assert.equal(prefetch.status().documents[0]!.occurrence, occurrence)
    assert.equal(prefetch.status().documents[0]!.state, 'cancelled')
    assert.equal(events.some(event => event.event === 'failed'), false)
  } finally { gate.resolve(); await prefetch.dispose() }
})

test('source replacement during a noncooperative quantum drains the old work before admitting the new source', async () => {
  const documents = [document('changing')], gate = deferred(), calls: AbortSignal[] = [], events: PrefetchDiagnosticEvent[] = []
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine', planId: 'same-plan' }),
    prepare: legacyPrepare, async prepareSlice(_sessionId, _input, active) {
      calls.push(active)
      if (calls.length === 1) await gate.promise
      return true
    }, onDiagnostic: event => { events.push(event) } })
  try {
    await turn()
    documents[0]!.sourceDigest = 'source-2'; documents[0]!.contentVersion = 'content-2'; prefetch.refresh(); await turn()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.aborted, true)
    gate.resolve(); await turn()
    assert.equal(calls.length, 2)
    assert.equal(prefetch.status().documents[0]!.state, 'ready')
    assert.deepEqual(events.filter(event => event.event === 'cancelled').map(event => event.reason), ['replaced'])
    assert.equal(events.some(event => event.event === 'failed'), false)
  } finally { gate.resolve(); await prefetch.dispose() }
})

test('disposal drains an active sliced operation even if it ignores cancellation', async () => {
  const gate = deferred(), entered = deferred()
  let active!: AbortSignal, finished = false
  const prefetch = createRetrievalPrefetch({ documents: () => [document('large')], selection: () => ({ identity: 'engine' }),
    prepare: legacyPrepare, async prepareSlice(_sessionId, _input, signal) {
      active = signal; entered.resolve(); await gate.promise; return false
    } })
  await entered.promise
  const draining = prefetch.dispose().then(() => { finished = true })
  assert.equal(active.aborted, true)
  await turn(); assert.equal(finished, false)
  gate.resolve(); await draining; await turn()
  assert.equal(finished, true)
  assert.equal(prefetch.status().state, 'disposed')
  prefetch.subscribe(() => { assert.fail('Disposed schedulers cannot add observers') })()
  await prefetch.suspend()
})

test('a burst of manual requests remains within the document budget and preserves the last explicit plan', async () => {
  const documents = [document('active'), document('middle'), document('last')], gate = deferred(), calls: string[] = []
  let brokenSelection = false
  const prefetch = createRetrievalPrefetch({ documents: () => documents, maxDocuments: 1,
    selection() {
      if (brokenSelection) throw new Error('Invalid saved configuration')
      return { identity: 'engine', planId: 'durable-plan' }
    }, prepare: legacyPrepare, async prepareSlice(_sessionId, input) {
      calls.push(input.documentId); assert.equal(input.indexPlanId, 'durable-plan')
      if (input.documentId === 'active') await gate.promise
      return true
    } })
  try {
    await turn()
    brokenSelection = true
    assert.throws(() => prefetch.start('session', 'middle'), { code: 'pdf/retrieval-engine-unavailable' })
    brokenSelection = false
    prefetch.start('session', 'middle'); prefetch.start('session', 'last')
    assert.equal(prefetch.status().documents.length, 1)
    assert.equal(prefetch.status().documents[0]!.id, 'last')
    gate.resolve(); await turn()
    assert.deepEqual(calls, ['active', 'last'])
  } finally { gate.resolve(); await prefetch.dispose() }
})

test('vector work counts accumulate once across quanta, remain bounded while restoring and restart for a fresh occurrence', async () => {
  const gate = deferred(), counts: Array<[number | undefined, number | undefined]> = []
  let slices = 0
  let previousProgress: ((progress: RetrievalProgress) => void) | undefined
  const prefetch = createRetrievalPrefetch({ documents: () => [document('book')], selection: () => ({ identity: 'engine' }), prepare: legacyPrepare,
    async prepareSlice(_sessionId, _input, _active, progress) {
      const emit = (embeddedChunks: number, computedChunks: number) => progress?.({ indexedPages: 1, totalPages: 2,
        embeddedChunks, totalChunks: 5, computedChunks, reusedChunks: embeddedChunks - computedChunks })
      if (++slices === 1) { previousProgress = progress; emit(3, 2); emit(3, 2); return false }
      if (slices === 2) {
        emit(1, 0); emit(3, 0)
        previousProgress?.({ indexedPages: 2, totalPages: 2, embeddedChunks: 5, totalChunks: 5, computedChunks: 5, reusedChunks: 0 })
        emit(4, 1); emit(4, 1); emit(5, 2); await gate.promise; return true
      }
      emit(5, 1); return true
    }, onDiagnostic(event) {
      if (event.event === 'progress') counts.push([event.progress?.computedChunks, event.progress?.reusedChunks])
    } })
  try {
    await turn(); await turn()
    assert.deepEqual(counts, [[2, 1], [2, 1], [1, 0], [2, 1], [3, 1], [3, 1], [4, 1]],
      'repeated progress must not be counted twice, and a late callback from a prior quantum cannot overwrite the current one')
    gate.resolve(); await turn()
    const completed = prefetch.status().documents[0]!
    assert.equal(completed.state, 'ready')
    assert.equal(completed.progress!.computedChunks, 4)
    prefetch.rebuild('session', 'book'); await turn()
    const rebuilt = prefetch.status().documents[0]!
    assert.notEqual(rebuilt.occurrence, completed.occurrence)
    assert.equal(rebuilt.progress!.computedChunks, 1)
    assert.equal(rebuilt.progress!.reusedChunks, 4)
  } finally { gate.resolve(); await prefetch.dispose() }
})
