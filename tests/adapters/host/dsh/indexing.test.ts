import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfIndexing } from '../../../../src/adapters/host/dsh/indexing.ts'
import { createRetrievalPrefetch } from '../../../../src/adapters/host/dsh/retrieval-prefetch.ts'
import type { OpenWorkingCopyDocument } from '../../../../src/modules/working-copy/index.ts'
import type { RetrievalProgress } from '../../../../src/modules/retrieval/index.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
  let enabled = true
  const documents: OpenWorkingCopyDocument[] = ['first', 'second'].map((sessionId, i) => ({
    sessionId, id: `${sessionId}-pdf`, title: `${sessionId}.pdf`, conflict: false,
    contentVersion: 'v1', sourceDigest: `source-${i}`,
  }))
  const operations: Array<{ signal: AbortSignal; progress?: (progress: RetrievalProgress) => void }> = []
  const prefetch = createRetrievalPrefetch({ documents: () => documents,
    selection: () => enabled ? { identity: 'engine' } : undefined,
    async prepare(_session, _input, signal, progress) {
      operations.push({ signal, progress })
      progress?.({ indexedPages: 1, totalPages: 3, embeddedChunks: 0, totalChunks: 2 })
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        if (signal.aborted) resolve()
      })
    },
  })
  const indexing = createPdfIndexing(prefetch, { documents: () => documents, enabled: () => enabled })
  return { prefetch, indexing, documents, operations, disable() { enabled = false; prefetch.refresh(); indexing.changed() },
    async dispose() { indexing.dispose(); await prefetch.dispose() } }
}

test('indexing status is session-filtered, includes filenames/progress and wakes on own task changes', async () => {
  const f = fixture()
  try {
    await turn()
    const before = f.indexing.snapshot('first')
    assert.equal(before.tasks[0]!.title, 'first.pdf')
    assert.equal(before.tasks[0]!.progress?.indexedPages, 1)
    assert.equal(JSON.stringify(before).includes('second.pdf'), false)
    const waiting = f.indexing.dispatch('first', { action: 'status', sessionId: 'first', revision: before.revision }, new AbortController().signal)
    f.operations[0]!.progress!({ indexedPages: 2, totalPages: 3, embeddedChunks: 1, totalChunks: 4,
      phase: 'restoring', reusedChunks: 1, computedChunks: 0 })
    const advanced = await waiting
    assert.notEqual(advanced.revision, before.revision)
    assert.equal(advanced.tasks[0]!.progress!.indexedPages, 2)
    assert.equal(advanced.tasks[0]!.progress!.phase, 'restoring')
    assert.equal(advanced.tasks[0]!.progress!.reusedChunks, 1)
    assert.equal(advanced.tasks[0]!.progress!.computedChunks, 0)
    assert.equal(f.indexing.snapshot('second').tasks[0]!.state, 'queued')
  } finally { await f.dispose() }
})

test('manual controls cannot cross resource sessions and cancellation remains stopped until resumed', async () => {
  const f = fixture(), signal = new AbortController().signal
  try {
    await turn()
    await assert.rejects(f.indexing.dispatch('first', { action: 'cancel', sessionId: 'first', documentId: 'second-pdf' }, signal), { code: 'pdf/unknown-document' })
    await assert.rejects(f.indexing.dispatch('first', { action: 'rebuild', sessionId: 'first', documentId: 'second-pdf' }, signal), { code: 'pdf/unknown-document' })
    await assert.rejects(f.indexing.dispatch('first', { action: 'status', sessionId: 'second' }, signal), { code: 'pdf/session-mismatch' })
    await f.indexing.dispatch('first', { action: 'cancel', sessionId: 'first', documentId: 'first-pdf' }, signal)
    await turn(); f.prefetch.refresh(); await turn()
    assert.equal(f.indexing.snapshot('first').tasks[0]!.state, 'cancelled')
    const resumed = await f.indexing.dispatch('first', { action: 'start', sessionId: 'first', documentId: 'first-pdf' }, signal)
    assert.equal(resumed.tasks[0]!.state, 'queued')
    f.disable(); await turn()
    await assert.rejects(f.indexing.dispatch('first', { action: 'start', sessionId: 'first', documentId: 'first-pdf' }, signal), { code: 'pdf/retrieval-engine-unavailable' })
  } finally { await f.dispose() }
})

test('rebuilding a ready PDF schedules fresh work through the same session-filtered task directory', async () => {
  const documents = ['first', 'second'].map(sessionId => ({ sessionId, id: `${sessionId}-pdf`, title: `${sessionId}.pdf`,
    conflict: false, contentVersion: 'v1', sourceDigest: sessionId }))
  const calls: Array<{ sessionId: string; documentId: string; rebuild?: boolean }> = []
  const prefetch = createRetrievalPrefetch({ documents: () => documents, selection: () => ({ identity: 'engine' }),
    async prepare(sessionId, input) { calls.push({ sessionId, ...input }) } })
  const indexing = createPdfIndexing(prefetch, { documents: () => documents, enabled: () => true })
  try {
    await turn()
    const before = indexing.snapshot('first').tasks[0]!
    const other = indexing.snapshot('second')
    assert.equal(before.state, 'ready')
    await indexing.dispatch('first', { action: 'rebuild', sessionId: 'first', documentId: 'first-pdf' }, new AbortController().signal)
    await turn()
    const after = indexing.snapshot('first').tasks[0]!
    assert.equal(after.state, 'ready')
    assert.ok(after.occurrence > before.occurrence)
    assert.deepEqual(calls.at(-1), { sessionId: 'first', documentId: 'first-pdf', rebuild: true })
    assert.deepEqual(indexing.snapshot('second'), other)
  } finally { indexing.dispose(); await prefetch.dispose() }
})

test('another session progress does not release a long poll, and caller/disposal cancel it promptly', async () => {
  const f = fixture(), signal = new AbortController().signal
  try {
    await turn()
    await f.indexing.dispatch('first', { action: 'cancel', sessionId: 'first', documentId: 'first-pdf' }, signal)
    await turn()
    const before = f.indexing.snapshot('first'), abort = new AbortController()
    let completed = false
    const pending = f.indexing.dispatch('first', { action: 'status', sessionId: 'first', revision: before.revision }, abort.signal)
    const rejected = assert.rejects(pending, /stop polling/).then(() => { completed = true })
    f.operations[1]!.progress!({ indexedPages: 2, totalPages: 3, embeddedChunks: 1, totalChunks: 2 })
    await turn()
    assert.equal(completed, false)
    assert.equal(f.indexing.snapshot('first').revision, before.revision)
    abort.abort(new Error('stop polling')); await rejected
    const closing = f.indexing.dispatch('first', { action: 'status', sessionId: 'first', revision: before.revision }, signal)
    const closed = assert.rejects(closing, { code: 'pdf/cancelled' })
    f.indexing.dispose(); await closed
  } finally { await f.dispose() }
})
