import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { readerSidebarPanels, type ReaderSidebarPanelsOptions } from '../../../src/modules/viewer/components/ReaderSidebarPanels.tsx'

const snapshot = { id: 'doc-1', contentVersion: 'v1', reader: { bytesHash: 'hash-1' } } as WorkspaceSnapshot
const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withPanel(run: (fixture: {
  window: Window & typeof globalThis
  container: HTMLElement
  render(node: React.ReactNode): Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const values = {
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const render = async (node: React.ReactNode) => { await act(async () => root.render(node)) }
  try { await run({ window: dom, container, render }) }
  finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

function options(): ReaderSidebarPanelsOptions {
  return {
    snapshot, pdf: null, annotations: [], selectedAnnotation: undefined,
    clearAnnotation() {}, selectAnnotation() {}, jump() {}, ocrTranscript: null,
    search: { query: '', setQuery() {}, searching: false, hits: [], searched: false,
      async run() {}, cancel() {}, invalidateDocument() {}, resetContent() {} },
    translation: { selection: null, begin() {}, async translate() { throw new Error('unused') },
      close() {}, reset() {} },
    async rememberTargetLanguage() { return true }, translationEngine: 'dsh-model',
    translationRegistry: { list: () => [] } as unknown as ReaderSidebarPanelsOptions['translationRegistry'],
    t: key => key,
  }
}

test('sidebar panels render their empty states with shared scrolling chrome', async () => {
  await withPanel(async ({ container, render }) => {
    const panels = readerSidebarPanels(options())
    await render(panels.annotations)
    const annotationsPanel = container.querySelector('.dsh-pdf-comments')
    const heading = annotationsPanel?.querySelector('.dsh-pdf-annotations-heading')
    const scroll = annotationsPanel?.querySelector('.dsh-pdf-panel-scroll')
    assert.ok(heading && scroll)
    assert.equal(heading.parentElement, annotationsPanel)
    assert.equal(scroll.parentElement, annotationsPanel)
    assert.equal(scroll.contains(heading), false)
    await render(panels.ocr)
    assert.match(container.textContent ?? '', /reader\.ocrHint/)
    const ocrPanel = container.querySelector('.dsh-pdf-ocr-scroll')
    const ocrHeading = ocrPanel?.querySelector('.dsh-pdf-panel-heading')
    const ocrScroll = ocrPanel?.querySelector('.dsh-pdf-panel-scroll')
    assert.ok(ocrHeading && ocrScroll)
    assert.equal(ocrHeading.parentElement, ocrPanel)
    assert.equal(ocrScroll.contains(ocrHeading), false)
    await render(panels.search)
    assert.equal(container.querySelector('input')?.placeholder, 'reader.searchPlaceholder')
    assert.equal(container.querySelector('button')?.disabled, true)
    await render(panels.translation)
    assert.match(container.textContent ?? '', /reader\.sidebar\.translationHint/)
  })
})

test('sidebar uses only the current document OCR transcript and shows search origin', async () => {
  await withPanel(async ({ container, render }) => {
    const base = options()
    const recognition = { documentId: 'doc-1', page: 7, revision: 1, contentVersion: 'v1',
      text: 'Recognized chapter', status: 'complete' as const,
      source: { backendId: 'test-ocr', backendVersion: '1' }, geometry: { status: 'none' as const }, warnings: [] }
    const region: [number, number, number, number] = [0, 0, 20, 20]
    const current = { ...base, ocrTranscript: { result: recognition, region },
      search: { ...base.search, searched: true, query: 'chapter', hits: [
        { page: 7, source: 'ocr' as const, text: 'Recognized chapter', x: 10, y: 20 },
      ] } }
    const panels = readerSidebarPanels(current)
    await render(panels.ocr)
    assert.match(container.textContent ?? '', /Recognized chapter/)
    assert.match(container.textContent ?? '', /reader\.ocrRegion/)
    await render(panels.search)
    assert.match(container.textContent ?? '', /reader\.ocrText/)
    const stale = readerSidebarPanels({ ...current, ocrTranscript: { result: { ...recognition, contentVersion: 'older' }, region: undefined } })
    await render(stale.ocr)
    assert.doesNotMatch(container.textContent ?? '', /Recognized chapter/)
    assert.match(container.textContent ?? '', /reader\.ocrHint/)
  })
})

test('search results and form route user actions to the Reader controllers', async () => {
  await withPanel(async ({ window, container, render }) => {
    const actions: string[] = []
    const base = options()
    const props: ReaderSidebarPanelsOptions = {
      ...base, pdf: {} as ReaderSidebarPanelsOptions['pdf'],
      search: { ...base.search, query: 'chapter', searched: true, hits: [
        { page: 7, source: 'ocr', text: 'Chapter heading', x: 10, y: 20 },
      ], setQuery: value => actions.push(`query:${value}`), async run() { actions.push('search') } },
      jump: (page, point) => actions.push(`jump:${page}:${point?.x ?? ''}:${point?.y ?? ''}`),
    }
    await render(readerSidebarPanels(props).search)
    await act(async () => container.querySelector<HTMLButtonElement>('.dsh-pdf-search-hit')!.click())
    const form = container.querySelector('form')!
    await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(actions, ['jump:7:10:20', 'search'])
  })
})
