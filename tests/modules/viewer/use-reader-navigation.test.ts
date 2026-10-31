import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NavigationHistory, type NavigationPosition } from '../../../src/navigation/index.ts'
import type { PdfClientApi } from '../../../src/shared/contracts.ts'
import { useReaderNavigation, type ReaderNavigationOptions } from '../../../src/modules/viewer/index.ts'
import { navigateAgentRequest } from '../../../src/modules/viewer/controllers/agent-text-navigation.ts'
import { NativeViewport, setWindowLayout, buildPageLayout, READING_TOP_INSET } from '../../../src/modules/viewer/index.ts'
import type { NativeDocument, PageView } from '../../../src/modules/viewer/index.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { AgentNavigationRequest } from '../../../src/contracts/navigation.ts'

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

for (const resumePage of [1, 2]) test(resumePage === 1
  ? 'a successful in-memory resume restores and persists the saved location'
  : 'a failed in-memory resume cannot overwrite the saved position until a later jump succeeds', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setImmediate(() => callback(performance.now())) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!), tab = new AbortController()
  const scroll = dom.document.createElement('div'), element = dom.document.createElement('div')
  const page = { page: 1, cropBox: [0, 0, 400, 600] as [number, number, number, number], rotation: 0, userUnit: 1 }
  const snapshot = { id: 'doc', contentVersion: 'v1', document: { pageCount: 1, pages: [page] } } as WorkspaceSnapshot
  const document = { snapshot } as NativeDocument
  const bounds = (top: number) => ({ left: 0, top, right: 400, bottom: top + 600, width: 400, height: 600 } as DOMRect)
  Object.defineProperties(scroll, { clientWidth: { value: 400 }, clientHeight: { value: 600 }, scrollWidth: { value: 400 } })
  scroll.getBoundingClientRect = () => bounds(0)
  element.getBoundingClientRect = () => bounds(READING_TOP_INSET - scroll.scrollTop)
  setWindowLayout(scroll, buildPageLayout([page], () => 1, 0, READING_TOP_INSET))
  const state: ReaderNavigationOptions['state'] = { current: { snapshot, scrollRoot: scroll,
    fit: 'custom', zoom: 1, size: { width: 400, height: 600 }, currentPage: 1 } }
  const position: NavigationPosition = { documentVersion: 'v1', page: resumePage, x: 0, y: 300, fit: 'custom', scale: 1 }
  const writes: Array<{ page: number }> = [], errors: unknown[] = []
  let storedReads = 0
  const options: ReaderNavigationOptions = {
    api: { positions: { async get() { storedReads++; return null },
      async set(_session: string, _id: string, value: { page: number }) { writes.push(value) } } } as unknown as PdfClientApi,
    sessionId: 'session', tabSignal: tab.signal, contentRevision: 1, pdf: document, snapshot,
    scrollRoot: scroll, currentPage: 1, historyCapacity: 10,
    lifetime: { history: new NavigationHistory({ capacity: 10 }), position, ocrPages: new Map() }, state,
    views: { current: new Map([[1, { element, viewport: new NativeViewport(page, 1) } as unknown as PageView]]) },
    setCurrentPage: value => { state.current.currentPage = value }, setPageInput() {},
    setZoom: value => { state.current.zoom = value }, setFit: value => { state.current.fit = value },
    setPositionNotice() {}, onError: failure => errors.push(failure), t: key => key,
  }
  let navigation!: ReturnType<typeof useReaderNavigation>
  const Harness = () => { navigation = useReaderNavigation(options); return null }
  try {
    await act(async () => { root.render(React.createElement(Harness)); await new Promise(resolve => setImmediate(resolve)) })
    await act(async () => { while (navigation.navigationLock.current) await new Promise(resolve => setImmediate(resolve)) })
    assert.deepEqual(errors.map(error => (error as Error).message), resumePage === 2 ? ['reader.invalidDestination'] : [])
    assert.equal(navigation.navigating, false)
    assert.equal(storedReads, 0, 'the in-memory resume takes precedence over stored positions')
    assert.equal(writes.length, resumePage === 2 ? 0 : 1, 'only a successful restore may persist its destination')
    if (resumePage === 1) assert.ok(Math.abs(navigation.capture().y - position.y) < 0.001)
    let completed = false
    await act(async () => { completed = await navigation.jump(1, { y: 200 }) })
    assert.equal(completed, true)
    assert.equal(writes.length, resumePage === 2 ? 1 : 2)
    assert.equal(writes[0]?.page, 1, 'a successful user jump resumes normal position persistence')
  } finally {
    tab.abort(); await act(async () => root.unmount()); dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

for (const padded of [false, true]) test(`exact evidence jumps use the Reader history for cross-page and same-page Back and history-menu restores${padded ? ' with asymmetric floating gutters' : ''}`, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setImmediate(() => callback(performance.now())) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController(), scroll = dom.document.createElement('div')
  const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
  const text = 'quote at the top; quote at the bottom'
  const snapshot = { id: 'doc', revision: 4, contentVersion: 'v1', reader: { bytesHash: hash('bytes') },
    document: { pageCount: 3, pages: [1, 2, 3].map(page => ({ page, cropBox: [10, 20, 410, 620], userUnit: 1, rotation: 0 })) } } as WorkspaceSnapshot
  const document = { snapshot, text: async () => ({ items: [{ str: text }] }) } as unknown as NativeDocument
  const padding = padded ? { paddingLeft: 86, paddingRight: 170 } : undefined
  if (padding) { scroll.style.paddingLeft = `${padding.paddingLeft}px`; scroll.style.paddingRight = `${padding.paddingRight}px` }
  const state: ReaderNavigationOptions['state'] = { current: { snapshot, scrollRoot: scroll,
    zoom: 1.5, fit: 'custom', size: { width: 500, height: 400, ...padding }, currentPage: 1 } }
  Object.defineProperties(scroll, { clientWidth: { value: 500 }, clientHeight: { value: 400 },
    scrollWidth: { get: () => Math.max(500, 400 * state.current.zoom + (padding ? padding.paddingLeft + padding.paddingRight : 0)) } })
  scroll.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 } as DOMRect)
  const views: ReaderNavigationOptions['views'] = { current: new Map() }
  const layout = () => {
    const pages = buildPageLayout(snapshot.document.pages, () => state.current.zoom, 0, READING_TOP_INSET).map(page => ({ ...page,
      ...(padding ? { left: padding.paddingLeft + (scroll.scrollWidth - padding.paddingLeft - padding.paddingRight - page.width) / 2 } : {}) }))
    setWindowLayout(scroll, pages)
    views.current.clear()
    for (const page of pages) {
      const viewport = new NativeViewport(snapshot.document.pages[page.page - 1], page.scale)
      const element = dom.document.createElement('div')
      element.getBoundingClientRect = () => {
        const left = (page.left ?? (scroll.scrollWidth - page.width) / 2) - scroll.scrollLeft, top = page.top - scroll.scrollTop
        return { left, top, right: left + page.width, bottom: top + page.height, width: page.width, height: page.height } as DOMRect
      }
      views.current.set(page.page, { element, viewport } as unknown as PageView)
    }
  }
  layout(); scroll.scrollTop = 180; scroll.scrollLeft = 35
  const history = new NavigationHistory({ capacity: 10 }), errors: unknown[] = []
  let failAfterMove = false
  const options: ReaderNavigationOptions = {
    api: { positions: { async get() { return null }, async set() {} } } as unknown as PdfClientApi,
    sessionId: 'session', tabSignal: tab.signal, contentRevision: 1, pdf: document, snapshot,
    scrollRoot: scroll, currentPage: 1, historyCapacity: 10, lifetime: { history, ocrPages: new Map() }, state, views,
    setCurrentPage: page => { state.current.currentPage = page; if (failAfterMove) state.current.snapshot = { ...snapshot, revision: 5 } },
    setPageInput() {}, setZoom: zoom => { state.current.zoom = zoom; layout() }, setFit: fit => { state.current.fit = fit },
    setPositionNotice() {}, onError: failure => errors.push(failure), t: key => key,
  }
  let navigation!: ReturnType<typeof useReaderNavigation>
  const Harness = () => { navigation = useReaderNavigation(options); return null }
  const request = (page: number, y: number, second = false): AgentNavigationRequest => ({
    requestId: crypto.randomUUID(), documentId: 'doc', contentVersion: 'v1', page,
    target: { kind: 'text', refId: 'ref', revision: 4, sourceDigest: hash('bytes'), pageTextDigest: hash(text),
      startUtf16: second ? text.lastIndexOf('quote') : 0, endUtf16: (second ? text.lastIndexOf('quote') : 0) + 5,
      textSha256: hash('quote'), rectPdf: [40, y - 10, 90, y], quadPoints: [40, y, 90, y, 40, y - 10, 90, y - 10] } })
  const navigate = async (value: AgentNavigationRequest) => {
    let result: unknown
    await act(async () => { result = await navigateAgentRequest(value, tab.signal, {
      current: () => ({ snapshot: state.current.snapshot, document, visible: true, ready: true, viewportHeight: 400 }),
      subscribe: () => () => {}, jump: (...args) => navigation.jump(...args),
    }) })
    assert.equal(result, 'opened')
  }
  const back = async (depth?: number) => {
    await act(async () => {
      navigation.navigateHistory(depth, depth === undefined ? undefined : navigation.historySnapshot.revision)
      while (navigation.navigationLock.current) await new Promise(resolve => setImmediate(resolve))
    })
  }
  const samePosition = (actual: NavigationPosition, expected: NavigationPosition) => {
    for (const key of ['page', 'fit', 'documentVersion'] as const) assert.equal(actual[key], expected[key])
    for (const key of ['x', 'y', 'scale'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 0.001, key)
  }
  try {
    await act(async () => { root.render(React.createElement(Harness)); await new Promise(resolve => setImmediate(resolve)) })
    const original = navigation.capture()
    await navigate(request(2, 500))
    assert.equal(history.size, 1)
    state.current.zoom = 1.8; layout()
    const secondOrigin = navigation.capture()
    await navigate(request(2, 220, true))
    assert.equal(history.size, 2, 'different evidence positions on the same page must not collapse to a no-op')
    await back()
    samePosition(navigation.capture(), secondOrigin)
    assert.equal(state.current.zoom, 1.8)
    await back()
    samePosition(navigation.capture(), original)
    assert.equal(state.current.zoom, 1.5)
    assert.equal(history.size, 0)
    await navigate(request(2, 500))
    await navigate(request(3, 220, true))
    await back(1)
    samePosition(navigation.capture(), original)
    assert.equal(history.size, 0, 'history menu removes the selected destination and all newer entries only after arrival')
    assert.deepEqual(errors, [])
    const beforeFailure = navigation.capture()
    failAfterMove = true
    let failed: unknown
    await act(async () => { failed = await navigateAgentRequest(request(2, 300), tab.signal, {
      current: () => ({ snapshot: state.current.snapshot, document, visible: true, ready: true, viewportHeight: 400 }),
      subscribe: () => () => {}, jump: (...args) => navigation.jump(...args),
    }) })
    assert.notEqual(failed, 'opened')
    samePosition(navigation.capture(), beforeFailure)
    assert.equal(history.size, 0, 'a failed post-layout revision check must roll back without adding a return entry')
  } finally {
    tab.abort(); await act(async () => root.unmount()); dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
