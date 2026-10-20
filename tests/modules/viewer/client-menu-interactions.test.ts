import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { AnnotationColorBar } from '../../../src/modules/viewer/components/AnnotationColorBar.tsx'
import { HIGHLIGHT_QUICK_COLORS_KEY } from '../../../src/modules/viewer/model/highlight-colors.ts'
import { TranslationLanguageMenu } from '../../../src/modules/viewer/components/TranslationLanguageMenu.tsx'
import { PersonalBookmarks, type BookmarkAccess } from '../../../src/modules/viewer/components/PersonalBookmarks.tsx'
import { BookmarkPanel } from '../../../src/modules/viewer/components/BookmarkPanel.tsx'
import type { ReaderDocument, ReaderOutlineItem } from '../../../src/modules/viewer/ports/reader-document.ts'
import type { PdfUserBookmark } from '../../../src/shared/contracts.ts'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withDom(run: (dom: Window & typeof globalThis, container: HTMLElement,
  render: (element: React.ReactElement) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const values = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    CustomEvent: dom.CustomEvent, StorageEvent: dom.StorageEvent, localStorage: dom.localStorage,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!
  const rootView = createRoot(container)
  const render = async (element: React.ReactElement) => {
    await act(async () => { rootView.render(element) })
  }
  try { await run(dom, container, render) }
  finally {
    await act(async () => { rootView.unmount() })
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('highlight quick-color menu dismisses by Escape and outside pointer without applying a color', async () => {
  await withDom(async (dom, container, render) => {
    dom.localStorage.setItem(HIGHLIGHT_QUICK_COLORS_KEY, JSON.stringify(['#ffff00', '#ff9f0a']))
    const applied: string[] = []
    await render(React.createElement(AnnotationColorBar, {
      value: '#123456', label: 'Palette', t: key => key,
      onQuickColor: color => applied.push(color), onPaletteColor: color => applied.push(color),
    }))
    const first = container.querySelector<HTMLButtonElement>('[data-testid="pdf-highlight-swatch-0"]')!
    const menu = () => container.querySelector('[data-testid="pdf-highlight-color-menu"]')
    await act(async () => { first.dispatchEvent(new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    assert.ok(menu(), 'right-clicking a quick color opens its action menu')
    await act(async () => { dom.document.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
    assert.equal(menu(), null)
    assert.equal(dom.document.activeElement, first, 'Escape returns focus to the swatch')

    await act(async () => { first.dispatchEvent(new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    assert.ok(menu())
    await act(async () => { dom.document.body.dispatchEvent(new dom.Event('pointerdown', { bubbles: true })) })
    assert.equal(menu(), null, 'clicking outside dismisses the menu')
    assert.deepEqual(applied, [], 'dismissal must not mark the selected text')
    await act(async () => { first.click() })
    assert.deepEqual(applied, ['#ffff00'])
  })
})

test('translation language menu positions above a clipped panel and supports Escape and outside close', async () => {
  await withDom(async (dom, container, render) => {
    const selected: string[] = []
    await render(React.createElement('div', { className: 'dsh-pdf-panel-scroll' },
      React.createElement(TranslationLanguageMenu, {
        value: 'en', label: 'Target language', languageName: code => code.toUpperCase(), onChange: code => selected.push(code),
      })))
    const details = container.querySelector<HTMLDetailsElement>('details')!
    const panel = container.querySelector<HTMLElement>('.dsh-pdf-panel-scroll')!
    const menu = container.querySelector<HTMLElement>('.dsh-pdf-translation-language-menu')!
    const summary = details.querySelector('summary')!
    panel.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 130, width: 200, height: 130,
      x: 0, y: 0, toJSON() {} })
    details.getBoundingClientRect = () => ({ left: 20, right: 140, top: 85, bottom: 105, width: 120, height: 20,
      x: 20, y: 85, toJSON() {} })
    Object.defineProperty(menu, 'offsetWidth', { configurable: true, value: 160 })
    Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 90 })
    await act(async () => { details.open = true; details.dispatchEvent(new dom.Event('toggle')) })
    assert.equal(menu.style.bottom, 'calc(100% + 7px)', 'menu opens upward when space below is too short')
    await act(async () => { details.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
    assert.equal(details.open, false)
    assert.equal(dom.document.activeElement, summary)

    await act(async () => { details.open = true; details.dispatchEvent(new dom.Event('toggle')) })
    await act(async () => { dom.document.body.dispatchEvent(new dom.Event('pointerdown', { bubbles: true })) })
    assert.equal(details.open, false, 'outside pointer dismisses the language menu')
    await act(async () => { details.open = true; details.querySelector<HTMLButtonElement>('button[aria-label="EN"]')!.click() })
    assert.deepEqual(selected, [], 'reselecting current language does not issue an update')
    await act(async () => { details.open = true; details.querySelector<HTMLButtonElement>('button[aria-label="ZH"]')!.click() })
    assert.deepEqual(selected, ['zh'], 'choosing another language issues one update')
  })
})

test('personal bookmarks expose retry, failed rename and keyboard-safe actions', async () => {
  await withDom(async (dom, container, render) => {
    const bookmark: PdfUserBookmark = { id: 'bookmark-a', title: 'Original', stale: 'none',
      position: { page: 2, x: 0, y: 0, scale: 1, fit: 'page' }, createdAt: 'now', updatedAt: 'now' }
    let listFails = true
    let renameFails = true
    const access = {
      sessionId: 'session', documentId: 'document',
      capturePosition: () => ({ ...bookmark.position, documentVersion: 'v1' }),
      onNavigatePosition() {},
      api: { bookmarks: {
        async list() { if (listFails) throw new Error('listing unavailable'); return [bookmark] },
        async add() { return [bookmark] },
        async rename() { if (renameFails) throw new Error('rename unavailable'); return [{ ...bookmark, title: 'Updated' }] },
        async remove() { return [] },
      } },
    } as unknown as BookmarkAccess
    const view = React.createElement(PersonalBookmarks, { access, document: null, active: true, t: key => key })
    await render(view)
    await act(async () => { await Promise.resolve() })
    assert.match(container.textContent ?? '', /listing unavailable/)
    listFails = false
    await act(async () => {
      const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'reader.sidebar.retryBookmarks')!
      retry.click()
      await Promise.resolve()
    })
    const more = container.querySelector<HTMLButtonElement>('.dsh-pdf-bookmark-more')!
    assert.ok(more)
    await act(async () => { more.click() })
    assert.equal(more.getAttribute('aria-expanded'), 'true')
    await act(async () => { more.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    assert.equal(dom.document.activeElement, more)

    await act(async () => { more.click() })
    const rename = container.querySelector<HTMLButtonElement>('[aria-label="reader.sidebar.renameBookmark: Original"]')!
    await act(async () => { rename.click() })
    const title = container.querySelector<HTMLInputElement>('input[aria-label="reader.sidebar.bookmarkName"]')!
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set!
    await act(async () => { setter.call(title, 'Updated'); title.dispatchEvent(new dom.Event('input', { bubbles: true })) })
    await act(async () => { title.closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
    assert.match(container.textContent ?? '', /rename unavailable/)
    renameFails = false
    await act(async () => { title.closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
    assert.match(container.textContent ?? '', /Updated/)
  })
})

test('PDF outline retries a failed read and reveals the current nested bookmark', async () => {
  await withDom(async (_dom, container, render) => {
    let fail = true
    const outline: ReaderOutlineItem[] = [{ title: 'Chapter', dest: [0, { name: 'Fit' }], items: [
      { title: 'Section', dest: [2, { name: 'Fit' }], items: [] },
    ] }]
    const pdf = {
      numPages: 5,
      async getOutline() { if (fail) throw new Error('outline offline'); return outline },
      async getDestination() { return null }, async getPageIndex() { return 0 },
    } as unknown as ReaderDocument
    await render(React.createElement(BookmarkPanel, {
      pdf, active: true, currentPage: 3, onNavigateDestination() {}, t: key => key,
    }))
    await act(async () => { await Promise.resolve() })
    assert.match(container.textContent ?? '', /outline offline/)
    fail = false
    await act(async () => {
      const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'reader.sidebar.retryBookmarks')!
      retry.click()
      await Promise.resolve()
    })
    assert.match(container.textContent ?? '', /Chapter/)
    assert.match(container.textContent ?? '', /Section/)
    const section = [...container.querySelectorAll('[role="treeitem"]')]
      .find(row => row.textContent?.includes('Section'))
    assert.equal(section?.getAttribute('aria-current'), 'location', 'current nested destination is revealed')
  })
})
