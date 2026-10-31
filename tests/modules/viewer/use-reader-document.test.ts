import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderDocument, type ReaderDocumentOptions } from '../../../src/modules/viewer/controllers/use-reader-document.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const makeSnapshot = (id: string, sourceVersion = 'source-1') => ({
  id, path: '/tmp/sample.pdf', sourceVersion, contentVersion: 'content-1', revision: 1,
  dirty: false, canUndo: false, canRedo: false, conflict: false,
  reader: { bytesHash: 'bytes-1', generation: 1, protocolVersion: 1 },
  document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
    annotations: [], signed: false, encrypted: false, readOnly: false },
}) as WorkspaceSnapshot

async function withDocument(run: (fixture: {
  state(): ReturnType<typeof useReaderDocument>
  options: ReaderDocumentOptions
  render(options: ReaderDocumentOptions): Promise<void>
  unmount(): Promise<void>
  loaded: string[]
  failed: string[]
  switches: string[]
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const prior = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const loaded: string[] = [], failed: string[] = [], switches: string[] = []
  let latest: ReturnType<typeof useReaderDocument> | undefined
  const Harness = (props: ReaderDocumentOptions) => { latest = useReaderDocument(props); return null }
  const api = { open: async () => makeSnapshot('doc-1'), subscribe: () => () => {}, native: {} } as unknown as PdfClientApi
  const options: ReaderDocumentOptions = { api, sessionId: 'chat-1', resourceAddress: 'file:///tmp/sample.pdf',
    tabSignal: new AbortController().signal, content: { revision: 1,
      loaded: (source: string) => loaded.push(source), failed: () => failed.push('failed') },
    onError: failure => failed.push(String(failure)), onResourceSwitch: () => switches.push('switch'),
    onNativeOpened: () => {}, releaseRegionCapture: () => null }
  const render = async (next: ReaderDocumentOptions) => {
    await act(async () => { root.render(React.createElement(Harness, next)); await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  const unmount = async () => { await act(async () => { root.render(null) }) }
  try { await run({ state: () => latest!, options, render, unmount, loaded, failed, switches }) }
  finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('document owner publishes a native handle and reports its source version', async () => {
  await withDocument(async ({ options, state, render, loaded, failed, switches }) => {
    await render(options)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().snapshot?.id, 'doc-1')
    assert.equal(state().pdf?.numPages, 1)
    assert.equal(state().documentReady(), true)
    assert.ok(loaded.includes('source-1'))
    assert.deepEqual(failed, [])
    assert.deepEqual(switches, ['switch'])
  })
})

test('a superseded open cannot claim the new display owner', async () => {
  await withDocument(async ({ options, state, render, loaded }) => {
    let resolveOld!: (snapshot: WorkspaceSnapshot) => void
    const old = new Promise<WorkspaceSnapshot>(resolve => { resolveOld = resolve })
    options.api.open = async (_session, address) => address === options.resourceAddress ? old : makeSnapshot('doc-2', 'source-2')
    await render(options)
    await render({ ...options, resourceAddress: 'file:///tmp/next.pdf',
      content: { ...options.content, revision: 2 } })
    await act(async () => { resolveOld(makeSnapshot('doc-old')); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().snapshot?.id, 'doc-2')
    assert.ok(loaded.includes('source-2'))
    assert.ok(!loaded.includes('source-1'))
  })
})

test('open failure belongs to the current owner and is not reported as loaded', async () => {
  await withDocument(async ({ options, state, render, loaded, failed }) => {
    options.api.open = async () => { throw new Error('cannot open') }
    await render(options)
    assert.equal(state().snapshot, null)
    assert.deepEqual(loaded, [])
    assert.ok(failed.some(message => message.includes('cannot open')))
    assert.ok(failed.includes('failed'))
  })
})

test('commands wait for a same-resource refresh to publish its replacement display owner', async () => {
  await withDocument(async ({ options, state, render }) => {
    await render(options)
    const first = await state().waitForReady()
    assert.equal(typeof first, 'number')
    let finish!: (snapshot: WorkspaceSnapshot) => void
    options.api.open = () => new Promise(resolve => { finish = resolve })
    await render({ ...options, content: { ...options.content, revision: 2 } })
    assert.ok(state().snapshot)
    assert.ok(state().pdf, 'the last rendered PDF stays visible while its replacement opens')
    assert.equal(state().documentReady(), false)
    let settled = false
    const readiness = state().waitForReady()
    assert.equal(state().waitForReady(), readiness, 'one resource shares one readiness wait instead of accumulating callbacks')
    const waiting = readiness.then(token => { settled = true; return token })
    await Promise.resolve()
    assert.equal(settled, false)
    await act(async () => { finish({ ...makeSnapshot('doc-1'), revision: 2 }); await Promise.resolve() })
    const replacement = await waiting
    assert.equal(typeof replacement, 'number')
    assert.notEqual(replacement, first)
    assert.equal(state().documentReady(), true)
    assert.equal(await state().waitForReady(), replacement)
  })
})

for (const boundary of ['resource', 'session', 'api', 'tab'] as const) {
  test(`a pending ready command cannot cross the ${boundary} ownership boundary`, async () => {
    await withDocument(async ({ options, state, render }) => {
      let finishOld!: (snapshot: WorkspaceSnapshot) => void
      options.api.open = () => new Promise(resolve => { finishOld = resolve })
      await render(options)
      const waitOld = state().waitForReady
      const waiting = waitOld()
      const nextApi = { ...options.api, open: async () => makeSnapshot('replacement') }
      const next = { ...options,
        ...(boundary === 'resource' ? { resourceAddress: 'file:///tmp/next.pdf' } : {}),
        ...(boundary === 'session' ? { sessionId: 'chat-2' } : {}),
        ...(boundary === 'api' ? { api: nextApi } : {}),
        ...(boundary === 'tab' ? { tabSignal: new AbortController().signal } : {}),
      }
      if (boundary !== 'api') options.api.open = nextApi.open
      await render(next)
      assert.equal(await waiting, false)
      assert.equal(await waitOld(), false, 'an old callback cannot claim a new resource owner')
      await act(async () => { finishOld(makeSnapshot('stale')); await Promise.resolve() })
      assert.equal(state().snapshot?.id, 'replacement')
      assert.equal(typeof await state().waitForReady(), 'number')
    })
  })
}

test('tab abort and Reader unmount settle pending commands even when the carrier never replies', async () => {
  for (const boundary of ['abort', 'unmount'] as const) {
    await withDocument(async ({ options, state, render, unmount }) => {
      options.api.open = () => new Promise(() => {})
      const tab = new AbortController()
      await render({ ...options, tabSignal: tab.signal })
      const wait = state().waitForReady
      const waiting = wait()
      if (boundary === 'abort') tab.abort()
      else await unmount()
      assert.equal(await waiting, false)
      assert.equal(await wait(), false)
    })
  }
})

test('an open failure settles pending commands and a later refresh can recover', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    let reject!: (error: Error) => void
    options.api.open = () => new Promise((_resolve, fail) => { reject = fail })
    await render(options)
    const waiting = state().waitForReady()
    await act(async () => { reject(new Error('open unavailable')); await Promise.resolve() })
    assert.equal(await waiting, false)
    assert.equal(await state().waitForReady(), false)
    assert.ok(failed.some(message => message.includes('open unavailable')))
    options.api.open = async () => makeSnapshot('recovered')
    await render({ ...options, content: { ...options.content, revision: 2 } })
    assert.equal(typeof await state().waitForReady(), 'number')
    assert.equal(state().snapshot?.id, 'recovered')
  })
})

test('a native document initialization failure settles waiting commands', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    let finish!: (snapshot: WorkspaceSnapshot) => void
    options.api.open = () => new Promise(resolve => { finish = resolve })
    await render(options)
    const waiting = state().waitForReady()
    const snapshot = makeSnapshot('native-failure')
    Object.defineProperty(snapshot.document, 'pageCount', { get() { throw new Error('native init failed') } })
    await act(async () => { finish(snapshot); await Promise.resolve() })
    assert.equal(await waiting, false)
    assert.equal(state().documentReady(), false)
    assert.ok(failed.some(message => message.includes('native init failed')))
  })
})
