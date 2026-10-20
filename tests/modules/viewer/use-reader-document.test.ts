import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderDocument, type ReaderDocumentOptions } from '../../../src/modules/viewer/controllers/use-reader-document.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
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
  try { await run({ state: () => latest!, options, render, loaded, failed, switches }) }
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
