import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfIndexingApi } from '../../../../src/adapters/client/remote/indexing.ts'
import type { PdfIndexingSnapshot } from '../../../../src/contracts/indexing.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const snapshot = (state: 'running' | 'cancelled'): PdfIndexingSnapshot => ({ revision: state, enabled: true,
  tasks: [{ documentId: 'document', title: 'reader.pdf', state, occurrence: 1,
    progress: { indexedPages: 1, totalPages: 3, embeddedChunks: 0, totalChunks: 2,
      phase: 'restoring', reusedChunks: 0, computedChunks: 0 } }] })
const ok = (value: PdfIndexingSnapshot) => ({ ok: true, value })

test('PDF views share one session subscription and manual actions immediately publish validated progress', async () => {
  const lifetime = new AbortController(), requests: unknown[] = []
  const api = createPdfIndexingApi({ rpc: { async call(path, method, input) {
    assert.equal(path, '/api'); assert.equal(method, 'pdf.indexing'); requests.push(input)
    return ok(snapshot((input as { action: string }).action === 'cancel' ? 'cancelled' : 'running'))
  } } }, lifetime.signal)
  const stop = api.subscribe('session', () => {}), stopAgain = api.subscribe('session', () => {})
  try {
    assert.equal(api.getSnapshot('session').status, 'loading')
    await turn()
    assert.equal(api.getSnapshot('session').status, 'ready')
    assert.equal(api.getSnapshot('session').tasks[0]!.progress!.indexedPages, 1)
    assert.equal(api.getSnapshot('session').tasks[0]!.progress!.phase, 'restoring')
    assert.equal(api.getSnapshot('session').tasks[0]!.progress!.computedChunks, 0)
    assert.equal(requests.length, 1, 'two PDF views share the same in-flight polling lane')
    await api.cancel('session', 'document', lifetime.signal)
    assert.equal(api.getSnapshot('session').tasks[0]!.state, 'cancelled')
    assert.deepEqual(requests[1], { action: 'cancel', sessionId: 'session', documentId: 'document' })
    assert.equal(api.getSnapshot('other-session').status, 'loading')
  } finally { stop(); stopAgain(); api.dispose(); lifetime.abort() }
})

test('a late pre-action status reply cannot overwrite a cancelled task', async () => {
  const lifetime = new AbortController()
  let finish!: (value: unknown) => void
  const delayed = new Promise<unknown>(resolve => { finish = resolve })
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input) {
    return (input as { action: string }).action === 'status' ? delayed : ok(snapshot('cancelled'))
  } } }, lifetime.signal)
  const stop = api.subscribe('session', () => {})
  try {
    await api.cancel('session', 'document', lifetime.signal)
    finish(ok(snapshot('running'))); await turn()
    assert.equal(api.getSnapshot('session').tasks[0]!.state, 'cancelled')
  } finally { stop(); api.dispose(); lifetime.abort() }
})

test('reopening a view fetches an immediate snapshot before resuming change-only polling', async () => {
  const lifetime = new AbortController(), requests: unknown[] = []
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input) {
    requests.push(input)
    return ok(snapshot('running'))
  } } }, lifetime.signal)
  let stop = api.subscribe('session', () => {})
  try {
    await turn()
    assert.equal(api.getSnapshot('session').status, 'ready')
    stop()
    stop = api.subscribe('session', () => {})
    assert.equal(api.getSnapshot('session').status, 'loading')
    assert.deepEqual(requests[1], { action: 'status', sessionId: 'session' }, 'the cached revision must not delay the initial snapshot')
    await turn()
    assert.equal(api.getSnapshot('session').status, 'ready')
  } finally { stop(); api.dispose(); lifetime.abort() }
})

test('lost connections retain progress as unavailable, and aborted actions reject even non-cooperative RPCs', async () => {
  const lifetime = new AbortController()
  let mode: 'offline' | 'delay' = 'offline', finish!: (value: unknown) => void
  const api = createPdfIndexingApi({ rpc: { async call() {
    if (mode === 'offline') throw new Error('Disconnected')
    return new Promise(resolve => { finish = resolve })
  } } }, lifetime.signal)
  const stop = api.subscribe('session', () => {})
  try {
    await turn()
    assert.equal(api.getSnapshot('session').status, 'unavailable')
    mode = 'delay'
    const abort = new AbortController()
    const action = api.start('session', 'document', abort.signal)
    abort.abort(new Error('closed view'))
    await assert.rejects(action, /closed view/)
    finish(ok(snapshot('running'))); await turn()
    assert.equal(api.getSnapshot('session').status, 'unavailable')
  } finally { stop(); api.dispose(); lifetime.abort() }
})

test('completion dismissal is shared by views, survives status refreshes and never removes readiness', async () => {
  const lifetime = new AbortController(), requests: unknown[] = []
  let current: PdfIndexingSnapshot = { ...snapshot('running'), revision: 'ready',
    tasks: [{ ...snapshot('running').tasks[0]!, state: 'ready' }] }
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input) {
    requests.push(input)
    return ok(current)
  } } }, lifetime.signal)
  let firstNotifications = 0, secondNotifications = 0
  let stop = api.subscribe('session', () => { firstNotifications++ })
  const stopAgain = api.subscribe('session', () => { secondNotifications++ })
  const stopOther = api.subscribe('other-session', () => {})
  try {
    await turn()
    const beforeFirst = firstNotifications, beforeSecond = secondNotifications
    api.dismiss('session', 'document', 1)
    assert.equal(firstNotifications, beforeFirst + 1)
    assert.equal(secondNotifications, beforeSecond + 1)
    assert.deepEqual(api.getSnapshot('session').dismissed, { document: 1 })
    assert.equal(api.getSnapshot('session').tasks[0]!.state, 'ready', 'Done hides feedback, not the shared index')
    assert.equal(api.getSnapshot('other-session').dismissed?.document, undefined)
    api.dismiss('session', 'document', 1)
    api.dismiss('session', 'document', 999)
    assert.equal(firstNotifications, beforeFirst + 1, 'duplicate and stale dismissal actions are ignored')

    // A non-indexing action can return the same Host revision. It must not
    // replace locally acknowledged feedback with an unacknowledged copy.
    await api.start('session', 'document', lifetime.signal)
    assert.deepEqual(api.getSnapshot('session').dismissed, { document: 1 })
    current = { ...current, revision: 'another-document-progress' }
    await api.start('session', 'document', lifetime.signal)
    assert.deepEqual(api.getSnapshot('session').dismissed, { document: 1 })
    stop(); stop = api.subscribe('session', () => { firstNotifications++ })
    await turn()
    assert.deepEqual(api.getSnapshot('session').dismissed, { document: 1 }, 'reopening a view preserves the acknowledged occurrence')

    current = { ...current, revision: 'rebuild', tasks: [{ ...current.tasks[0]!, occurrence: 2, state: 'queued' }] }
    await api.rebuild('session', 'document', lifetime.signal)
    assert.deepEqual(requests.at(-1), { action: 'rebuild', sessionId: 'session', documentId: 'document' })
    assert.deepEqual(api.getSnapshot('session').dismissed, {}, 'a new occurrence can report progress and completion again')
    api.dismiss('session', 'document', 2)
    assert.deepEqual(api.getSnapshot('session').dismissed, {}, 'running and queued work cannot be hidden as completed')
    current = { ...current, revision: 'failed', tasks: [{ ...current.tasks[0]!, state: 'failed' }] }
    await api.start('session', 'document', lifetime.signal)
    assert.equal(api.getSnapshot('session').dismissed?.document, undefined, 'failures remain visible')
  } finally { stop(); stopAgain(); stopOther(); api.dispose(); lifetime.abort() }
})
