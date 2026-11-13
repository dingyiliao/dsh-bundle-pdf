import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NavigationHistory } from '../../../src/shared/navigation-history.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderLifetime } from '../../../src/client/viewer/controllers/reader-lifetime.ts'
import { useReaderOcr, type ReaderOcrOptions } from '../../../src/client/viewer/index.ts'

const snapshot = { id: 'doc-1', revision: 7, contentVersion: 'content-1' } as WorkspaceSnapshot

async function withOcr(run: (fixture: {
  state(): ReturnType<typeof useReaderOcr>
  options: ReaderOcrOptions
  render(options: ReaderOcrOptions): Promise<void>
  lifetime: ReaderLifetime
}) => Promise<void>): Promise<void> {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
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
    restoreDom()

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

test('OCR cancellation marks the active request and settles without publishing a transcript', async () => {
  await withOcr(async ({ state, options, render }) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await render({ ...options, api: { async availability() { return { status: 'available' } },
      async recognize(_request, signal) {
        await gate
        assert.ok(signal)
        signal.throwIfAborted()
        return { documentId: 'doc-1', page: 1, revision: 7, contentVersion: 'content-1',
          text: 'should not publish', status: 'complete', source: { backendId: 'test', backendVersion: '1' },
          geometry: { status: 'none' }, warnings: [] }
      } } })
    let pending!: Promise<void>
    await act(async () => { pending = state().recognize(); await Promise.resolve() })
    assert.equal(state().ocrProgress, 'recognizing')
    await act(async () => { state().cancel() })
    assert.equal(state().ocrProgress, 'cancelling')
    release()
    await act(async () => { await pending })
    assert.equal(state().ocrTranscript, null)
    assert.equal(state().ocrProgress, null)
  })
})
