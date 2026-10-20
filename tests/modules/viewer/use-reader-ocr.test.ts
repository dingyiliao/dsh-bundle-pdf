import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NavigationHistory } from '../../../src/navigation/index.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderLifetime } from '../../../src/modules/viewer/controllers/reader-lifetime.ts'
import { useReaderOcr, type ReaderOcrOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const snapshot = { id: 'doc-1', revision: 7, contentVersion: 'content-1' } as WorkspaceSnapshot

async function withOcr(run: (fixture: {
  state(): ReturnType<typeof useReaderOcr>
  options: ReaderOcrOptions
  render(options: ReaderOcrOptions): Promise<void>
  lifetime: ReaderLifetime
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const lifetime: ReaderLifetime = { history: new NavigationHistory({ capacity: 10 }), ocrPages: new Map() }
  let latest: ReturnType<typeof useReaderOcr> | undefined
  const Harness = (props: ReaderOcrOptions) => { latest = useReaderOcr(props); return null }
  const options: ReaderOcrOptions = {
    api: { async availability() { return { status: 'available' } },
      async recognize() { return { documentId: 'doc-1', page: 1, revision: 7, contentVersion: 'content-1',
        text: 'recognized words', status: 'complete', source: { backendId: 'test', backendVersion: '1' },
        geometry: { status: 'none' }, warnings: [] } } },
    sessionId: 'session-1', visible: true, tabSignal: tab.signal, snapshot, currentPage: 1, lifetime,
    screenshot: null, t: key => key, currentSnapshot: () => snapshot,
    onError: error => { throw error }, onRecognized() {},
  }
  const render = async (next: ReaderOcrOptions) => { await act(async () => { root.render(React.createElement(Harness, next)) }) }
  try { await render(options); await run({ state: () => latest!, options, render, lifetime }) }
  finally {
    await act(async () => root.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('OCR state persists in the tab occurrence but never fabricates word geometry', async () => {
  await withOcr(async ({ state, lifetime }) => {
    await act(async () => { await state().recognize() })
    assert.equal(state().ocrTranscript?.result.text, 'recognized words')
    assert.equal(state().ocrPages.get(1)?.text, 'recognized words')
    assert.deepEqual(state().ocrPages.get(1)?.words, [])
    assert.equal(lifetime.ocrPages.get(1)?.engine, 'test')
    assert.equal(state().ocrProgress, null)
    await act(async () => { state().resetContent() })
    assert.equal(state().ocrTranscript, null)
    assert.equal(state().ocrPages.size, 0)
  })
})

test('OCR checks Host availability immediately before recognition', async () => {
  await withOcr(async ({ state, options, render }) => {
    let recognizes = 0
    const errors: string[] = []
    await render({ ...options, api: { async availability() { return { status: 'unavailable', reason: 'model offline' } },
      async recognize() { recognizes++; throw new Error('must not reach model') } },
      onError: error => { errors.push(error instanceof Error ? error.message : String(error)) } })
    await act(async () => { await state().recognize() })
    assert.equal(recognizes, 0)
    assert.deepEqual(errors, ['model offline'])
    assert.equal(state().ocrAvailability?.status, 'unavailable')
  })
})

test('OCR rejects a late response after its tab occurrence is aborted', async () => {
  await withOcr(async ({ state, options, render }) => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const tab = new AbortController()
    await render({ ...options, tabSignal: tab.signal, api: { async availability() { return { status: 'available' } },
      async recognize() { await gate; return { documentId: 'doc-1', page: 1, revision: 7, contentVersion: 'content-1',
        text: 'late', status: 'complete', source: { backendId: 'test', backendVersion: '1' },
        geometry: { status: 'none' }, warnings: [] } } } })
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().recognize(); await Promise.resolve() })
    await act(async () => { tab.abort(); release!(); await pending })
    assert.equal(state().ocrTranscript, null)
  })
})
