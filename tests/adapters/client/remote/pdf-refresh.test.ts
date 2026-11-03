import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfApi, type PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'
import type { WorkspaceSnapshot } from '../../../../src/shared/contracts.ts'

const address = 'dsh-resource://file/session/session/document.pdf'
const bytesHash = (value: string) => `sha256:${value.repeat(64)}`
function wire(revision: number, byte = 'a', dirty = false) {
  return { ok: true, value: {
    id: 'document', path: '/document.pdf', sourceVersion: `source-${revision}`, contentVersion: 'page-content', revision,
    dirty, canUndo: dirty, canRedo: false, conflict: false,
    reader: { bytesHash: bytesHash(byte), generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, signed: false, encrypted: false, readOnly: false,
      pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }], annotations: [] },
  } }
}
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { resolve, promise }
}
function watchUntilCancelled(signal: AbortSignal | undefined): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    const stop = () => reject(new DOMException('Watch stopped', 'AbortError'))
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
}

test('explicit refresh publishes the current draft without reopening the PDF or adding a view reference', async () => {
  const lifetime = new AbortController(), calls: Record<string, unknown>[] = []
  let revision = 0, watchSignal: AbortSignal | undefined
  const connection: PdfConnection = { rpc: { async call(_path, method, payload, signal) {
    const request = payload as Record<string, unknown>; calls.push(request)
    if (method === 'pdf.watch') { watchSignal = signal; return watchUntilCancelled(signal) }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    return wire(revision, revision ? 'b' : 'a', revision > 0)
  } } }
  const api = createPdfApi(connection, lifetime.signal), updates: WorkspaceSnapshot[] = []
  try {
    await api.open('session', address, undefined, 'view-a')
    await api.open('session', address, undefined, 'view-b')
    const stop = api.subscribe('document', snapshot => { updates.push(snapshot) })
    revision = 1
    const updated = await api.refresh('session', 'document')
    assert.equal(updated.revision, 1)
    assert.equal(updated.reader.bytesHash, bytesHash('b'))
    assert.equal(updated.dirty, true, 'refresh reads and preserves the working draft')
    assert.equal(updates.at(-1), updated)
    assert.deepEqual(calls.filter(call => call.action === 'refresh'), [{ action: 'refresh', sessionId: 'session', id: 'document',
      knownBytesHash: bytesHash('a'), knownRevision: 0 }])
    assert.equal(calls.filter(call => call.action === 'open').length, 2)
    assert.equal(calls.some(call => call.action === 'reload'), false)
    await api.release('session', 'document', 'view-a')
    assert.equal(watchSignal?.aborted, false)
    await api.release('session', 'document', 'view-b')
    assert.equal(watchSignal?.aborted, true, 'the refresh must not leave behind a third view reference')
    stop()
  } finally { lifetime.abort() }
})

test('a delayed refresh cannot replace or republish a newer save snapshot', async () => {
  const lifetime = new AbortController(), delayed = defer<unknown>(), started = defer<void>()
  const api = createPdfApi({ rpc: { async call(_path, method, payload, signal) {
    if (method === 'pdf.watch') return watchUntilCancelled(signal)
    const request = payload as { action: string }
    if (request.action === 'refresh') { started.resolve(); return delayed.promise }
    return request.action === 'save' ? wire(3, 'c') : wire(0)
  } } }, lifetime.signal)
  const revisions: number[] = []
  try {
    await api.open('session', address, undefined, 'view')
    const stop = api.subscribe('document', value => { revisions.push(value.revision) })
    const reading = api.refresh('session', 'document')
    await started.promise
    const saved = await api.save('session', 'document', 0, { overwrite: true })
    delayed.resolve(wire(2, 'b'))
    assert.equal(await reading, saved)
    assert.deepEqual(revisions, [3], 'only the winning source reaches the live Reader')
    stop()
  } finally { lifetime.abort() }
})

for (const boundary of ['request', 'lifetime'] as const) test(`a late refresh after ${boundary} cancellation cannot publish its snapshot`, async () => {
  const lifetime = new AbortController(), request = new AbortController(), delayed = defer<unknown>(), started = defer<void>()
  let refreshes = 0
  const api = createPdfApi({ rpc: { async call(_path, method, payload, signal) {
    if (method === 'pdf.watch') return watchUntilCancelled(signal)
    if ((payload as { action: string }).action === 'refresh') {
      refreshes++; started.resolve(); return refreshes === 1 ? delayed.promise : wire(1, 'b')
    }
    return wire(0)
  } } }, lifetime.signal)
  const updates: number[] = []
  try {
    await api.open('session', address, undefined, 'view')
    const stop = api.subscribe('document', value => { updates.push(value.revision) })
    const pending = api.refresh('session', 'document', request.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await started.promise
    ;(boundary === 'request' ? request : lifetime).abort()
    delayed.resolve(wire(99, 'f'))
    await rejected
    assert.deepEqual(updates, [])
    if (boundary === 'request') {
      const recovered = await api.refresh('session', 'document')
      assert.equal(recovered.revision, 1, 'abandoned revision 99 never enters the monotonic snapshot cache')
      assert.deepEqual(updates, [1])
    }
    stop()
  } finally { lifetime.abort() }
})

test('explicit refresh preserves typed Host failures and does not publish a false recovery', async () => {
  const lifetime = new AbortController()
  const api = createPdfApi({ rpc: { async call(_path, method, payload, signal) {
    if (method === 'pdf.watch') return watchUntilCancelled(signal)
    return (payload as { action: string }).action === 'refresh'
      ? { ok: false, error: { code: 'pdf/access-denied', message: 'Access revoked' } } : wire(0)
  } } }, lifetime.signal)
  const updates: number[] = []
  try {
    await api.open('session', address, undefined, 'view')
    const stop = api.subscribe('document', snapshot => { updates.push(snapshot.revision) })
    await assert.rejects(api.refresh('session', 'document'), { code: 'pdf/access-denied', message: 'Access revoked' })
    assert.deepEqual(updates, [])
    stop()
  } finally { lifetime.abort() }
})
