import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import type { OutlineAccess } from '../../../src/modules/viewer/ports/outline.ts'
import type { PdfOutlineItem, PdfOutlineOperation } from '../../../src/core/pdf-types.ts'
import type { ReaderDocument } from '../../../src/modules/viewer/ports/reader-document.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis & { close(): void } } }
const t = (key: string) => key
const initial: PdfOutlineItem[] = [
  { id: 'chapter', title: 'Chapter', page: 1, children: [{ id: 'child', title: 'Section', page: 2, children: [] }] },
  { id: 'external', title: 'Website', children: [] },
]

async function withPanel(run: (fixture: {
  dom: Window & typeof globalThis; root: HTMLElement; calls: PdfOutlineOperation[][]
  render(access?: Partial<OutlineAccess>, active?: boolean): Promise<void>
  click(label: string): Promise<void>; key(target: Element, key: string, altKey?: boolean): Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root" class="dsh-pdf-reader"></div>').window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    Element: dom.Element, Node: dom.Node, Event: dom.Event, MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true }
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const { BookmarkPanel } = await import('../../../src/modules/viewer/components/BookmarkPanel.tsx')
  const { createRoot } = await import('react-dom/client')
  const root = dom.document.getElementById('root')!, view = createRoot(root)
  const calls: PdfOutlineOperation[][] = []
  const pdf = { numPages: 5, async getOutline() {
    return [{ id: 'chapter', title: 'Chapter', dest: [0, { name: 'Fit' }], items: [{ id: 'child', title: 'Section', dest: [1, { name: 'Fit' }], items: [] }] },
      { id: 'external', title: 'Website', url: 'https://example.com', items: [] }]
  } } as unknown as ReaderDocument
  const base: OutlineAccess = { documentId: 'doc', revision: 3, editable: true, busy: false, items: initial,
    async change(batch, revision) { assert.equal(revision, 3); calls.push(batch); return true } }
  const render = async (access?: Partial<OutlineAccess>, active = true) => { await act(async () => {
    view.render(React.createElement(BookmarkPanel, { pdf, active, currentPage: 4, outlineAccess: { ...base, ...access }, onNavigateDestination() {}, t }))
  }) }
  const click = async (label: string) => { await act(async () => {
    const button = [...root.querySelectorAll<HTMLElement>('button')].find(value => value.getAttribute('aria-label') === label || value.textContent === label || value.querySelector('span')?.textContent === label)
    assert.ok(button, `Missing button: ${label}`); button.click()
  }) }
  const key = async (target: Element, value: string, altKey = false) => { await act(async () => {
    target.dispatchEvent(new dom.KeyboardEvent('keydown', { key: value, altKey, bubbles: true, cancelable: true }))
  }) }
  try { await render(); await run({ dom, root, calls, render, click, key }) }
  finally {
    await act(async () => view.unmount()); dom.close()
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name)
    }
  }
}

test('adding an embedded bookmark opens one focused inline row; Escape leaves the PDF untouched', async () => {
  await withPanel(async ({ root, calls, click, key, dom }) => {
    assert.equal(root.querySelector('[aria-pressed]'), null)
    await click('reader.sidebar.addPdfBookmark')
    const input = root.querySelector<HTMLInputElement>('.dsh-pdf-outline-name-editor input')!
    assert.equal(dom.document.activeElement, input)
    assert.equal(input.value, 'reader.page 4')
    assert.ok(input.closest('[role=treeitem]'))
    await key(input, 'Escape')
    assert.equal(root.querySelector('.dsh-pdf-outline-name-editor'), null)
    assert.equal(calls.length, 0)
    await click('reader.sidebar.addPdfBookmark')
    await click('reader.sidebar.applyBookmarkName')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0].type, 'outline-add')
    assert.equal((calls[0][0] as Extract<PdfOutlineOperation, { type: 'outline-add' }>).page, 4)
  })
})

test('outline edit controls follow the title instead of adding a leading gutter', async () => {
  await withPanel(async ({ root, render, click }) => {
    const chapter = root.querySelector<HTMLElement>('[data-outline-id="chapter"]')!
    assert.equal(chapter.style.paddingLeft, '0px')
    const title = chapter.querySelector('.dsh-pdf-bookmark-title')!
    const grip = chapter.querySelector('.dsh-pdf-outline-grip')!
    const more = chapter.querySelector('.dsh-pdf-outline-more')!
    assert.ok(title.compareDocumentPosition(grip) & 4, 'the title precedes the drag handle')
    assert.ok(grip.compareDocumentPosition(more) & 4, 'the drag handle sits next to the action menu')
    if (!root.querySelector('[data-outline-id="child"]')) await click('reader.sidebar.expandBookmark')
    assert.equal(root.querySelector<HTMLElement>('[data-outline-id="child"]')!.style.paddingLeft, '14px')
    await render({ editable: false })
    assert.equal(chapter.style.paddingLeft, '0px', 'read-only and editable rows have the same leading inset')
    assert.equal(chapter.querySelector('.dsh-pdf-outline-grip'), null)
  })
})

test('bookmark panel has one heading and a create action only when editable', async () => {
  await withPanel(async ({ root, render }) => {
    const heading = () => root.querySelector('.dsh-pdf-panel-heading')!
    assert.equal(root.querySelectorAll('h3, h4').length, 1)
    assert.equal(heading().querySelector('h3')?.textContent, 'reader.sidebar.bookmarks')
    assert.equal(heading().querySelectorAll('button').length, 1)
    await render({ editable: false })
    assert.equal(root.querySelectorAll('h3, h4').length, 1)
    assert.equal(heading().querySelectorAll('button').length, 0)
  })
})

test('F2 and row menus rename in place without replacing an external destination', async () => {
  await withPanel(async ({ dom, root, calls, click, key }) => {
    await key(root.querySelector('[data-outline-id="external"]')!, 'F2')
    assert.equal(root.querySelector<HTMLInputElement>('.dsh-pdf-outline-name-editor input')!.value, 'Website')
    await key(root.querySelector('.dsh-pdf-outline-name-editor input')!, 'Escape')
    await click('reader.sidebar.moreBookmarkActions: Website')
    await click('reader.sidebar.renameBookmark')
    assert.ok(root.querySelector('[data-outline-id="external"] form'))
    assert.equal(root.querySelector('input[type=number]'), null)
    const input = root.querySelector<HTMLInputElement>('.dsh-pdf-outline-name-editor input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Documentation')
      input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    await click('reader.sidebar.applyBookmarkName')
    assert.deepEqual(calls, [[{ type: 'outline-update', id: 'external', patch: { title: 'Documentation' } }]])
  })
})

test('only an explicit destination action replaces the target and Escape restores menu-trigger focus', async () => {
  await withPanel(async ({ root, calls, click, key, dom }) => {
    await click('reader.sidebar.moreBookmarkActions: Website')
    await key(root.querySelector('[role=menu]')!, 'Escape')
    assert.equal(dom.document.activeElement?.getAttribute('aria-label'), 'reader.sidebar.moreBookmarkActions: Website')
    await click('reader.sidebar.moreBookmarkActions: Website')
    await click('reader.sidebar.changeBookmarkTarget')
    assert.equal(root.querySelector<HTMLInputElement>('input[type=number]')!.value, '')
    await click('reader.sidebar.useCurrentPage · 4')
    assert.deepEqual(calls, [[{ type: 'outline-update', id: 'external', patch: { page: 4 } }]])
    assert.equal(root.querySelector('[data-outline-popup]'), null)
  })
})

test('moving acts independently; descendant deletion asks once and retains shared draft operations', async () => {
  await withPanel(async ({ root, calls, click, key }) => {
    await key(root.querySelector('[data-outline-id="chapter"]')!, 'ArrowDown', true)
    assert.deepEqual(calls, [[{ type: 'outline-move', id: 'chapter', parentId: undefined, index: 1 }]])
    await click('reader.sidebar.moreBookmarkActions: Chapter')
    await click('reader.sidebar.deleteBookmark')
    assert.equal(calls.length, 1)
    assert.match(root.querySelector('[role=dialog]')?.textContent ?? '', /reader.sidebar.deleteBookmarkSubtree/)
    await click('reader.sidebar.confirmDeleteBookmark')
    assert.deepEqual(calls[1], [{ type: 'outline-delete', id: 'chapter' }])
  })
})

test('a stale inline draft cannot submit, and a document switch removes its input and popup', async () => {
  await withPanel(async ({ root, calls, click, render }) => {
    await click('reader.sidebar.addPdfBookmark')
    await render({ revision: 4 })
    assert.match(root.querySelector('[role=alert]')?.textContent ?? '', /reader.sidebar.outlineChanged/)
    assert.equal(root.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled, true)
    await click('reader.sidebar.applyBookmarkName')
    assert.deepEqual(calls, [])
    await render({ documentId: 'another-document', revision: 4 })
    assert.equal(root.querySelector('.dsh-pdf-outline-name-editor'), null)
    assert.equal(root.querySelector('[data-outline-popup]'), null)
  })
})

test('failed changes keep the inline name available for retry; a pending submit cannot be repeated', async () => {
  await withPanel(async ({ root, click, render }) => {
    let attempts = 0, finish!: (success: boolean) => void
    await render({ change() { attempts++; return new Promise<boolean>(resolve => { finish = resolve }) } })
    await click('reader.sidebar.addPdfBookmark')
    await click('reader.sidebar.applyBookmarkName')
    await click('reader.sidebar.applyBookmarkName')
    assert.equal(attempts, 1)
    await act(async () => { finish(false) })
    assert.ok(root.querySelector('.dsh-pdf-outline-name-editor input'))
    assert.match(root.querySelector('[role=alert]')?.textContent ?? '', /reader.sidebar.outlineChangeFailed/)
  })
})

test('hiding the bookmark panel closes its portaled menu but keeps an unsubmitted name', async () => {
  await withPanel(async ({ root, click, render }) => {
    await click('reader.sidebar.moreBookmarkActions: Website')
    assert.ok(root.querySelector('[role=menu]'))
    await render(undefined, false)
    assert.equal(root.querySelector('[role=menu]'), null)
    await render()
    await click('reader.sidebar.addPdfBookmark')
    await render(undefined, false)
    await render()
    assert.equal(root.querySelector<HTMLInputElement>('.dsh-pdf-outline-name-editor input')?.value, 'reader.page 4')
  })
})

test('outline menu keyboard navigation and move actions share the undoable operation path', async () => {
  await withPanel(async ({ dom, root, calls, click, key }) => {
    const chapter = root.querySelector('[data-outline-id="chapter"]')!
    if (chapter.getAttribute('aria-expanded') === 'true') await key(chapter, 'ArrowLeft')
    await key(chapter, 'ArrowRight')
    assert.equal(chapter.getAttribute('aria-expanded'), 'true')
    await key(chapter, 'ArrowLeft')
    assert.equal(chapter.getAttribute('aria-expanded'), 'false')
    await click('reader.sidebar.moreBookmarkActions: Chapter')
    const menu = root.querySelector('[role=menu]')!
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    await key(menu, 'End')
    assert.equal(dom.document.activeElement, buttons.at(-1))
    await key(menu, 'Home')
    assert.equal(dom.document.activeElement, buttons[0])
    await key(menu, 'ArrowDown')
    assert.equal(dom.document.activeElement, buttons[1])
    await key(menu, 'ArrowUp')
    assert.equal(dom.document.activeElement, buttons[0])
    await click('reader.sidebar.moveBookmarkDown')
    assert.deepEqual(calls, [[{ type: 'outline-move', id: 'chapter', parentId: undefined, index: 1 }]])
    assert.equal(root.querySelector('[role=menu]'), null)
  })
})

test('unchanged names do not write, and thrown write errors retain an editable draft for retry', async () => {
  await withPanel(async ({ root, calls, click, key, render }) => {
    await key(root.querySelector('[data-outline-id="external"]')!, 'F2')
    await click('reader.sidebar.applyBookmarkName')
    assert.equal(root.querySelector('.dsh-pdf-outline-name-editor'), null)
    assert.deepEqual(calls, [])
    await render({ async change() { throw new Error('Draft storage unavailable') } })
    await click('reader.sidebar.addPdfBookmark')
    await click('reader.sidebar.applyBookmarkName')
    assert.match(root.querySelector('[role=alert]')?.textContent ?? '', /Draft storage unavailable/)
    assert.ok(root.querySelector('.dsh-pdf-outline-name-editor input'))
  })
})

test('dragging a parent into its descendant rejects the drop without changing the outline', async () => {
  await withPanel(async ({ dom, root, calls, key }) => {
    const chapter = root.querySelector('[data-outline-id="chapter"]')!
    if (chapter.getAttribute('aria-expanded') !== 'true') await key(chapter, 'ArrowRight')
    const child = root.querySelector('[data-outline-id="child"]')!
    const grip = chapter.querySelector('.dsh-pdf-outline-grip')!
    const transfer = { effectAllowed: '', dropEffect: 'move', setData() {}, setDragImage() {} }
    const drag = async (target: Element, type: string) => { await act(async () => {
      const event = new dom.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      Object.defineProperties(event, { clientX: { value: 0 }, clientY: { value: 0 } })
      target.dispatchEvent(event)
    }) }
    await drag(grip, 'dragstart')
    await drag(child, 'dragover')
    assert.equal(transfer.dropEffect, 'none')
    assert.equal(root.querySelector('[data-drop-placement]'), null)
    assert.deepEqual(calls, [])
    await drag(grip, 'dragend')
  })
})
