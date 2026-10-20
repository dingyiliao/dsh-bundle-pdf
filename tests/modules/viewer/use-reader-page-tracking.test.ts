import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { PageView } from '../../../src/modules/viewer/model/reader-selection.ts'
import { setWindowLayout } from '../../../src/modules/viewer/rendering/window-layout.ts'
import { useReaderPageTracking } from '../../../src/modules/viewer/controllers/use-reader-page-tracking.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

test('page tracking follows the visible page but preserves a user-edited page number', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const values = {
    window: dom, document: dom.document, Event: dom.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const snapshot = { id: 'doc-1' } as WorkspaceSnapshot
  let tracked: ReturnType<typeof useReaderPageTracking> | undefined
  const attached: (HTMLDivElement | null)[] = []
  const Harness = () => {
    const readerElement = useRef<HTMLDivElement>(null)
    tracked = useReaderPageTracking({ snapshot, readerElement,
      scrollportRef: (node: HTMLDivElement | null) => attached.push(node) })
    return React.createElement('div', { ref: readerElement },
      React.createElement('input', { className: 'dsh-pdf-page-input' }),
      React.createElement('div', { ref: tracked.scrollRef }))
  }
  try {
    await act(async () => root.render(React.createElement(Harness)))
    const current = () => tracked!
    const scroll = current().scrollRoot!
    assert.ok(scroll)
    assert.equal(attached.at(-1), scroll)
    setWindowLayout(scroll, [1, 2, 3].map((page, index) => ({ page, top: index * 100,
      width: 80, height: 90, outerHeight: 100, scale: 1 })))
    let changed = 0
    scroll.addEventListener('pdfviewchange', () => changed++)
    current().registerView(1, {} as PageView)
    assert.equal(current().views.current.size, 1)
    current().registerView(1, null)
    assert.equal(current().views.current.size, 0)
    assert.equal(changed, 2)
    scroll.scrollTop = 101
    await act(async () => { current().updateScrolledPage(); await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.equal(current().currentPage, 2)
    assert.equal(current().pageInput, '2')
    await act(async () => current().setPageInput('999'))
    scroll.scrollTop = 201
    await act(async () => { current().updateScrolledPage(); await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.equal(current().currentPage, 3)
    assert.equal(current().pageInput, '999')
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
