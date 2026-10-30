import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnotationCommentCard } from '../../../src/modules/viewer/components/AnnotationCommentCard.tsx'
import { ExplanationQuestionEditor } from '../../../src/modules/viewer/components/ExplanationQuestionEditor.tsx'
import { FloatingToolbar } from '../../../src/modules/viewer/components/FloatingToolbar.tsx'
import { ReadingSidebar } from '../../../src/modules/viewer/components/ReadingSidebar.tsx'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {},
})

async function withReader(run: (fixture: {
  dom: Window & typeof globalThis
  reader: HTMLElement
  viewport: HTMLElement
  mount: HTMLElement
  render(node: React.ReactElement): Promise<void>
  resize(target: Element): Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div class="dsh-pdf-reader"><nav data-pdf-tool-rail class="dsh-pdf-floating-controls"><div class="dsh-pdf-floating-controls-layout"><div class="dsh-pdf-main-toolbar"></div></div></nav><div id="viewport" tabindex="0"></div><div id="mount"></div></div>',
    { url: 'http://localhost' }).window
  const observers = new Set<Observer>()
  class Observer {
    targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { observers.delete(this) }
  }
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const globals = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, Event: dom.Event, ResizeObserver: Observer, localStorage: dom.localStorage,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperties(dom.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} }, detachEvent: { configurable: true, value() {} },
    offsetWidth: { configurable: true, get() {
      const element = this as HTMLElement
      return Math.min(Number.parseFloat(element.style.maxWidth) || Infinity,
        Number.parseFloat(element.style.width) || 200)
    } },
    offsetHeight: { configurable: true, get() {
      const element = this as HTMLElement
      const natural = element.classList.contains('dsh-pdf-context-toolbar') ? 40
        : element.classList.contains('dsh-pdf-page-comment-card') ? 100 : 180
      return Math.min(natural, Number.parseFloat(element.style.maxHeight) || Infinity)
    } },
  })
  const reader = dom.document.querySelector<HTMLElement>('.dsh-pdf-reader')!
  const viewport = dom.document.getElementById('viewport')!
  const mount = dom.document.getElementById('mount')!
  reader.getBoundingClientRect = () => rect(30, 40, 780, 400)
  viewport.getBoundingClientRect = () => rect(110, 90, 400, 350)
  for (const controls of reader.querySelectorAll<HTMLElement>('nav, .dsh-pdf-floating-controls-layout, .dsh-pdf-main-toolbar'))
    controls.getBoundingClientRect = () => rect(30, 40, 80, 400)
  const root = createRoot(mount)
  try {
    await run({ dom, reader, viewport, mount,
      render: async node => { await act(async () => root.render(node)) },
      resize: async target => { await act(async () => {
        for (const observer of observers) if (observer.targets.has(target))
          observer.callback([], observer as unknown as ResizeObserver)
        await new Promise(resolve => setTimeout(resolve, 10))
      }) },
    })
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('page action bars remain visible beside a full-height rail and follow the actual PDF bounds', async () => {
  await withReader(async ({ reader, viewport, render, dom }) => {
    let anchor = rect(114, 94, 80, 18)
    await render(React.createElement(FloatingToolbar, { viewport, getAnchor: () => anchor,
      label: 'Selection actions', children: React.createElement('button', null, 'Highlight') }))
    const toolbar = reader.querySelector<HTMLElement>('.dsh-pdf-context-toolbar')!
    assert.equal(toolbar.dataset.visible, 'true', 'the rail bottom cannot suppress actions near the page top')
    assert.ok(Number.parseFloat(toolbar.style.left) >= 88, 'actions clear the left tool rail')
    assert.ok(Number.parseFloat(toolbar.style.top) + 40 <= 392, 'actions stay within the PDF scrollport')
    anchor = rect(490, 420, 20, 14)
    await act(async () => {
      viewport.dispatchEvent(new dom.Event('pdflayoutchange'))
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    assert.equal(toolbar.dataset.visible, 'true')
    assert.ok(Number.parseFloat(toolbar.style.left) + 200 <= 472, 'the right reading sidebar is excluded')
    assert.ok(Number.parseFloat(toolbar.style.top) + 40 < anchor.top - 40, 'bottom-edge actions flip above their anchor')
  })
})

test('comment and note cards at the page top are bounded by the PDF instead of the rail bottom', async () => {
  await withReader(async ({ reader, viewport, render }) => {
    const props = { viewport, getAnchor: () => rect(114, 94, 20, 18), label: 'Comment',
      children: React.createElement('button', null, 'Edit') }
    for (const cardKind of ['comment', 'note'] as const) {
      await render(React.createElement(AnnotationCommentCard, { ...props, cardKind, connector: cardKind === 'comment' }))
      const card = reader.querySelector<HTMLElement>('.dsh-pdf-page-comment-card')!
      assert.equal(card.dataset.visible, 'true', `${cardKind} opens next to a page-top mark`)
      assert.ok(Number.parseFloat(card.style.left) >= 92)
      assert.ok(Number.parseFloat(card.style.left) + Number.parseFloat(card.style.width) <= 468)
      assert.ok(Number.parseFloat(card.style.top) >= 62)
      assert.ok(Number.parseFloat(card.style.top) + card.offsetHeight <= 388)
    }
  })
})

for (const annotation of [false, true]) test(`a short narrow column scrolls its comment clear of ${annotation ? 'annotation' : 'selection'} actions`, async () => {
  await withReader(async ({ dom, reader, viewport, render, resize }) => {
    reader.getBoundingClientRect = () => rect(0, 0, 240, 320)
    viewport.getBoundingClientRect = () => rect(80, 0, 116, 320)
    let anchor = rect(108, 40, 58, 42)
    let anchorReads = 0
    const getAnchor = () => { anchorReads++; return anchor }
    await render(React.createElement(React.Fragment, null,
      React.createElement(FloatingToolbar, { viewport, getAnchor, label: 'Actions',
        className: annotation ? 'dsh-pdf-annotation-toolbar' : undefined,
        children: React.createElement('button', null, 'Copy') }),
      React.createElement(AnnotationCommentCard, { viewport, getAnchor, label: 'Comment',
        children: React.createElement('textarea', { 'aria-label': 'Comment text', defaultValue: 'Still editable' }) })))
    const toolbar = reader.querySelector<HTMLElement>('.dsh-pdf-context-toolbar')!
    const card = reader.querySelector<HTMLElement>('.dsh-pdf-page-comment-card')!
    let naturalHeight = 152
    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 78 })
    Object.defineProperties(card, {
      offsetHeight: { configurable: true, get: () => Math.min(naturalHeight, Number.parseFloat(card.style.maxHeight) || Infinity) },
      clientHeight: { configurable: true, get: () => card.offsetHeight },
      scrollHeight: { configurable: true, get: () => naturalHeight },
    })
    toolbar.getBoundingClientRect = () => rect(Number.parseFloat(toolbar.style.left),
      Number.parseFloat(toolbar.style.top), toolbar.offsetWidth, toolbar.offsetHeight)
    await resize(toolbar)
    assert.equal(toolbar.dataset.visible, 'true')
    assert.equal(card.dataset.visible, 'true')
    assert.equal(card.style.maxHeight, '129px', 'the editor scrolls in the room below the 78px action bar')
    assert.equal(Number.parseFloat(card.style.top), 179)
    assert.ok(Number.parseFloat(card.style.top) + card.offsetHeight <= 308)
    card.querySelector('textarea')!.focus()
    assert.equal(reader.ownerDocument.activeElement, card.querySelector('textarea'), 'constrained comments retain editable controls')

    // Model the browser's synchronous scroll clamp when max-height expands.
    // A long wrapped editor must retain the footer after the user scrolls to it.
    naturalHeight = 420
    let maximumHeight = card.style.maxHeight, scrollTop = 0
    Object.defineProperty(card, 'scrollTop', { configurable: true, get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, naturalHeight - card.clientHeight)) } })
    Object.defineProperty(card.style, 'maxHeight', { configurable: true, get: () => maximumHeight,
      set: (value: string) => { maximumHeight = value; card.scrollTop = scrollTop } })
    card.scrollTop = card.scrollHeight - card.clientHeight
    const footerScroll = card.scrollTop
    const readsBeforeScroll = anchorReads
    await act(async () => {
      card.dispatchEvent(new dom.Event('scroll'))
      card.querySelector('textarea')!.dispatchEvent(new dom.Event('scroll'))
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    assert.equal(anchorReads, readsBeforeScroll, 'internal editor scrolling cannot feed back into anchor layout')
    await resize(card)
    await resize(card)
    assert.equal(card.scrollTop, footerScroll, 'repeated geometry updates leave the scrolled footer visible')
    assert.equal(card.style.maxHeight, '129px')

    naturalHeight = 152
    anchor = rect(108, 130, 58, 42)
    await resize(toolbar)
    assert.ok(Number.parseFloat(card.style.top) + card.offsetHeight + 12 <= toolbar.getBoundingClientRect().top,
      'an action bar that only moves still notifies the card to use the free region above it')
    assert.equal(card.style.maxHeight, '296px', 'the full card height is restored when the free region permits it')
  })
})

test('a tall annotation action bar shares a short column with its editor and keeps every action scrollable', async () => {
  await withReader(async ({ reader, viewport, render, resize }) => {
    reader.getBoundingClientRect = () => rect(0, 0, 240, 320)
    viewport.getBoundingClientRect = () => rect(80, 0, 116, 320)
    const getAnchor = () => rect(108, 40, 58, 42)
    const draw = (withCard: boolean) => render(React.createElement(React.Fragment, null,
      React.createElement(FloatingToolbar, { viewport, getAnchor, label: 'Annotation actions',
        className: 'dsh-pdf-annotation-toolbar', children: Array.from({ length: 8 }, (_, index) =>
          React.createElement('button', { key: index }, `Action ${index + 1}`)) }),
      withCard && React.createElement(AnnotationCommentCard, { viewport, getAnchor, label: 'Comment',
        children: React.createElement('textarea', { 'aria-label': 'Comment text' }) })))
    await draw(true)
    const toolbar = reader.querySelector<HTMLElement>('.dsh-pdf-context-toolbar')!
    const card = reader.querySelector<HTMLElement>('.dsh-pdf-page-comment-card')!
    let maximumHeight = toolbar.style.maxHeight, scrollTop = 0, naturalHeight = 246
    Object.defineProperties(toolbar, {
      offsetHeight: { configurable: true, get: () => Math.min(naturalHeight, Number.parseFloat(toolbar.style.maxHeight) || Infinity) },
      clientHeight: { configurable: true, get: () => toolbar.offsetHeight },
      scrollHeight: { configurable: true, get: () => naturalHeight },
      scrollTop: { configurable: true, get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(value, toolbar.scrollHeight - toolbar.clientHeight)) } },
    })
    Object.defineProperty(toolbar.style, 'maxHeight', { configurable: true, get: () => maximumHeight,
      set: (value: string) => { maximumHeight = value; toolbar.scrollTop = scrollTop } })
    Object.defineProperties(card, {
      offsetHeight: { configurable: true, get: () => Math.min(420, Number.parseFloat(card.style.maxHeight) || Infinity) },
      clientHeight: { configurable: true, get: () => card.offsetHeight },
      scrollHeight: { configurable: true, get: () => 420 },
    })
    toolbar.getBoundingClientRect = () => rect(Number.parseFloat(toolbar.style.left),
      Number.parseFloat(toolbar.style.top), toolbar.offsetWidth, toolbar.offsetHeight)
    await resize(toolbar)
    assert.equal(toolbar.dataset.visible, 'true')
    assert.equal(toolbar.dataset.heightConstrained, 'true')
    assert.equal(toolbar.style.top, '8px')
    assert.equal(toolbar.style.maxHeight, '146px')
    assert.equal(toolbar.querySelectorAll('button').length, 8, 'height limits retain all actions')
    assert.equal(card.dataset.visible, 'true')
    assert.equal(card.style.top, '166px')
    assert.equal(card.style.maxHeight, '142px')

    toolbar.scrollTop = toolbar.scrollHeight - toolbar.clientHeight
    const lastActionScroll = toolbar.scrollTop
    await resize(toolbar)
    await resize(toolbar)
    assert.equal(toolbar.scrollTop, lastActionScroll, 'the last action stays reachable through repeated layout measurements')

    await draw(false)
    await resize(toolbar)
    assert.equal(toolbar.dataset.heightConstrained, 'false')
    assert.equal(toolbar.style.maxHeight, '304px', 'the full PDF scrollport becomes available after its comment closes')
    naturalHeight = 500
    await resize(toolbar)
    assert.equal(toolbar.dataset.visible, 'true', 'a toolbar taller than the PDF remains reachable without a comment')
    assert.equal(toolbar.dataset.heightConstrained, 'true')
    assert.equal(toolbar.offsetHeight, 304)
  })
})

test('question editors fit a short PDF scrollport while a full-height rail and right sidebar remain outside', async () => {
  await withReader(async ({ reader, viewport, render }) => {
    viewport.getBoundingClientRect = () => rect(110, 240, 240, 160)
    await render(React.createElement(ExplanationQuestionEditor, { viewport, getAnchor: () => rect(118, 250, 70, 18),
      mode: 'new', index: 1, question: 'Why?', disabled: false, t: key => key,
      onChange() {}, onSave() {}, onCancel() {} }))
    const editor = reader.querySelector<HTMLElement>('.dsh-pdf-explanation-question-editor')!
    assert.notEqual(editor.style.visibility, 'hidden')
    assert.equal(editor.style.width, '216px')
    assert.equal(editor.style.maxHeight, '136px', 'the editor scrolls within the remaining PDF height')
    assert.ok(Number.parseFloat(editor.style.left) >= 92)
    assert.ok(Number.parseFloat(editor.style.left) + 216 <= 308)
    assert.ok(Number.parseFloat(editor.style.top) >= 212)
    assert.ok(Number.parseFloat(editor.style.top) + editor.offsetHeight <= 348)
  })
})

test('expanded reading-sidebar limits deduct the measured tool rail and retain 180px of PDF space', async () => {
  await withReader(async ({ mount, render, resize }) => {
    let paneWidth = 480, railWidth = 80
    await render(React.createElement('div', { className: 'dsh-pdf-body', ref: (element: HTMLElement | null): void => {
      if (element) Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => paneWidth })
    } }, React.createElement('nav', { 'data-pdf-tool-rail': '', ref: (element: HTMLElement | null): void => {
      if (element) element.getBoundingClientRect = () => rect(0, 0, railWidth, 300)
    } }), React.createElement(ReadingSidebar, { activeSection: 'ocr', onSectionChange() {}, expanded: true,
      onExpandedChange() {}, panels: {}, pdf: null, currentPage: 1, pageInput: '1', navigating: false,
      onPageInputChange() {}, onPageInputSubmit() {}, onPageInputReset() {}, onNavigatePage() {},
      onStepPage() {}, onNavigateDestination() {}, t: key => key })))
    const sidebar = mount.querySelector<HTMLElement>('.dsh-pdf-sidebar')!
    const body = mount.querySelector<HTMLElement>('.dsh-pdf-body')!
    const rail = body.querySelector<HTMLElement>('[data-pdf-tool-rail]')!
    assert.equal(sidebar.style.getPropertyValue('--pdf-sidebar-width'), '180px')
    paneWidth = 350
    await resize(body)
    assert.equal(sidebar.style.getPropertyValue('--pdf-sidebar-width'), '90px')
    assert.equal(paneWidth - railWidth - 90, 180, 'explicit narrow expansion leaves a usable reading column')
    paneWidth = 600
    railWidth = 140
    await resize(rail)
    assert.equal(sidebar.style.getPropertyValue('--pdf-sidebar-width'), '207px', 'rail resizing updates the same width budget')
    paneWidth = 300
    railWidth = 80
    await resize(body)
    assert.equal(sidebar.style.getPropertyValue('--pdf-sidebar-width'), '56px', 'an extremely narrow host retains the full narrow control rail rather than clipping its buttons')
  })
})
