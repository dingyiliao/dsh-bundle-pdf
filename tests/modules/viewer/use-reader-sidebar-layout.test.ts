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

test('each PDF keeps its own sidebar section and expansion across file switches', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const firstFile = 'dsh-resource://file/session/shared-session/first.pdf'
  const secondFile = 'dsh-resource://file/session/shared-session/second.pdf'
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
  function Harness({ resourceAddress, visible = true }: { resourceAddress: string; visible?: boolean }) {
    const bodyRef = useRef<HTMLDivElement>(null)
    const navigationLock = useRef(false)
    state = useReaderSidebarLayout({ bodyRef, navigationLock, navigating: false, resourceAddress, visible })
    return React.createElement('div', { ref: bodyRef })
  }
  try {
    await act(async () => root.render(React.createElement(Harness, { resourceAddress: firstFile })))
    assert.equal(state?.expanded, true)
    await act(async () => { width = 700; resize() })
    assert.equal(state?.expanded, false)
    await act(async () => { width = 800; resize() })
    assert.equal(state?.expanded, true)
    await act(async () => { state?.changeExpanded(false) })
    await act(async () => { width = 700; resize() })
    await act(async () => { width = 800; resize() })
    assert.equal(state?.expanded, false, 'manual close is not undone by a later resize')

    await act(async () => { state?.show('bookmarks') })
    await act(async () => { state?.changeExpanded(false) })
    await act(async () => root.render(null))
    await act(async () => root.render(React.createElement(Harness, { resourceAddress: firstFile })))
    assert.equal(state?.section, 'bookmarks', 'reopening a file keeps its selected sidebar section')
    assert.equal(state?.expanded, false, 'reopening a file keeps its manual collapsed state')

    await act(async () => root.render(null))
    await act(async () => root.render(React.createElement(Harness, { resourceAddress: secondFile })))
    assert.equal(state?.section, 'annotations', 'another PDF in the same session starts with its own sidebar state')
    assert.equal(state?.expanded, true, 'closing the first PDF sidebar does not close the second')

    await act(async () => { state?.show('pages') })
    await act(async () => { width = 700; resize() })
    assert.equal(state?.expanded, false)
    await act(async () => root.render(null))
    await act(async () => root.render(React.createElement(Harness, { resourceAddress: secondFile })))
    assert.equal(state?.section, 'pages')
    assert.equal(state?.expanded, false, 'auto-collapsed sidebar stays collapsed across file switches')
    await act(async () => { width = 800; resize() })
    assert.equal(state?.expanded, true, 'only auto-collapsed sidebar reopens when space returns')

    await act(async () => root.render(React.createElement(Harness, { resourceAddress: secondFile, visible: false })))
    dom.sessionStorage.setItem(`dsh-pdf:sidebar-layout:v2:${secondFile}`, JSON.stringify({
      section: 'search', expanded: false, autoCollapsed: false, narrow: false,
    }))
    await act(async () => root.render(React.createElement(Harness, { resourceAddress: secondFile })))
    assert.equal(state?.section, 'search', 'an already-mounted file tab picks up the latest section when shown')
    assert.equal(state?.expanded, false, 'an already-mounted file tab picks up the latest expanded state')

    await act(async () => root.render(React.createElement(Harness, { resourceAddress: firstFile })))
    assert.equal(state?.section, 'bookmarks', 'switching resource in one Reader restores that PDF without overwriting it')
    assert.equal(state?.expanded, false)
    await act(async () => root.render(React.createElement(Harness, { resourceAddress: secondFile })))
    assert.equal(state?.section, 'search')
    assert.equal(state?.expanded, false)
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
