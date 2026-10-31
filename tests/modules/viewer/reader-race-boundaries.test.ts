import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { defaultSettings, type PdfClientApi, type WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderProps } from '../../../src/client/contracts.ts'

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
  return next(url, context)
} })

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    id: 'race-document', path: '/tmp/reader-race.pdf', sourceVersion: 'source-1', contentVersion: 'contents-1',
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false },
    ...overrides,
  }
}

test('Reader preserves explanation UI across native replacement and pending resource switches', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
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
  const oldBounds = dom.HTMLElement.prototype.getBoundingClientRect
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('dsh-pdf-scroll')) return new dom.DOMRect(0, 0, 800, 700)
    if (this.classList.contains('dsh-pdf-page-wrap') || this.classList.contains('dsh-pdf-page')
      || this.classList.contains('dsh-pdf-tile-surface')) return new dom.DOMRect(100, 100, 400, 600)
    if (this.classList.contains('dsh-pdf-reader')) return new dom.DOMRect(0, 0, 1_100, 700)
    return oldBounds.call(this)
  }
  const oldContext = dom.HTMLCanvasElement.prototype.getContext
  dom.HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect() {}, drawImage() {}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {},
  })) as unknown as typeof oldContext
  const { Reader } = await import('../../../src/client/Reader.tsx')
  const { flushSync } = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const tab = new AbortController()
  let publish: ((value: WorkspaceSnapshot) => void) | undefined
  let nativeTiles = 0
  const api = {
    native: {
      async tile() { nativeTiles++; throw new Error('old native reader must not rasterize') },
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
    subscribe(_id: string, callback: (value: WorkspaceSnapshot) => void) { publish = callback; return () => { publish = undefined } },
  } as unknown as PdfClientApi
  const props = {
    resourceAddress: 'file:///tmp/reader-race.pdf', sessionId: 'session-1',
    scrollportRef() {}, useTabInfo: () => ({ tab: { id: 'tab-1', signal: tab.signal, visible: true } }),
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
    t: (key: string) => key, api,
    hostOcr: { async availability() { return { status: 'disabled' as const } }, async recognize() { throw new Error('not configured') } },
    imageUnderstanding: {
      availability: async () => ({ status: 'available' as const, kind: 'direct-image' as const, backendId: 'session-vision' }),
      prepare: async () => { throw new Error('not called before the question is saved') },
    },
    regionEvidence: { prepare: async () => { throw new Error('not called while native reader is changing') } },
    promptExplanation: async () => {},
    translation: { list: () => [] }, settings: defaultSettings,
  } as unknown as ReaderProps
  try {
    await act(async () => { root.render(React.createElement(Reader, props)); await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const explain = container.querySelector<HTMLButtonElement>('.dsh-pdf-tool-explain')!
    await act(async () => { explain.click(); await Promise.resolve() })
    const area = container.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-status-area')!
    assert.equal(area.disabled, false)
    await act(async () => { area.click() })
    const page = container.querySelector<HTMLElement>('.dsh-pdf-page')!
    page.setPointerCapture = () => {}
    page.hasPointerCapture = () => true
    page.releasePointerCapture = () => {}
    for (const [kind, x, y] of [['pointerdown', 140, 180], ['pointermove', 220, 280], ['pointerup', 220, 280]] as const) {
      await act(async () => {
        const event = new dom.MouseEvent(kind, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
        Object.defineProperty(event, 'pointerId', { value: 6 })
        page.dispatchEvent(event)
      })
    }
    const editor = container.querySelector<HTMLElement>('.dsh-pdf-explanation-question-editor')!
    assert.ok(editor, 'the dragged region opens a question editor')
    const question = editor.querySelector<HTMLTextAreaElement>('textarea')!
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(question, 'What does this plot show?')
      question.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-question-save')?.disabled, false,
      'a non-empty question is ready to save before the reader generation changes')
    assert.ok(publish, 'the Reader subscribed to document changes')
    const tilesBeforeSave = nativeTiles

    // A different Host reader generation takes over while this editor remains
    // visible. React commits the snapshot before openNativeDocument's promise
    // resolves, leaving a real user-action window where capture is not ready.
    act(() => {
      flushSync(() => publish!({ ...snapshot(), reader: { ...snapshot().reader, generation: 2 } }))
      const save = container.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-question-save')!
      assert.equal(save.disabled, false)
      flushSync(() => save.click())
    })
    assert.match(container.querySelector('.dsh-pdf-floating-status[data-status-id="explanation"]')?.textContent ?? '', /reader.notReady/)
    assert.ok(container.querySelector('.dsh-pdf-explanation-question-editor'), 'the question remains editable for retry')
    assert.equal(nativeTiles, tilesBeforeSave, 'the stale native document is not used for image capture')

    // A second path to the same open document can be selected while its Host
    // open call is pending. The area action remains visible, but must not
    // enter region mode until the replacement display owner is established.
    await act(async () => { await Promise.resolve() })
    const cancel = [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-explanation-question-editor button')]
      .find(button => button.textContent === 'reader.cancel')!
    await act(async () => { cancel.click() })
    assert.equal(container.querySelector('.dsh-pdf-explanation-question-editor'), null)
    let finishOpen: ((value: WorkspaceSnapshot) => void) | undefined
    api.open = async (_session, address) => address === 'file:///tmp/reader-race-copy.pdf'
      ? new Promise<WorkspaceSnapshot>(resolve => { finishOpen = resolve }) : snapshot()
    await act(async () => {
      root.render(React.createElement(Reader, { ...props, resourceAddress: 'file:///tmp/reader-race-copy.pdf',
        content: { ...props.content, revision: 2 } }))
      await Promise.resolve()
    })
    assert.ok(finishOpen, 'the replacement resource is still opening')
    const pendingArea = container.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-status-area')!
    assert.equal(pendingArea.disabled, false, 'the explanation draft survives a pending open')
    await act(async () => { pendingArea.click() })
    assert.match(container.querySelector('.dsh-pdf-floating-status[data-status-id="explanation"]')?.textContent ?? '', /reader.notReady/)
    assert.equal(container.querySelector('.dsh-pdf-mode-region'), null, 'the incomplete resource cannot enter region mode')
    await act(async () => { finishOpen!(snapshot({ path: '/tmp/reader-race-copy.pdf' })); await Promise.resolve() })
  } finally {
    await act(async () => { root.unmount() })
    tab.abort()
    dom.HTMLElement.prototype.getBoundingClientRect = oldBounds
    dom.HTMLCanvasElement.prototype.getContext = oldContext
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
