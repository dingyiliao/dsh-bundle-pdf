import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { NativeReaderApi, NativeTextContent, NativeTile, NativeTileRequest } from '../../../src/shared/native.ts'
import { useReaderDocument, type ReaderDocumentOptions } from '../../../src/modules/viewer/controllers/use-reader-document.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const snapshot = (hash = 'bytes-before-save', revision = 1, id = 'document'): WorkspaceSnapshot => ({
  id, path: `/tmp/${id}.pdf`, sourceVersion: `source-${revision}`, contentVersion: 'content', revision,
  dirty: false, canUndo: false, canRedo: false, conflict: false,
  reader: { bytesHash: hash, generation: revision, protocolVersion: 1 },
  document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
    annotations: [], signed: false, encrypted: false, readOnly: false },
})
const text = (value: string): NativeTextContent => ({ items: [{ str: value, transform: [1, 0, 0, 1, 0, 0],
  width: 10, height: 10, dir: 'ltr', fontName: 'test', hasEOL: false }], styles: {}, lang: 'en' })
const tile: NativeTileRequest = { page: 1, rotation: 0, rasterWidth: 100, rasterHeight: 100,
  x: 0, y: 0, width: 100, height: 100, annotations: true }
const raster: NativeTile = { bytes: new Uint8Array([1]), width: 100, height: 100, mime: 'image/png' }
const stale = () => Object.assign(new Error('PDF baseline changed; use the latest reader snapshot'), { code: 'pdf/stale-reader' })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
const cancelled = (promise: Promise<unknown>) => assert.rejects(promise, { name: 'AbortError' })

async function fixture(run: (value: {
  state(): ReturnType<typeof useReaderDocument>
  options: ReaderDocumentOptions
  api: PdfClientApi
  errors: unknown[]
  ready: string[]
  tab: AbortController
  watch(value: WorkspaceSnapshot): Promise<void>
  render(value?: ReaderDocumentOptions): Promise<void>
  unmount(): Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const prior = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    createImageBitmap: async () => ({ width: 100, height: 100, close() {} }) as ImageBitmap })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  let state!: ReturnType<typeof useReaderDocument>
  const Harness = (options: ReaderDocumentOptions) => { state = useReaderDocument(options); return null }
  const subscriptions = new Map<string, Set<(value: WorkspaceSnapshot) => void>>()
  const native: NativeReaderApi = { text: async () => text('current'), tile: async () => raster,
    links: async () => [], outline: async () => null, destination: async () => null }
  const api = { native, open: async () => snapshot(), refresh: async () => snapshot('bytes-after-save', 2),
    subscribe(id: string, listener: (value: WorkspaceSnapshot) => void) {
      const listeners = subscriptions.get(id) ?? new Set<(value: WorkspaceSnapshot) => void>()
      subscriptions.set(id, listeners); listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as PdfClientApi
  const errors: unknown[] = [], ready: string[] = [], tab = new AbortController()
  const options: ReaderDocumentOptions = { api, sessionId: 'session', resourceAddress: 'file:///tmp/document.pdf',
    tabSignal: tab.signal, content: { revision: 1, loaded() {}, failed() {} },
    onError: error => { errors.push(error) }, onResourceSwitch() {}, onNativeOpened() {},
    onNativeReady: () => { ready.push(state.pdf!.snapshot.reader.bytesHash) }, releaseRegionCapture: () => null }
  const render = async (next = options) => { await act(async () => { root.render(React.createElement(Harness, next)) }); await flush() }
  const watch = async (value: WorkspaceSnapshot) => {
    await act(async () => { for (const listener of subscriptions.get(value.id) ?? []) listener(value) })
    await flush()
  }
  const unmount = async () => { await act(async () => { root.render(null) }) }
  try { await run({ state: () => state, options, api, errors, ready, tab, watch, render, unmount }) }
  finally {
    await act(async () => { root.unmount() })
    dom.close()
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('save while old text and tile requests are in flight refreshes once and reads the saved baseline without watch', async () => {
  await fixture(async ({ api, options, state, render, errors, ready }) => {
    const oldText = deferred<NativeTextContent>(), oldTile = deferred<NativeTile>()
    const saveReply = deferred<WorkspaceSnapshot>(), refreshReply = deferred<WorkspaceSnapshot>()
    let host = snapshot(), refreshes = 0
    const reads: string[] = []
    api.native.text = async (_session, _id, reader) => {
      reads.push(`text:${reader.bytesHash}`)
      return reader.bytesHash === 'bytes-before-save' ? oldText.promise : text('saved text')
    }
    api.native.tile = async (_session, _id, reader) => {
      reads.push(`tile:${reader.bytesHash}`)
      return reader.bytesHash === 'bytes-before-save' ? oldTile.promise : raster
    }
    api.save = async () => { host = snapshot('bytes-after-save', 2); return saveReply.promise }
    api.refresh = async (session, id) => {
      assert.equal(session, options.sessionId); assert.equal(id, host.id)
      refreshes++; return refreshReply.promise
    }
    await render()
    const old = state().pdf!
    const oldReads = Promise.all([cancelled(old.text(1)), cancelled(old.bitmap(tile, new AbortController().signal))])
    const saving = api.save('session', host.id, 1, { overwrite: true })
    assert.equal(host.reader.bytesHash, 'bytes-after-save', 'Host has saved while the save RPC and subscription are still pending')
    await act(async () => { oldText.reject(stale()); oldTile.reject(stale()); await Promise.resolve() })
    assert.equal(refreshes, 1)
    assert.equal(old.lifetime.signal.aborted, true)
    assert.equal(state().documentReady(), false)
    let commandReady = false
    const waiting = state().waitForReady().then(result => { commandReady = true; return result })
    await Promise.resolve(); assert.equal(commandReady, false, 'a retired handle cannot execute another command')
    await act(async () => { refreshReply.resolve(host); await Promise.resolve() })
    await flush()
    await oldReads
    assert.notEqual(state().pdf, old)
    assert.equal(state().pdf?.snapshot.reader.bytesHash, 'bytes-after-save')
    assert.equal(typeof await waiting, 'number')
    assert.deepEqual(ready, [], 'opening a descriptor alone does not verify recovery')
    await act(async () => {
      assert.equal((await state().pdf!.text(1)).items[0].str, 'saved text')
      assert.equal((await state().pdf!.bitmap(tile, new AbortController().signal)).width, 100)
    })
    assert.deepEqual(ready, ['bytes-after-save'])
    assert.deepEqual(reads, ['text:bytes-before-save', 'tile:bytes-before-save', 'text:bytes-after-save', 'tile:bytes-after-save'])
    assert.deepEqual(errors, [])
    saveReply.resolve(host); assert.equal((await saving).reader.bytesHash, 'bytes-after-save')
  })
})

for (const outcome of ['resolve', 'reject'] as const) {
  test(`watch replaces the baseline before old text/tile ${outcome}: old responses cannot restore stale pixels or errors`, async () => {
    await fixture(async ({ api, state, render, watch, errors, ready }) => {
      const oldText = deferred<NativeTextContent>(), oldTile = deferred<NativeTile>()
      let refreshes = 0
      api.native.text = async (_session, _id, reader) => reader.bytesHash === 'bytes-before-save' ? oldText.promise : text('replacement')
      api.native.tile = async (_session, _id, reader) => reader.bytesHash === 'bytes-before-save' ? oldTile.promise : raster
      api.refresh = async () => { refreshes++; return snapshot('unexpected', 3) }
      await render()
      const old = state().pdf!
      const reads = Promise.all([cancelled(old.text(1)), cancelled(old.bitmap(tile, new AbortController().signal))])
      await watch(snapshot('bytes-after-save', 2))
      await reads
      if (outcome === 'resolve') { oldText.resolve(text('obsolete')); oldTile.resolve(raster) }
      else { oldText.reject(stale()); oldTile.reject(stale()) }
      await flush()
      assert.equal(refreshes, 0)
      assert.deepEqual(errors, [])
      assert.deepEqual(ready, [])
      assert.equal(old.diagnostics().textCacheBytes, 0)
      assert.equal(old.diagnostics().bitmapCacheBytes, 0)
      assert.equal((await state().pdf!.text(1)).items[0].str, 'replacement')
      assert.deepEqual(ready, ['bytes-after-save'])
    })
  })
}

test('a failed readonly refresh reports one real error and does not retry every stale tile', async () => {
  await fixture(async ({ api, state, render, errors, ready }) => {
    const reply = deferred<WorkspaceSnapshot>(), oldText = deferred<NativeTextContent>(), oldTile = deferred<NativeTile>()
    const denied = Object.assign(new Error('permission revoked'), { code: 'pdf/permission' })
    let refreshes = 0
    api.native.text = () => oldText.promise
    api.native.tile = () => oldTile.promise
    api.refresh = async () => { refreshes++; return reply.promise }
    await render()
    const old = state().pdf!
    const reads = Promise.all([cancelled(old.text(1)), cancelled(old.bitmap(tile, new AbortController().signal))])
    await act(async () => { oldText.reject(stale()); oldTile.reject(stale()); await Promise.resolve() })
    await act(async () => { reply.reject(denied); await Promise.resolve() })
    await reads; await flush()
    assert.equal(refreshes, 1)
    assert.deepEqual(errors, [denied])
    assert.deepEqual(ready, [])
    assert.equal(state().documentReady(), false)
    assert.equal(await state().waitForReady(), false)
  })
})

test('a refresh returning the same descriptor replaces the retired handle once, then stops on repeated stale replies', async () => {
  await fixture(async ({ api, state, render, errors }) => {
    let refreshes = 0
    api.native.text = async () => { throw stale() }
    api.refresh = async () => { refreshes++; return snapshot() }
    await render()
    const first = state().pdf!
    await act(async () => { await cancelled(first.text(1)) }); await flush()
    const second = state().pdf!
    assert.notEqual(second, first, 'same-identity optimization must not retain a retired document')
    assert.equal(second.lifetime.signal.aborted, false)
    await act(async () => { await cancelled(second.text(1)) }); await flush()
    assert.equal(refreshes, 1, 'one failed baseline cannot cause an unbounded refresh loop')
    assert.equal(errors.length, 1)
    assert.equal((errors[0] as { code: string }).code, 'pdf/stale-reader')
    assert.equal(await state().waitForReady(), false)
  })
})

test('a successful replacement native read resets the bounded recovery budget for a later save', async () => {
  await fixture(async ({ api, state, render, errors, ready }) => {
    let host = snapshot(), refreshes = 0
    api.native.text = async (_session, _id, reader) => {
      if (reader.bytesHash !== host.reader.bytesHash) throw stale()
      return text(host.reader.bytesHash)
    }
    api.native.links = async (_session, _id, reader) => {
      if (reader.bytesHash !== host.reader.bytesHash) throw stale()
      return []
    }
    api.refresh = async () => { refreshes++; return host }
    await render()
    for (let version = 2; version <= 4; version++) {
      host = snapshot(`bytes-${version}`, version)
      await act(async () => { await cancelled(state().pdf!.links(1)) }); await flush()
      await act(async () => { assert.equal((await state().pdf!.text(1)).items[0].str, host.reader.bytesHash) })
    }
    assert.equal(refreshes, 3)
    assert.equal(ready.length, 3)
    assert.deepEqual(errors, [])
  })
})

test('different bad baselines also stop after a bounded number of unsuccessful recoveries', async () => {
  await fixture(async ({ api, state, render, errors, ready }) => {
    let refreshes = 0
    api.native.text = async () => { throw stale() }
    api.refresh = async () => { refreshes++; return snapshot(`still-stale-${refreshes}`, refreshes + 1) }
    await render()
    for (let attempt = 0; attempt < 3; attempt++) {
      await act(async () => { await cancelled(state().pdf!.text(1)) }); await flush()
    }
    assert.equal(refreshes, 2)
    assert.equal(errors.length, 1)
    assert.deepEqual(ready, [])
    assert.equal(state().documentReady(), false)
  })
})

test('a fresher watch snapshot cancels an outstanding recovery and wins over its late reply', async () => {
  await fixture(async ({ api, state, render, watch, errors, ready }) => {
    const refresh = deferred<WorkspaceSnapshot>()
    let signal: AbortSignal | undefined
    api.native.text = async (_session, _id, reader) => {
      if (reader.bytesHash === 'bytes-before-save') throw stale()
      return text('watched save')
    }
    api.refresh = async (_session, _id, requestedSignal) => { signal = requestedSignal; return refresh.promise }
    await render()
    const oldRead = cancelled(state().pdf!.text(1))
    await flush()
    await watch(snapshot('newer-watched-bytes', 3))
    assert.equal(signal?.aborted, true)
    await oldRead
    refresh.resolve(snapshot('older-refresh-bytes', 2))
    await flush()
    assert.equal(state().snapshot?.revision, 3)
    assert.equal(state().pdf?.snapshot.reader.bytesHash, 'newer-watched-bytes')
    assert.equal((await state().pdf!.text(1)).items[0].str, 'watched save')
    assert.deepEqual(ready, ['newer-watched-bytes'])
    assert.deepEqual(errors, [])
  })
})

test('a refresh cannot substitute another document for the current PDF', async () => {
  await fixture(async ({ api, state, render, errors, ready }) => {
    api.native.text = async () => { throw stale() }
    api.refresh = async () => snapshot('other-bytes', 2, 'other-document')
    await render()
    await act(async () => { await cancelled(state().pdf!.text(1)) }); await flush()
    assert.equal(state().snapshot?.id, 'document')
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /different document/)
    assert.deepEqual(ready, [])
    assert.equal(await state().waitForReady(), false)
  })
})

test('ordinary annotation revisions keep the live native handle and cached text while acknowledging the current source', async () => {
  await fixture(async ({ api, options, state, render, watch, errors }) => {
    const loaded: string[] = []
    let nativeReads = 0
    api.native.text = async () => { nativeReads++; return text('baseline text') }
    await render({ ...options, content: { ...options.content, loaded: (source: string) => { loaded.push(source) } } })
    const document = state().pdf!
    await document.text(1)
    const next = { ...snapshot(), revision: 2, sourceVersion: 'same-bytes-new-source', dirty: true }
    await watch(next)
    assert.equal(state().pdf, document)
    assert.equal(document.lifetime.signal.aborted, false)
    assert.equal((await state().pdf!.text(1)).items[0].str, 'baseline text')
    assert.equal(nativeReads, 1)
    assert.ok(loaded.includes(next.sourceVersion))
    assert.deepEqual(errors, [])
  })
})

for (const boundary of ['resource', 'session', 'tab', 'unmount'] as const) {
  test(`a pending baseline refresh cannot cross the ${boundary} lifetime`, async () => {
    await fixture(async ({ api, options, state, render, unmount, tab, errors, ready }) => {
      const refresh = deferred<WorkspaceSnapshot>()
      let refreshSignal: AbortSignal | undefined
      api.native.text = async () => { throw stale() }
      api.refresh = async (_session, _id, signal) => { refreshSignal = signal; return refresh.promise }
      await render()
      const old = state().pdf!
      const read = cancelled(old.text(1))
      await flush()
      assert.ok(refreshSignal)
      const waiting = state().waitForReady()
      if (boundary === 'unmount') await unmount()
      else if (boundary === 'tab') { await act(async () => { tab.abort() }) }
      else {
        api.open = async () => snapshot('other-bytes', 2, 'other-document')
        await render({ ...options,
          ...(boundary === 'resource' ? { resourceAddress: 'file:///tmp/other.pdf' } : { sessionId: 'other-session' }) })
      }
      assert.equal(refreshSignal.aborted, true)
      await read
      assert.equal(await waiting, false)
      refresh.resolve(snapshot('late-old-refresh', 100))
      await flush()
      if (boundary === 'resource' || boundary === 'session') {
        assert.equal(state().snapshot?.id, 'other-document')
        assert.equal(state().pdf?.snapshot.reader.bytesHash, 'other-bytes')
      }
      assert.deepEqual(errors, [])
      assert.deepEqual(ready, [])
    })
  })
}
