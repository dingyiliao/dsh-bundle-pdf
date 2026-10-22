import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfApi } from '../src/adapters/client/remote/pdf-api.ts'
import { DEFAULT_HIGHLIGHT_QUICK_COLORS, readHighlightQuickColors } from '../src/modules/viewer/model/highlight-colors.ts'
import { openNativeDocument, NativeViewport } from '../src/modules/viewer/index.ts'
import { waitForReaderState } from '../src/modules/viewer/controllers/wait-for-reader-state.ts'
import type { WorkspaceSnapshot } from '../src/shared/contracts.ts'
import type { NativeReaderApi } from '../src/shared/native.ts'

test('quick colors fall back to defaults when storage access is blocked', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Storage denied', 'SecurityError') },
  })
  try { assert.deepEqual(readHighlightQuickColors(), DEFAULT_HIGHLIGHT_QUICK_COLORS) }
  finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('reader waits reject an already aborted lifetime before installing listeners', async () => {
  const controller = new AbortController()
  const reason = new Error('reader closed')
  controller.abort(reason)
  const target = new EventTarget()
  await assert.rejects(waitForReaderState(target, 'ready', () => undefined, controller.signal, 100),
    error => error === reason)
})

test('reader waits clean up if the event source refuses listener registration', async () => {
  const reason = new Error('event source disposed')
  const target = new EventTarget()
  target.addEventListener = () => { throw reason }
  await assert.rejects(waitForReaderState(target, 'ready', () => undefined, new AbortController().signal, 100),
    error => error === reason)
})

test('native viewport clones the current layout and converts rectangles without changing its source', () => {
  const geometry = { page: 1, cropBox: [10, 20, 110, 220] as [number, number, number, number],
    rotation: 90, userUnit: 2 }
  const original = new NativeViewport(geometry, 1.5, 90, 4, 8, true)
  const clone = original.clone()
  assert.notEqual(clone, original)
  assert.deepEqual([clone.scale, clone.rotation, clone.offsetX, clone.offsetY], [1.5, 90, 4, 8])
  assert.equal(clone.dontFlip, false, 'a plain clone uses the normal PDF Y orientation')
  const changed = original.clone({ scale: 2, rotation: 180, offsetX: -2, offsetY: 3, dontFlip: true })
  assert.deepEqual([changed.scale, changed.rotation, changed.offsetX, changed.offsetY, changed.dontFlip],
    [2, 180, -2, 3, true])
  assert.deepEqual(changed.convertToViewportRectangle([10, 20, 110, 220]),
    [...changed.convertToViewportPoint(10, 20), ...changed.convertToViewportPoint(110, 220)])
  assert.equal(original.rotation, 90)
})

test('native document forwards destination lookups and validates zero-based page indices', async () => {
  const calls: string[] = []
  const snapshot = { id: 'doc', document: { pageCount: 2, pages: [
    { page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 },
    { page: 2, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 },
  ] }, reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 } } as WorkspaceSnapshot
  const api = { async destination(sessionId: string, id: string, _reader: unknown, name: string) {
    calls.push(`${sessionId}/${id}/${name}`)
    return [1, 'Fit']
  } } as NativeReaderApi
  const { document, dispose } = await openNativeDocument(snapshot, 'session', api)
  assert.equal(document.numPages, 2)
  assert.deepEqual(await document.getDestination('chapter-two'), [1, 'Fit'])
  assert.deepEqual(calls, ['session/doc/chapter-two'])
  assert.equal(await document.getPageIndex(0), 0)
  assert.equal(await document.getPageIndex(1), 1)
  for (const ref of [-1, 2, '1', null]) {
    await assert.rejects(document.getPageIndex(ref), /must carry a page index/)
  }
  await dispose()
  await assert.rejects(document.getPage(1), { name: 'AbortError' })
})

test('client discard routes clean up durable drafts for open and restored PDF tabs', async () => {
  const calls: { method: string; payload: object }[] = []
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    calls.push({ method, payload })
    const request = payload as { action: string; address?: string; id?: string }
    if (request.action === 'discardMany') return { ok: true, value: { discarded: ['open-tab'] } }
    if (request.action === 'discardAddresses') return { ok: true, value: { discarded: ['restored-tab'] } }
    return { ok: true, value: {
      id: request.id ?? (request.address?.includes('restored') ? 'restored-tab' : 'open-tab'),
      path: '/document.pdf', sourceVersion: 'source', contentVersion: 'content', revision: 0,
      dirty: false, canUndo: false, canRedo: false, conflict: false,
      reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
      document: { pageCount: 1, signed: false, encrypted: false, readOnly: false,
        pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }], annotations: [] },
    } }
  } } }, new AbortController().signal)
  await api.open('session', 'dsh-resource://file/session/session/open.pdf')
  let notified = 0
  api.subscribe('open-tab', () => { notified++ })
  await api.discardMany('session', ['open-tab'])
  await api.reload('session', 'open-tab', 0)
  api.subscribe('restored-tab', () => { notified++ })
  await api.discardAddresses('session', ['dsh-resource://file/session/session/restored-tab'])
  await api.open('session', 'dsh-resource://file/session/session/restored.pdf')
  assert.equal(notified, 0, 'discarded documents must not notify stale reader subscribers')
  assert.deepEqual(calls.filter(call => ['discardMany', 'discardAddresses'].includes((call.payload as { action: string }).action)), [
    { method: 'pdf.dispatch.v2', payload: { action: 'discardMany', sessionId: 'session', ids: ['open-tab'] } },
    { method: 'pdf.dispatch.v2', payload: { action: 'discardAddresses', sessionId: 'session',
      addresses: ['dsh-resource://file/session/session/restored-tab'] } },
  ])
})
