import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { defaultSettings, type PdfClientApi, type WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderProps } from '../../../src/client/contracts.ts'
import { setWindowLayout, windowLayout } from '../../../src/modules/viewer/index.ts'

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
  return next(url, context)
} })

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

function snapshot(): WorkspaceSnapshot {
  const first = { page: 1, cropBox: [0, 0, 400, 600] as [number, number, number, number], rotation: 0, userUnit: 1 }
  return {
    id: 'navigation-document', path: '/tmp/reader-navigation.pdf', sourceVersion: 'source-1',
    contentVersion: 'contents-1', revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: 'sha256-navigation-test', generation: 1, protocolVersion: 1 },
    document: { pageCount: 2, pages: [first, { ...first, page: 2 }], annotations: [],
      signed: false, encrypted: false, readOnly: false },
  }
}

test('Reader restores the origin and reports a non-timeout layout read failure during navigation', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const canvasContext = Object.getOwnPropertyDescriptor(dom.HTMLCanvasElement.prototype, 'getContext')
  Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element,
    Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    PointerEvent: dom.PointerEvent ?? dom.MouseEvent, MutationObserver: dom.MutationObserver,
    DOMRect: dom.DOMRect, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }

  const { Reader } = await import('../../../src/client/Reader.tsx')
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const tab = new AbortController()
  const originalScrollTop = 83
  const api = {
    native: {
      async tile() { throw new Error('a non-visible page must not request tiles') },
      async text() { return { items: [], styles: {}, lang: null } },
      async links() { return [] }, async outline() { return null }, async destination() { return null },
    },
    bookmarks: { async list() { return [] }, async add() { return [] }, async rename() { return [] }, async remove() { return [] } },
    positions: { async get() { return null }, async set() {} },
    async open() { return snapshot() },
    async change() { return snapshot() }, async undo() { return snapshot() }, async redo() { return snapshot() },
    async reload() { return snapshot() }, async discard() { return snapshot() },
    async discardMany() {}, async discardAddresses() {},
    async inspectTarget() { return { version: null } }, async save() { return snapshot() },
    subscribe() { return () => {} },
  } as unknown as PdfClientApi
  const props = {
    resourceAddress: 'file:///tmp/reader-navigation.pdf', sessionId: 'session-1',
    scrollportRef() {}, useTabInfo: () => ({ tab: { id: 'tab-1', signal: tab.signal, visible: true } }),
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
    t: (key: string) => key, api,
    hostOcr: { async availability() { return { status: 'disabled' as const } }, async recognize() { throw new Error('not configured') } },
    imageUnderstanding: { async availability() { return { status: 'unavailable' as const, reason: 'not configured' } },
      async prepare() { throw new Error('not configured') } },
    translation: { list: () => [] }, settings: defaultSettings,
  } as unknown as ReaderProps
  try {
    await act(async () => { root.render(React.createElement(Reader, props)); await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const scrollRoot = container.querySelector<HTMLElement>('.dsh-pdf-scroll')!
    assert.ok(scrollRoot, 'the Reader has mounted its scrollport')
    Object.defineProperties(scrollRoot, { clientWidth: { value: 600 }, clientHeight: { value: 700 } })
    scrollRoot.scrollTop = originalScrollTop
    const layout = windowLayout(scrollRoot)!
    assert.equal(layout.length, 2)
    // A virtualizer update can invalidate the destination geometry while an
    // asynchronous navigation is waiting for it. The origin is still readable.
    const target = { ...layout[1]! }
    let targetScaleReads = 0
    Object.defineProperty(target, 'scale', { get() {
      targetScaleReads++
      throw new Error('The PDF destination layout is no longer readable')
    } })
    setWindowLayout(scrollRoot, [layout[0]!, target])
    const next = container.querySelector<HTMLButtonElement>('[aria-label="reader.next"]')!
    assert.equal(next.disabled, false)
    await act(async () => { next.click(); await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.ok(targetScaleReads >= 1)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /The PDF destination layout is no longer readable/)
    assert.equal(scrollRoot.scrollTop, originalScrollTop, 'a failed jump must restore the original scroll offset')
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value, '1')
  } finally {
    tab.abort()
    await act(async () => { root.unmount() })
    if (canvasContext) Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', canvasContext)
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
