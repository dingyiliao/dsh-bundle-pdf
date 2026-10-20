import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NavigationHistory, type NavigationPosition } from '../../../src/navigation/index.ts'
import type { PdfClientApi } from '../../../src/shared/contracts.ts'
import { useReaderNavigation, type ReaderNavigationOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

test('history return reports a failed page restore without popping the destination', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const origin: NavigationPosition = { documentVersion: 'v1', page: 1, x: 0, y: 100, fit: 'width', scale: 1 }
  const destination: NavigationPosition = { ...origin, page: 2 }
  const history = new NavigationHistory({ capacity: 10 })
  await history.jump(destination, { capture: () => origin, apply: async () => destination })
  const errors: unknown[] = []
  const tab = new AbortController()
  const options: ReaderNavigationOptions = {
    api: { positions: { async get() { return null }, async set() {} } } as unknown as PdfClientApi,
    sessionId: 'session-1', tabSignal: tab.signal, contentRevision: 1,
    pdf: null, snapshot: null, scrollRoot: null, currentPage: 2, historyCapacity: 10,
    lifetime: { history, ocrPages: new Map() },
    state: { current: { snapshot: null, scrollRoot: null, fit: 'width', zoom: 1,
      size: { width: 400, height: 600 }, currentPage: 2 } },
    views: { current: new Map() },
    setCurrentPage() {}, setPageInput() {}, setZoom() {}, setFit() {}, setPositionNotice() {},
    onError: error => { errors.push(error) }, t: key => key,
  }
  let latest: ReturnType<typeof useReaderNavigation> | undefined
  const Harness = () => { latest = useReaderNavigation(options); return null }
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    assert.equal(latest?.canGoBack, true)
    await act(async () => { latest!.navigateHistory(); await new Promise(resolve => setImmediate(resolve)) })
    assert.deepEqual(errors.map(error => error instanceof Error ? error.message : String(error)),
      ['reader.invalidDestination'])
    assert.equal(history.size, 1, 'a failed return must retain its history entry')
    assert.equal(latest?.navigating, false)
  } finally {
    tab.abort()
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
