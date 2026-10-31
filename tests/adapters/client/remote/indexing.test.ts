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

test('indexing snapshot capacity evicts an inactive session without losing an active view or watch', async () => {
  const lifetime = new AbortController()
  const activeRequests: AbortSignal[] = []
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input, signal) {
    if ((input as { action: string }).action === 'status') {
      assert.ok(signal); activeRequests.push(signal)
      return new Promise<unknown>(() => {})
    }
    return ok(snapshot('running'))
  } } }, lifetime.signal)
  const stop = api.subscribe('visible-session', () => {})
  try {
    const active = api.getSnapshot('visible-session')
    await api.start('closed-session', 'document', lifetime.signal)
    const inactive = api.getSnapshot('closed-session')
    assert.equal(inactive.status, 'ready')
    for (let index = 0; index < 30; index++) api.getSnapshot(`dormant-${index}`)
    api.getSnapshot('new-session')
    assert.equal(api.getSnapshot('visible-session'), active)
    assert.equal(activeRequests.length, 1, 'capacity pressure must not replace an active subscription')
    assert.equal(activeRequests[0]!.aborted, false)
    const reopened = api.getSnapshot('closed-session')
    assert.notEqual(reopened, inactive, 'the oldest inactive snapshot is evicted at the directory limit')
    assert.equal(reopened.status, 'loading', 'a retired session cannot expose stale progress when opened again')
  } finally { stop(); api.dispose(); lifetime.abort(); await turn() }
})

test('indexing snapshot capacity preserves every live subscription when no inactive entry can be evicted', async () => {
  const lifetime = new AbortController(), requests: AbortSignal[] = [], stops: (() => void)[] = []
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, _input, signal) {
    assert.ok(signal); requests.push(signal)
    return new Promise<unknown>(() => {})
  } } }, lifetime.signal)
  try {
    for (let index = 0; index < 32; index++) stops.push(api.subscribe(`visible-${index}`, () => {}))
    const snapshots = Array.from({ length: 32 }, (_, index) => api.getSnapshot(`visible-${index}`))
    stops.push(api.subscribe('additional-visible-session', () => {}))
    for (let index = 0; index < 32; index++) assert.equal(api.getSnapshot(`visible-${index}`), snapshots[index])
    assert.equal(requests.length, 33)
    assert.ok(requests.every(signal => !signal.aborted), 'the inactive cache budget must never cancel a live view')
  } finally { stops.forEach(stop => stop()); api.dispose(); lifetime.abort(); await turn() }
})

const defaultPolicy = { embeddingEngine: 'embedding', ocrEngine: 'ocr', imageEngine: 'image',
  indexScanPages: false, indexImageDescriptions: false }
const customPolicy = { embeddingEngine: 'another-embedding', ocrEngine: 'another-ocr', imageEngine: 'another-image',
  indexScanPages: true, indexImageDescriptions: true }
const documentSnapshot = (revision: string, settingsRevision: number, pending = false): PdfIndexingSnapshot => ({
  ...snapshot('running'), revision,
  documents: [{ documentId: 'document', revision: settingsRevision, policy: pending ? customPolicy : defaultPolicy,
    activePolicy: defaultPolicy, pending, impact: pending ? 'embedding' : 'none' }],
})

test('document configuration and defaults update every view through the shared session snapshot', async () => {
  const lifetime = new AbortController(), requests: object[] = []
  const api = createPdfIndexingApi({ rpc: { async call(path, method, input) {
    assert.equal(path, '/api'); assert.equal(method, 'pdf.indexing'); requests.push(input)
    const action = (input as { action: string }).action
    return ok(action === 'configure' ? documentSnapshot('configured', 8, true)
      : action === 'defaults' ? documentSnapshot('defaults', 9) : documentSnapshot('initial', 7))
  } } }, lifetime.signal)
  let firstNotifications = 0, secondNotifications = 0
  const stop = api.subscribe('session', () => { firstNotifications++ })
  const stopAgain = api.subscribe('session', () => { secondNotifications++ })
  const stopOther = api.subscribe('other-session', () => {})
  try {
    await turn()
    const other = api.getSnapshot('other-session')
    const first = firstNotifications, second = secondNotifications
    await api.configure('session', 'document', 7, customPolicy, lifetime.signal)
    assert.deepEqual(requests.at(-1), { action: 'configure', sessionId: 'session', documentId: 'document', revision: 7, policy: customPolicy })
    assert.equal(firstNotifications, first + 1)
    assert.equal(secondNotifications, second + 1)
    assert.deepEqual(api.getSnapshot('session').documents, documentSnapshot('configured', 8, true).documents,
      'Host-provided active and pending policies remain distinct until indexing applies them')
    assert.equal(api.getSnapshot('other-session'), other, 'the same document ID in another Session has separate state')

    await api.useDefaults('session', 'document', 8, lifetime.signal)
    assert.deepEqual(requests.at(-1), { action: 'defaults', sessionId: 'session', documentId: 'document', revision: 8 })
    assert.deepEqual(api.getSnapshot('session').documents, documentSnapshot('defaults', 9).documents)
    assert.equal(firstNotifications, first + 2)
    assert.equal(secondNotifications, second + 2)
  } finally { stop(); stopAgain(); stopOther(); api.dispose(); lifetime.abort() }
})

test('a late status or configuration reply cannot replace a newer defaults snapshot', async () => {
  const lifetime = new AbortController()
  let finishStatus!: (value: unknown) => void, finishConfigure!: (value: unknown) => void
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input) {
    const action = (input as { action: string }).action
    if (action === 'status') return new Promise(resolve => { finishStatus = resolve })
    if (action === 'configure') return new Promise(resolve => { finishConfigure = resolve })
    return ok(documentSnapshot('defaults', 9))
  } } }, lifetime.signal)
  const stop = api.subscribe('session', () => {})
  try {
    const configured = api.configure('session', 'document', 7, customPolicy, lifetime.signal)
    await api.useDefaults('session', 'document', 8, lifetime.signal)
    const current = api.getSnapshot('session')
    finishStatus(ok(documentSnapshot('initial', 7)))
    finishConfigure(ok(documentSnapshot('configured', 8, true)))
    await configured; await turn()
    assert.equal(api.getSnapshot('session'), current)
    assert.equal(current.documents![0]!.pending, false)
    assert.equal(current.documents![0]!.revision, 9)
  } finally { stop(); api.dispose(); lifetime.abort() }
})

test('invalid document settings and Host configuration errors never replace the last valid policy', async () => {
  const lifetime = new AbortController()
  let failure: 'shape' | 'engine' = 'shape'
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input) {
    if ((input as { action: string }).action === 'status') return ok(documentSnapshot('initial', 7))
    if (failure === 'engine') return { ok: false, error: { code: 'PDF_INDEX_ENGINE_UNAVAILABLE', message: 'The engine was unloaded' } }
    const invalid = documentSnapshot('invalid', 8, true)
    return ok({ ...invalid, documents: [{ ...invalid.documents![0], policy: { ...customPolicy, apiKey: 'must-not-enter-policy' } }] } as unknown as PdfIndexingSnapshot)
  } } }, lifetime.signal)
  const stop = api.subscribe('session', () => {})
  try {
    await turn()
    const current = api.getSnapshot('session')
    await assert.rejects(api.configure('session', 'document', 7, customPolicy, lifetime.signal), /Unrecognized key/)
    assert.equal(api.getSnapshot('session'), current, 'strict policy parsing excludes credentials and unknown configuration')
    failure = 'engine'
    await assert.rejects(api.useDefaults('session', 'document', 7, lifetime.signal), error =>
      error instanceof Error && 'code' in error && error.code === 'PDF_INDEX_ENGINE_UNAVAILABLE')
    assert.equal(api.getSnapshot('session'), current, 'unloading an engine must not silently select a fallback policy')
  } finally { stop(); api.dispose(); lifetime.abort() }
})

test('cancelling a document configuration keeps other views watching and ignores its late non-cooperative reply', async () => {
  const lifetime = new AbortController(), caller = new AbortController()
  let watchSignal!: AbortSignal, configureSignal!: AbortSignal, finishConfigure!: (value: unknown) => void
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, input, signal) {
    assert.ok(signal)
    if ((input as { action: string }).action === 'status') { watchSignal = signal; return ok(documentSnapshot('initial', 7)) }
    configureSignal = signal
    return new Promise(resolve => { finishConfigure = resolve })
  } } }, lifetime.signal)
  const stop = api.subscribe('session', () => {}), stopAgain = api.subscribe('session', () => {})
  try {
    await turn()
    const current = api.getSnapshot('session')
    const action = api.configure('session', 'document', 7, customPolicy, caller.signal)
    caller.abort(new Error('view closed'))
    await assert.rejects(action, /view closed/)
    assert.equal(configureSignal.aborted, true)
    assert.equal(watchSignal.aborted, false, 'one view does not own the shared Session subscription')
    finishConfigure(ok(documentSnapshot('configured', 8, true))); await turn()
    assert.equal(api.getSnapshot('session'), current)
  } finally { stop(); stopAgain(); api.dispose(); lifetime.abort() }
})

for (const ending of ['dispose', 'lifetime'] as const) test(`indexing ${ending} cancels in-flight defaults and blocks new configuration requests`, async () => {
  const lifetime = new AbortController(), caller = new AbortController()
  let requests = 0, requestSignal!: AbortSignal, finish!: (value: unknown) => void
  const api = createPdfIndexingApi({ rpc: { async call(_path, _method, _input, signal) {
    requests++; assert.ok(signal); requestSignal = signal
    return new Promise(resolve => { finish = resolve })
  } } }, lifetime.signal)
  try {
    const action = api.useDefaults('session', 'document', 7, caller.signal)
    if (ending === 'dispose') api.dispose()
    else lifetime.abort()
    await assert.rejects(action, error => error instanceof DOMException && error.name === 'AbortError')
    assert.equal(requestSignal.aborted, true)
    finish(ok(documentSnapshot('defaults', 8))); await turn()
    await assert.rejects(api.configure('session', 'document', 7, customPolicy, caller.signal), error =>
      error instanceof DOMException && error.name === 'AbortError')
    assert.equal(requests, 1, 'unloaded adapters cannot create another Host operation')
  } finally { api.dispose(); lifetime.abort() }
})
