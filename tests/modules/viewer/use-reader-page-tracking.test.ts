import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { PageView } from '../../../src/client/viewer/model/reader-selection.ts'
import { clearWheelZoomReflow, setWheelZoomReflow, setWindowLayout } from '../../../src/client/viewer/rendering/window-layout.ts'
import { useReaderPageTracking, useReaderScrollPreview } from '../../../src/client/viewer/controllers/use-reader-page-tracking.ts'

test('page tracking follows the visible page but preserves a user-edited page number', async () => {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })
  // React's legacy input-event fallback probes these methods in jsdom on focus.
  Object.defineProperty(dom.HTMLElement.prototype, 'attachEvent', { configurable: true, value() {} })
  Object.defineProperty(dom.HTMLElement.prototype, 'detachEvent', { configurable: true, value() {} })

  const values = {
    window: dom, document: dom.document, Event: dom.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  installDom(values)
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
    const input = dom.document.querySelector<HTMLInputElement>('.dsh-pdf-page-input')!
    input.focus()
    await act(async () => current().editPageInput('81'))
    scroll.scrollTop = 201
    await act(async () => { current().updateScrolledPage(); await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.equal(current().currentPage, 3)
    assert.equal(current().pageInput, '81', 'unfinished input stays visible while the field is focused')

    // Enter commits the draft but leaves focus in the field. Scrolling must
    // replace the old destination, even though the input is still focused.
    await act(async () => current().setPageInput('3'))
    assert.equal(dom.document.activeElement, input)
    scroll.scrollTop = 1
    await act(async () => { current().updateScrolledPage(); await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.equal(current().currentPage, 1)
    assert.equal(current().pageInput, '1')

    await act(async () => current().editPageInput('81'))
    scroll.scrollTop = 101
    await act(async () => { current().updateScrolledPage(); await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.equal(current().pageInput, '81')
    input.blur()
    scroll.scrollTop = 201
    await act(async () => { current().updateScrolledPage(); await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.equal(current().pageInput, '3', 'an abandoned draft cannot remain after focus leaves the field')
  } finally {
    await act(async () => root.unmount())
    restoreDom()

  }
})

test('a clamped explicit jump survives queued scroll events while real movement and document replacement resume tracking', async () => {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, Event: dom.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  let snapshot = { id: 'doc-1', contentVersion: 'v1' } as WorkspaceSnapshot
  let tracking!: ReturnType<typeof useReaderPageTracking>
  const Harness = () => {
    const readerElement = useRef<HTMLDivElement>(null)
    tracking = useReaderPageTracking({ snapshot, readerElement, scrollportRef: () => {} })
    return React.createElement('div', { ref: readerElement }, React.createElement('div', { ref: tracking.scrollRef }))
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 5))
  try {
    await act(async () => root.render(React.createElement(Harness)))
    const scroll = tracking.scrollRoot!
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 175 })
    setWindowLayout(scroll, [1, 2, 3].map((page, index) => ({ page, top: index * 100,
      width: 80, height: 90, outerHeight: 100, scale: 1 })))
    // The browser clamps the final page's requested top to 300 - 175 = 125.
    // The leading-edge probe still sees page 2, but this explicit jump chose 3.
    scroll.scrollTop = 125
    await act(async () => {
      tracking.updateScrolledPage()
      tracking.setCurrentPage(3)
      tracking.setPageInput('3')
      await tick()
    })
    assert.equal(tracking.currentPage, 3)
    assert.equal(tracking.pageInput, '3')
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 3, 'a later event at the committed offset still belongs to that jump')

    scroll.scrollTop = 25
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 1)
    assert.equal(tracking.pageInput, '1', 'actual scrolling resumes ordinary visible-page tracking')

    scroll.scrollTop = 125
    await act(async () => { tracking.setCurrentPage(3); tracking.setPageInput('3') })
    snapshot = { id: 'doc-2', contentVersion: 'v1' } as WorkspaceSnapshot
    await act(async () => root.render(React.createElement(Harness)))
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 2, 'a replacement document cannot inherit an old explicit page commitment')

    await act(async () => { tracking.setCurrentPage(3); tracking.setPageInput('3') })
    snapshot = { id: 'doc-2', contentVersion: 'v2' } as WorkspaceSnapshot
    await act(async () => root.render(React.createElement(Harness)))
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 2, 'a reloaded content version cannot reuse an old page commitment')

    await act(async () => { tracking.setCurrentPage(3); tracking.setPageInput('3') })
    setWindowLayout(scroll, [1, 2, 3].map((page, index) => ({ page, top: index * 100,
      width: 100, height: 90, outerHeight: 100, scale: 1 })))
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 3, 'equivalent resize layouts retain the explicit target while it remains visible')

    setWindowLayout(scroll, [1, 2, 3].map((page, index) => ({ page, top: index * 210,
      width: 160, height: 200, outerHeight: 210, scale: 2 })))
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 1, 'a changed layout resumes geometric tracking when the committed target leaves the viewport')

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 800 })
    scroll.scrollTop = 0
    await act(async () => { tracking.updateScrolledPage(); await tick() })
    assert.equal(tracking.currentPage, 1, 'a fully visible document starts at page 1 rather than selecting its last page')
  } finally {
    await act(async () => root.unmount())
    restoreDom()

  }
})

test('scroll preview needs sustained fast motion and gives way to reading, zoom and navigation', async () => {
  let now = 0
  const { dom, restore } = createDom('<div id="root"></div><div id="scroller"></div>', {
    values: { performance: { now: () => now } },
  })
  const root = createRoot(dom.document.getElementById('root')!)
  const scroll = dom.document.getElementById('scroller')!
  const navigation = { current: false }
  let preview = false
  const Harness = ({ enabled }: { enabled: boolean }) => {
    preview = useReaderScrollPreview(scroll, enabled, navigation)
    return null
  }
  const move = async (distance: number, elapsed = 16) => {
    await act(async () => {
      now += elapsed
      scroll.scrollTop += distance
      scroll.dispatchEvent(new dom.Event('scroll'))
    })
  }
  try {
    await act(async () => root.render(React.createElement(Harness, { enabled: true })))
    await move(500, 100)
    await move(12)
    await move(120)
    assert.equal(preview, false, 'one large delta does not switch the raster')
    await move(120)
    assert.equal(preview, true)
    await move(120)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 105)) })
    assert.equal(preview, false, 'the sharp raster returns when fast movement stops')

    await move(120)
    await move(120)
    navigation.current = true
    await move(1000)
    assert.equal(preview, false, 'navigation cancels an active preview')
    navigation.current = false
    const zoom = { ownerKey: 'reader', source: [], page: 1, scale: 2,
      fraction: [0, 0] as const, pointer: [0, 0] as const, prepare() {}, complete() {}, cancel() {} }
    setWheelZoomReflow(scroll, zoom)
    await move(500)
    await move(500)
    assert.equal(preview, false, 'wheel zoom offsets do not count as scroll')
    clearWheelZoomReflow(scroll, zoom)

    await move(120)
    await move(120)
    assert.equal(preview, true)
    await act(async () => root.render(React.createElement(Harness, { enabled: false })))
    assert.equal(preview, false)
  } finally {
    await act(async () => root.unmount())
    restore()
  }
})
