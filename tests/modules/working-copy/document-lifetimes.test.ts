import assert from 'node:assert/strict'
import test from 'node:test'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import type { PdfDocumentInfo } from '../../../src/core/pdf-types.ts'
import { digestPdfBytes } from '../../../src/modules/document/index.ts'
import { createWorkingCopyService, type DraftRecord, type WorkingCopyFilePort } from '../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
const sessionId = 'document-lifetimes'
const path = '/shared.pdf'
const agent = { session: { id: sessionId, header: { cwd: '/' } } }
const address = (session = sessionId) => `dsh-resource://file/session/${session}/%2Fshared.pdf`
const document: PdfDocumentInfo = {
  pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
  annotations: [], signed: false, encrypted: false, readOnly: false,
}

function setup() {
  const records = new Map<string, DraftRecord>()
  const drafts = createV1DraftRepository({
    get: key => records.get(key),
    async put(key, value) { records.set(key, structuredClone(value)) },
    async delete(key) { records.delete(key) },
  })
  let source: Uint8Array | undefined = Uint8Array.from([1, 2, 3])
  const files: WorkingCopyFilePort = {
    async resolvePath() { return path },
    async read() {
      if (!source) throw Object.assign(new Error('missing'), { code: 'PDF_NOT_FOUND' })
      return { path, bytes: source, version: digestPdfBytes(source), fsVersion: 'fs-1', size: source.length }
    },
    async save(_agent, target, bytes) {
      source = bytes
      return { path: target, version: digestPdfBytes(bytes), fsVersion: 'fs-2', size: bytes.length }
    },
  }
  const service = createWorkingCopyService(files, drafts, {
    async inspect() { return document },
    async materialize(bytes) { return { bytes, document } },
  })
  const open = async (owner: 'agent' | 'ui' = 'agent', referenceId?: string) => {
    const result = await service.execute(sessionId, { action: 'open', sessionId, address: address(), owner, referenceId }, agent, signal)
    assert.ok('document' in result)
    return result
  }
  const add = async (id: string, revision: number) => {
    const result = await service.execute(sessionId, { action: 'change', sessionId, id, revision,
      operations: [{ type: 'add', annotation: { id: 'shared-note', page: 1, subtype: 'Text',
        rect: [10, 10, 20, 20], contents: 'Shared draft' } }] }, agent, signal)
    assert.ok('document' in result)
    return result
  }
  return { service, records, drafts, open, add, removeSource() { source = undefined }, changeSource() { source = Uint8Array.from([4, 5, 6]) } }
}

test('pure background document is adopted by UI with the same identity, draft and revision stream', async () => {
  const { service, open, add, records } = setup()
  try {
    const background = await open()
    assert.equal(service.isUiOwned(sessionId, background.id), false)
    const edited = await add(background.id, background.revision)
    const ui = await open('ui', 'tab-one')
    assert.equal(ui.id, background.id)
    assert.equal(ui.revision, edited.revision)
    assert.equal(ui.document.annotations[0]?.contents, 'Shared draft')
    const watching = service.waitForRevision(sessionId, ui.id, ui.revision, signal)
    const undone = await service.execute(sessionId, { action: 'undo', sessionId, id: ui.id, revision: ui.revision }, agent, signal)
    assert.ok('document' in undone)
    assert.equal(await watching, undone.revision)
    assert.equal(service.readSnapshot(sessionId, ui.id).document.annotations.length, 0)
    assert.equal(service.listDocuments().length, 1)
    assert.ok(records.size > 0, 'the shared undo branch remains durable')
  } finally { await service.dispose() }
})

test('suspension reclaims bytes without invalidating IDs or changing revisions and restores the saved undo branch', async () => {
  const { service, open, add } = setup()
  try {
    const original = await open()
    const changed = await add(original.id, original.revision)
    let nativeEvictions = 0
    assert.equal(await service.suspend(sessionId, changed.id, async () => { nativeEvictions += 1 }), 'released')
    assert.deepEqual(service.listDocuments().map(value => [value.id, value.resident, value.bytes]), [[changed.id, false, 0]])
    assert.throws(() => service.readSnapshot(sessionId, changed.id), { code: 'pdf/document-suspended' })
    const release = await service.acquire(sessionId, changed.id, agent, signal)
    try {
      const resumed = service.readSnapshot(sessionId, changed.id)
      assert.equal(resumed.id, changed.id)
      assert.equal(resumed.revision, changed.revision)
      assert.equal(resumed.contentVersion, changed.contentVersion)
      assert.equal(resumed.document.annotations[0]?.contents, 'Shared draft')
      assert.equal(await service.suspend(sessionId, changed.id), 'retained-operation')
    } finally { release(); release() }
    const adopted = await open('ui', 'reader')
    assert.equal(adopted.id, changed.id)
    assert.equal(adopted.revision, changed.revision)
    assert.equal(nativeEvictions, 1)
  } finally { await service.dispose() }
})

test('clean suspension keeps original bytes after external deletion without creating a persisted user draft', async () => {
  const { service, open, records, drafts, removeSource } = setup()
  const original = await open()
  assert.equal(await service.suspend(sessionId, original.id), 'released')
  assert.equal(drafts.get(drafts.key(sessionId, path)), undefined)
  assert.equal(records.size, 1, 'only a temporary baseline is stored')
  removeSource()
  const release = await service.acquire(sessionId, original.id, agent, signal)
  const restored = service.readSnapshot(sessionId, original.id)
  assert.equal(restored.revision, original.revision)
  assert.equal(restored.contentVersion, original.contentVersion)
  assert.equal(restored.conflict, true)
  assert.deepEqual([...restored.bytes], [...original.bytes])
  release()
  await service.dispose()
  assert.equal(records.size, 0, 'unused cache baselines are removed during disposal')
})

test('a cache baseline promoted to an edited draft survives service disposal', async () => {
  const { service, open, add, records, drafts } = setup()
  const original = await open()
  await service.suspend(sessionId, original.id)
  const release = await service.acquire(sessionId, original.id, agent, signal)
  await add(original.id, original.revision)
  release()
  await service.dispose()
  const saved = drafts.get(drafts.key(sessionId, path))
  assert.ok(saved?.baseKey)
  assert.ok(records.get(saved.baseKey)?.original, 'durable edits retain their cache-origin baseline')
})

test('named UI references are idempotent and each view releases independently without deleting drafts', async () => {
  const { service, open, add, records } = setup()
  try {
    const first = await open('ui', 'tab-a')
    await open('ui', 'tab-a')
    await open('ui', 'tab-b')
    const changed = await add(first.id, first.revision)
    assert.equal(service.listDocuments()[0]?.uiReferences, 2)
    const releaseA = { action: 'release', sessionId, id: first.id, referenceId: 'tab-a' }
    await service.execute(sessionId, releaseA, agent, signal)
    await service.execute(sessionId, releaseA, agent, signal)
    assert.equal(service.listDocuments()[0]?.uiReferences, 1)
    assert.equal(await service.releaseBackground(sessionId, first.id), 'retained-ui')
    assert.equal(service.readSnapshot(sessionId, first.id).revision, changed.revision)
    await service.execute(sessionId, { ...releaseA, referenceId: 'tab-b' }, agent, signal)
    assert.equal(service.isUiOwned(sessionId, first.id), false)
    assert.equal(await service.suspend(sessionId, first.id), 'released')
    assert.ok(records.size > 0)
    const reopened = await open('ui', 'tab-c')
    assert.equal(reopened.id, first.id)
    assert.equal(reopened.document.annotations[0]?.contents, 'Shared draft')
  } finally { await service.dispose() }
})

test('acquisition queues behind native eviction and pins the complete operation until its explicit release', async () => {
  const { service, open } = setup()
  try {
    const opened = await open()
    let finishEviction!: () => void
    let startedEviction!: () => void
    const started = new Promise<void>(resolve => { startedEviction = resolve })
    const eviction = service.suspend(sessionId, opened.id, async () => {
      startedEviction()
      await new Promise<void>(resolve => { finishEviction = resolve })
    })
    await started
    let acquired = false
    const pending = service.acquire(sessionId, opened.id, agent, signal).then(release => { acquired = true; return release })
    await Promise.resolve()
    assert.equal(acquired, false)
    finishEviction()
    assert.equal(await eviction, 'released')
    const release = await pending
    assert.equal(service.listDocuments()[0]?.pins, 1)
    assert.equal(await service.releaseBackground(sessionId, opened.id), 'retained-operation')
    assert.equal(service.readSnapshot(sessionId, opened.id).id, opened.id)
    release()
    assert.equal(service.listDocuments()[0]?.pins, 0)
    assert.equal(await service.suspend(sessionId, opened.id), 'released')
  } finally { await service.dispose() }
})

test('failed cache eviction retains the resident document; cancelled acquisitions release pins', async () => {
  const { service, open } = setup()
  try {
    const opened = await open()
    await assert.rejects(service.suspend(sessionId, opened.id, async () => { throw new Error('native busy') }), /native busy/)
    assert.equal(service.readSnapshot(sessionId, opened.id).id, opened.id)
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled tool'))
    await assert.rejects(service.acquire(sessionId, opened.id, agent, aborted.signal), /cancelled tool/)
    assert.equal(service.listDocuments()[0]?.pins, 0)
  } finally { await service.dispose() }
})

test('cancellation while acquisition waits for eviction does not leak an operation pin or reactivate the document', async () => {
  const { service, open } = setup()
  try {
    const opened = await open()
    let finishEviction!: () => void
    let startedEviction!: () => void
    const started = new Promise<void>(resolve => { startedEviction = resolve })
    const eviction = service.suspend(sessionId, opened.id, async () => {
      startedEviction()
      await new Promise<void>(resolve => { finishEviction = resolve })
    })
    await started
    const abort = new AbortController()
    const acquisition = service.acquire(sessionId, opened.id, agent, abort.signal)
    abort.abort(new Error('tool cancelled while waiting'))
    finishEviction()
    await eviction
    await assert.rejects(acquisition, /tool cancelled while waiting/)
    assert.equal(service.listDocuments()[0]?.pins, 0)
    assert.equal(service.listDocuments()[0]?.resident, false)
  } finally { await service.dispose() }
})

test('refresh is ownership-neutral and document references remain isolated by resource session', async () => {
  const { service, open } = setup()
  try {
    const opened = await open()
    await service.execute(sessionId, { action: 'refresh', sessionId, id: opened.id }, agent, signal)
    assert.equal(service.isUiOwned(sessionId, opened.id), false)
    const otherSession = 'another-session'
    const otherAgent = { session: { id: otherSession, header: { cwd: '/' } } }
    const other = await service.execute(otherSession, { action: 'open', sessionId: otherSession,
      address: address(otherSession), owner: 'agent' }, otherAgent, signal)
    assert.ok('document' in other)
    assert.notEqual(other.id, opened.id)
    await assert.rejects(service.acquire(otherSession, opened.id, otherAgent, signal), { code: 'pdf/session-mismatch' })
    await assert.rejects(service.execute(otherSession, { action: 'release', sessionId: otherSession,
      id: opened.id, referenceId: 'some-tab' }, otherAgent, signal), { code: 'pdf/session-mismatch' })
    assert.equal(service.listDocuments().length, 2)
  } finally { await service.dispose() }
})

test('closing a UI occurrence without a document ID releases lost replies and fences delayed opens', async () => {
  const { service, open, add } = setup()
  try {
    const opened = await open('ui', 'lost-open-reply')
    await add(opened.id, opened.revision)
    await open('ui', 'other-view')
    const closing = { action: 'release', sessionId, referenceId: 'lost-open-reply' }
    await service.execute(sessionId, closing, agent, signal)
    await service.execute(sessionId, closing, agent, signal)
    assert.equal(service.listDocuments()[0]?.uiReferences, 1)
    await assert.rejects(open('ui', 'lost-open-reply'), { code: 'pdf/reference-released' })
    const other = await open('ui', 'other-view')
    assert.equal(other.id, opened.id)
    assert.equal(other.document.annotations[0]?.contents, 'Shared draft')
    assert.equal((await open('ui', 'new-view')).id, opened.id)
  } finally { await service.dispose() }
})

test('terminal release before an open prevents resurrection while same-token references in another session remain valid', async () => {
  const { service, open } = setup()
  try {
    await service.execute(sessionId, { action: 'release', sessionId, referenceId: 'closed-before-open' }, agent, signal)
    await assert.rejects(open('ui', 'closed-before-open'), { code: 'pdf/reference-released' })
    assert.equal(service.listDocuments().length, 0)
    const otherSession = 'independent-resource-session'
    const otherAgent = { session: { id: otherSession, header: { cwd: '/' } } }
    const other = await service.execute(otherSession, { action: 'open', sessionId: otherSession,
      address: address(otherSession), owner: 'ui', referenceId: 'closed-before-open' }, otherAgent, signal)
    assert.ok('document' in other)
    assert.equal(service.isUiOwned(otherSession, other.id), true)
  } finally { await service.dispose() }
})

test('revision waiters survive suspension and observe a model edit after reacquiring the same document ID', async () => {
  const { service, open, add } = setup()
  try {
    const opened = await open()
    const waiting = service.waitForRevision(sessionId, opened.id, opened.revision, signal)
    await service.suspend(sessionId, opened.id)
    const release = await service.acquire(sessionId, opened.id, agent, signal)
    try {
      const changed = await add(opened.id, opened.revision)
      assert.equal(await waiting, changed.revision)
      assert.equal(changed.id, opened.id)
    } finally { release() }
  } finally { await service.dispose() }
})

test('resuming dormant drafts preserves external-source conflict while clean documents adopt the changed source', async () => {
  const clean = setup()
  try {
    const original = await clean.open()
    await clean.service.suspend(sessionId, original.id)
    clean.changeSource()
    const release = await clean.service.acquire(sessionId, original.id, agent, signal)
    try {
      const refreshed = clean.service.readSnapshot(sessionId, original.id)
      assert.equal(refreshed.id, original.id)
      assert.equal(refreshed.revision, original.revision + 1)
      assert.notEqual(refreshed.contentVersion, original.contentVersion)
      assert.equal(refreshed.conflict, false)
      assert.deepEqual([...refreshed.bytes], [4, 5, 6])
    } finally { release() }
  } finally { await clean.service.dispose() }
  const dirty = setup()
  try {
    const original = await dirty.open()
    const changed = await dirty.add(original.id, original.revision)
    await dirty.service.suspend(sessionId, original.id)
    dirty.changeSource()
    const release = await dirty.service.acquire(sessionId, original.id, agent, signal)
    try {
      const resumed = dirty.service.readSnapshot(sessionId, original.id)
      assert.equal(resumed.revision, changed.revision)
      assert.equal(resumed.contentVersion, changed.contentVersion)
      assert.equal(resumed.conflict, true)
      assert.equal(resumed.document.annotations[0]?.contents, 'Shared draft')
      assert.deepEqual([...resumed.bytes], [...original.bytes])
    } finally { release() }
  } finally { await dirty.service.dispose() }
})

test('service disposal rejects new admission and waits for an acquired operation before freeing its registry', async () => {
  const { service, open } = setup()
  const opened = await open()
  const release = await service.acquire(sessionId, opened.id, agent, signal)
  let disposed = false
  const disposal = service.dispose().then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false)
  assert.equal(service.listDocuments()[0]?.pins, 1)
  await assert.rejects(service.acquire(sessionId, opened.id, agent, signal), { code: 'pdf/unavailable' })
  release()
  await disposal
  assert.equal(disposed, true)
  assert.deepEqual(service.listDocuments(), [])
})

test('a delayed model release cannot clear a newer open generation or evict its resources', async () => {
  const { service, open } = setup()
  try {
    const first = await open('agent', 'old-runtime-open')
    const reopened = await open('agent', 'new-runtime-open')
    assert.equal(reopened.id, first.id)
    let evictions = 0
    const evict = async () => { evictions += 1 }
    assert.equal(await service.releaseBackground(sessionId, first.id, evict, 'old-runtime-open'), 'retained-model')
    assert.equal(service.listDocuments()[0]?.modelReferenceId, 'new-runtime-open')
    assert.equal(service.listDocuments()[0]?.modelOwned, true)
    assert.equal(evictions, 0)
    assert.equal(await service.releaseBackground(sessionId, first.id, evict, 'new-runtime-open'), 'released')
    assert.equal(service.listDocuments()[0]?.modelOwned, false)
    assert.equal(evictions, 1)
    await open('agent', 'newest-runtime-open')
    assert.equal(await service.releaseBackground(sessionId, first.id, evict, null), 'retained-model', 'a captured missing owner cannot clear a later open')
  } finally { await service.dispose() }
})
