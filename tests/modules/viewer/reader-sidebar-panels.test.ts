import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { HostOcrRecognition } from '../../../src/modules/viewer/ports/ocr.ts'
import { readerSidebarPanels, type ReaderSidebarPanelsOptions } from '../../../src/modules/viewer/components/ReaderSidebarPanels.tsx'

const snapshot = { id: 'doc-1', revision: 1, contentVersion: 'v1', reader: { bytesHash: 'hash-1' } } as WorkspaceSnapshot

async function withPanel(run: (fixture: {
  window: Window & typeof globalThis
  container: HTMLElement
  render(node: React.ReactNode): Promise<void>
}) => Promise<void>) {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  const values = {
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  installDom(values)
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const render = async (node: React.ReactNode) => { await act(async () => root.render(node)) }
  try { await run({ window: dom, container, render }) }
  finally {
    await act(async () => root.unmount())
    restoreDom()

  }
}

function options(): ReaderSidebarPanelsOptions {
  return {
    snapshot, pdf: null, annotations: [], selectedAnnotation: undefined,
    clearAnnotation() {}, selectAnnotation() {}, jump() {}, ocrTranscript: null,
    search: { query: '', setQuery() {}, searching: false, hits: [], searched: false,
      async run() {}, cancel() {}, invalidateDocument() {} },
    translation: { selection: null, begin() {}, beginOcr() { return false }, async translate() { throw new Error('unused') },
      close() {}, reset() {} },
    async rememberTargetLanguage() { return true }, translationEngine: 'dsh-model',
    translationRegistry: { list: () => [] } as unknown as ReaderSidebarPanelsOptions['translationRegistry'],
    t: key => key,
  }
}

test('sidebar panels render their empty states with shared scrolling chrome', async () => {
  await withPanel(async ({ container, render }) => {
    const panels = readerSidebarPanels(options())
    const sharedLayout = () => {
      const panel = container.querySelector('.dsh-pdf-panel')
      const heading = panel?.querySelector('.dsh-pdf-panel-heading')
      const scroll = panel?.querySelector('.dsh-pdf-panel-scroll')
      assert.ok(panel && heading && scroll)
      assert.equal(heading.parentElement, panel)
      assert.equal(scroll.parentElement, panel)
      assert.equal(scroll.contains(heading), false, 'the heading must never be inside scrolling content')
      assert.equal(panel.querySelectorAll('.dsh-pdf-panel-heading').length, 1)
    }
    await render(panels.annotations)
    const annotationsPanel = container.querySelector('.dsh-pdf-comments')
    const heading = annotationsPanel?.querySelector('.dsh-pdf-annotations-heading')
    const scroll = annotationsPanel?.querySelector('.dsh-pdf-panel-scroll')
    assert.ok(heading && scroll)
    assert.equal(heading.parentElement, annotationsPanel)
    assert.equal(scroll.parentElement, annotationsPanel)
    assert.equal(scroll.contains(heading), false)
    sharedLayout()
    await render(panels.ocr)
    assert.match(container.textContent ?? '', /reader\.ocrHint/)
    const ocrPanel = container.querySelector('.dsh-pdf-ocr-scroll')
    const ocrHeading = ocrPanel?.querySelector('.dsh-pdf-panel-heading')
    const ocrScroll = ocrPanel?.querySelector('.dsh-pdf-panel-scroll')
    assert.ok(ocrHeading && ocrScroll)
    assert.equal(ocrHeading.parentElement, ocrPanel)
    assert.equal(ocrScroll.contains(ocrHeading), false)
    sharedLayout()
    await render(panels.search)
    assert.equal(container.querySelector('input')?.placeholder, 'reader.searchPlaceholder')
    assert.equal(container.querySelector('button')?.disabled, true)
    sharedLayout()
    await render(panels.translation)
    assert.match(container.textContent ?? '', /reader\.sidebar\.translationHint/)
    sharedLayout()

    const base = options()
    await render(readerSidebarPanels({ ...base, translation: { ...base.translation,
      selection: { text: 'Selected original '.repeat(100), pages: [1], targetLanguage: 'zh',
        owner: 1, documentId: 'doc-1', contentVersion: 'v1' },
      async translate() { return { text: 'A long translation '.repeat(100), status: 'complete', warnings: [],
        document: { documentId: 'doc-1', contentVersion: 'v1' }, requestId: 1,
        source: { engineId: 'fixture', engineVersion: '1', instanceId: 'test', configurationRevision: '1' } } },
    } }).translation)
    sharedLayout()
    assert.ok(container.querySelector('.dsh-pdf-translation-text'))
    assert.ok(container.querySelector('.dsh-pdf-panel-heading button'), 'translation close action belongs to the fixed heading')
  })
})

test('sidebar uses only the current document OCR transcript and shows search origin', async () => {
  await withPanel(async ({ window, container, render }) => {
    const base = options()
    const translations: unknown[] = []
    const recognition = { documentId: 'doc-1', page: 7, revision: 1, contentVersion: 'v1',
      text: 'Recognized chapter', status: 'complete' as const,
      source: { backendId: 'test-ocr', backendVersion: '1' }, geometry: { status: 'none' as const }, warnings: [] }
    const region: [number, number, number, number] = [0, 0, 20, 20]
    const current = { ...base, ocrTranscript: { result: recognition, region },
      translation: { ...base.translation, beginOcr(result: HostOcrRecognition, range?: { start: number; end: number }) {
        translations.push({ result, range }); return true
      } },
      search: { ...base.search, searched: true, query: 'chapter', hits: [
        { page: 7, source: 'ocr' as const, text: 'Recognized chapter', x: 10, y: 20 },
      ] } }
    const panels = readerSidebarPanels(current)
    await render(panels.ocr)
    assert.match(container.textContent ?? '', /Recognized chapter/)
    assert.match(container.textContent ?? '', /reader\.ocrRegionResult/)
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-ocr-actions button')]
      .find(element => element.getAttribute('aria-label') === label || element.textContent === label)!
    await act(async () => { button('reader.ocrTranslateAll').click() })
    assert.deepEqual(translations, [{ result: recognition, range: undefined }])
    const pre = container.querySelector('.dsh-pdf-ocr-transcript')!
    const range = window.document.createRange()
    range.setStart(pre.firstChild!, 11); range.setEnd(pre.firstChild!, recognition.text.length)
    await act(async () => {
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
      window.document.dispatchEvent(new window.Event('selectionchange'))
    })
    await act(async () => { button('reader.ocrTranslateSelection').click() })
    assert.deepEqual(translations[1], { result: recognition, range: { start: 11, end: recognition.text.length } })
    await render(readerSidebarPanels({ ...current, snapshot: { ...snapshot, revision: 2 } }).ocr)
    assert.equal(button('reader.ocrTranslateAll'), undefined, 'an old OCR revision cannot start translation')
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

test('semantic index commands belong to search and do not submit a keyword search', async () => {
  await withPanel(async ({ container, render }) => {
    const calls: string[] = []
    const base = options()
    const indexing = { label: 'Index PDF', statusLabel: 'Not indexed', enabled: true, disabled: false,
      onStart: () => { calls.push('index') } }
    const props = { ...base, indexing, search: { ...base.search, async run() { calls.push('search') } } }
    await render(readerSidebarPanels(props).search)
    const section = () => container.querySelector<HTMLElement>('[aria-label="reader.indexing.title"]')!
    const button = section().querySelector<HTMLButtonElement>('button')!
    assert.equal(button.type, 'button')
    assert.equal(button.closest('form'), null)
    assert.equal(button.textContent, 'Index PDF')
    await act(async () => { button.click() })
    assert.deepEqual(calls, ['index'])

    await render(readerSidebarPanels({ ...props, indexing: { ...indexing, label: 'Rebuild index', statusLabel: 'Index ready' } }).search)
    assert.equal(section().querySelector('button')?.textContent, 'Rebuild index')
    assert.match(section().textContent ?? '', /Index ready/)
    await render(readerSidebarPanels({ ...props, indexing: { ...indexing, disabled: true, statusLabel: 'Indexing PDF…' } }).search)
    assert.equal(section().querySelector('button')?.disabled, true)
    await act(async () => { section().querySelector<HTMLButtonElement>('button')!.click() })
    assert.deepEqual(calls, ['index'])

    await render(readerSidebarPanels({ ...props, indexing: { ...indexing, enabled: false, disabled: true,
      statusLabel: 'Enable semantic search in PDF settings first' } }).search)
    assert.equal(section().querySelector('button'), null, 'unconfigured engines do not get an unusable command')
    assert.match(section().textContent ?? '', /Enable semantic search/)
    await render(readerSidebarPanels(base).search)
    assert.equal(container.querySelector('.dsh-pdf-search-indexing'), null)
  })
})
