import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useReaderSidebarLayout } from '../../../src/modules/viewer/controllers/use-reader-sidebar-layout.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

test('narrow reader auto-collapses and restores only auto-collapsed sidebar', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  let width = 800
  let resize = () => {}
  class Observer {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  }
  const globals = { window: dom, document: dom.document, ResizeObserver: Observer,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) }
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return width } })
  const root = createRoot(dom.document.getElementById('root')!)
  let state: ReturnType<typeof useReaderSidebarLayout> | undefined
  function Harness() {
    const bodyRef = useRef<HTMLDivElement>(null)
    const navigationLock = useRef(false)
    state = useReaderSidebarLayout({ bodyRef, navigationLock, navigating: false })
    return React.createElement('div', { ref: bodyRef })
  }
  try {
    await act(async () => root.render(React.createElement(Harness)))
    assert.equal(state?.expanded, true)
    await act(async () => { width = 700; resize() })
    assert.equal(state?.expanded, false)
    await act(async () => { width = 800; resize() })
    assert.equal(state?.expanded, true)
    await act(async () => { state?.changeExpanded(false) })
    await act(async () => { width = 700; resize() })
    await act(async () => { width = 800; resize() })
    assert.equal(state?.expanded, false, 'manual close is not undone by a later resize')
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
