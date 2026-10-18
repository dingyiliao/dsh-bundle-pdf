import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { defaultSettings, type PdfClientApi, type WorkspaceSnapshot } from '../src/shared/contracts.ts'
import type { ReaderProps } from '../src/client/contracts.ts'
import { readerLifetime } from '../src/client/reader-lifetime.ts'

// The shipped Client bundles CSS as text. The Node component test only needs
// the actual Reader implementation; stylesheet contents are irrelevant here.
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
  return next(url, context)
} })

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harnessRequire = createRequire(join(project, '..', 'deepseek-harness', 'package.json'))
const { JSDOM } = harnessRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

function fixtureSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    id: 'document-1', path: '/tmp/reader-boundary.pdf', sourceVersion: 'source-1', contentVersion: 'contents-1',
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: 'sha256-reader-test', generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false },
    ...overrides,
  }
}

async function withReader(run: (fixture: {
  dom: Window & typeof globalThis
  container: HTMLElement
  render: (props: ReaderProps | null) => Promise<void>
  props: ReaderProps
  api: PdfClientApi
  tab: AbortController
  loaded: string[]
  failed: string[]
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  // JSDOM has no raster backend; these tests exercise Reader chrome and
  // controller actions, not painting. A zero-size DOM never requests a tile.
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
  const { Reader } = await import('../src/client/Reader.tsx')
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const tab = new AbortController()
  const loaded: string[] = [], failed: string[] = []
  let snapshot = fixtureSnapshot()
  const api = {
    native: {
      async tile() { throw new Error('a non-visible page must not request tiles') },
      async text() { return { items: [], styles: {}, lang: null } },
      async links() { return [] }, async outline() { return null }, async destination() { return null },
    },
    bookmarks: { async list() { return [] }, async add() { return [] }, async rename() { return [] }, async remove() { return [] } },
    positions: { async get() { return null }, async set() {} },
    async open() { return snapshot },
    async change() { return snapshot }, async undo() { return snapshot }, async redo() { return snapshot },
    async reload() { return snapshot }, async discard() { return snapshot },
    async discardMany() {}, async discardAddresses() {},
    async inspectTarget() { return { version: null } }, async save() { return snapshot },
    subscribe() { return () => {} },
  } as unknown as PdfClientApi
  const props = {
    resourceAddress: 'file:///tmp/reader-boundary.pdf', sessionId: 'session-1',
    scrollportRef() {}, useTabInfo: () => ({ tab: { id: 'tab-1', signal: tab.signal, visible: true } }),
    content: { kind: 'renderer', revision: 1, loaded: (value: string) => loaded.push(value), failed: () => failed.push('failed') },
    t: (key: string) => key, api,
    hostOcr: { async availability() { return { status: 'disabled' as const } }, async recognize() { throw new Error('not configured') } },
    imageUnderstanding: { async availability() { return { status: 'unavailable' as const, reason: 'not configured' } },
      async prepare() { throw new Error('not configured') } },
    translation: { list: () => [] }, settings: defaultSettings,
  } as unknown as ReaderProps
  const render = async (value: ReaderProps | null) => { await act(async () => {
    root.render(value ? React.createElement(Reader, value) : null)
    await Promise.resolve()
  }) }
  try { await run({ dom, container, render, props, api, tab, loaded, failed }) }
  finally {
    await act(async () => { root.unmount() })
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('Reader surfaces failed document open and clears it on a successful resource switch', async () => {
  await withReader(async ({ container, render, props, api, dom, failed, loaded }) => {
    let reject = true
    api.open = async () => { if (reject) throw new Error('The PDF cannot be opened'); return fixtureSnapshot() }
    await render(props)
    assert.deepEqual(failed, ['failed'])
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /The PDF cannot be opened/)
    assert.match(container.querySelector('.dsh-pdf-empty')?.textContent ?? '', /reader.cannotOpen/)
    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="reader.dismiss"]')!
    await act(async () => { dismiss.click() })
    assert.equal(container.querySelector('[role="alert"]'), null)
    reject = false
    await render({ ...props, resourceAddress: 'file:///tmp/reader-retry.pdf', content: { ...props.content, revision: 2 } })
    await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.ok(loaded.includes('source-1'), 'the replacement resource notifies the preview owner')
    assert.equal(container.querySelector('[role="alert"]'), null)
    assert.ok(container.querySelector('.dsh-pdf-windowed-pages'))
    dom.document.dispatchEvent(new dom.Event('focus'))
  })
})

test('Reader dirty-document actions confirm reload, expose Save As, and route keyboard save', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const dirty = fixtureSnapshot({ dirty: true, canUndo: true, canRedo: true })
    const calls: string[] = []
    api.open = async () => dirty
    api.reload = async () => { calls.push('reload'); return dirty }
    api.undo = async () => { calls.push('undo'); return dirty }
    api.redo = async () => { calls.push('redo'); return dirty }
    api.save = async () => { calls.push('save'); return fixtureSnapshot() }
    await render(props)
    await act(async () => { await Promise.resolve() })

    const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
    const menuButton = (name: string) => [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
      .find(button => button.textContent === name)!
    assert.ok(tools && menuButton('reader.reload'))
    await act(async () => { tools.open = true; menuButton('reader.reload').click() })
    assert.match(container.querySelector('.dsh-pdf-dialog')?.textContent ?? '', /reader.reloadConfirm/)
    assert.deepEqual(calls, [], 'reload must be confirmed while the PDF is dirty')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-dialog button')]
      .find(button => button.textContent === 'reader.cancel')!.click() })
    assert.equal(container.querySelector('.dsh-pdf-dialog'), null)
    await act(async () => { tools.open = true; menuButton('reader.reload').click() })
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-dialog button')]
      .find(button => button.textContent === 'reader.reload')!.click(); await Promise.resolve() })
    assert.deepEqual(calls, ['reload'])

    await act(async () => { tools.open = true; menuButton('reader.undo').click(); await Promise.resolve() })
    await act(async () => { tools.open = true; menuButton('reader.redo').click(); await Promise.resolve() })
    assert.deepEqual(calls, ['reload', 'undo', 'redo'])
    await act(async () => { tools.open = true; menuButton('reader.saveAs').click() })
    const saveAs = container.querySelector<HTMLFormElement>('.dsh-pdf-dialog')!
    assert.equal(saveAs.querySelector('input')?.getAttribute('value'), '/tmp/reader-boundary-annotated.pdf')
    await act(async () => { [...saveAs.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'reader.cancel')!.click() })
    assert.equal(container.querySelector('.dsh-pdf-dialog'), null)

    const reader = container.querySelector<HTMLElement>('.dsh-pdf-reader')!
    await act(async () => { reader.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
      await Promise.resolve() })
    assert.deepEqual(calls, ['reload', 'undo', 'redo', 'save'])
    assert.match(container.textContent ?? '', /reader.saved/)
  })
})

test('Reader keeps encrypted documents readable while disabling edits and reports capability failures', async () => {
  await withReader(async ({ container, render, props, api }) => {
    const encrypted = fixtureSnapshot({ document: { ...fixtureSnapshot().document,
      encrypted: true, readOnly: true, readOnlyReason: 'encrypted-document' } })
    const calls: string[] = []
    api.open = async () => encrypted
    api.reload = async () => { calls.push('reload'); return encrypted }
    const input = { ...props,
      hostOcr: { ...props.hostOcr, async availability() { throw new Error('OCR backend is offline') } },
      imageUnderstanding: { ...props.imageUnderstanding,
        async availability() { throw new Error('Vision backend is offline') } },
      promptExplanation: async () => {},
    } as ReaderProps
    await render(input)
    await act(async () => { await Promise.resolve() })
    assert.match(container.textContent ?? '', /reader.encryptedReadOnly/)
    assert.match(container.textContent ?? '', /OCR backend is offline/)
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save')?.disabled, true)
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save-as')?.disabled, true)

    const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
    const menuButton = (name: string) => [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
      .find(button => button.textContent === name)!
    await act(async () => { tools.open = true; menuButton('reader.reload').click(); await Promise.resolve() })
    assert.deepEqual(calls, ['reload'], 'clean read-only PDFs reload without a discard confirmation')
    await act(async () => { tools.open = true; menuButton('reader.explain.start').click(); await Promise.resolve() })
    assert.match(container.querySelector('.dsh-pdf-explanation-status-area')?.parentElement?.getAttribute('title') ?? '',
      /Vision backend is offline/)
    await act(async () => { tools.open = true; menuButton('reader.explain.exit').click() })
    assert.equal(container.querySelector('.dsh-pdf-explanation-status'), null)
  })
})

test('Reader rejects stale OCR output and explains a capability loss after the menu was enabled', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    api.open = async () => fixtureSnapshot()
    let available = true
    let recognizeCalls = 0
    const input = { ...props, hostOcr: {
      async availability() { return available ? { status: 'available' as const }
        : { status: 'unavailable' as const, reason: 'Visual model disconnected' } },
      async recognize() {
        recognizeCalls++
        return { documentId: 'document-1', page: 1, revision: 0, contentVersion: 'contents-1', text: 'old OCR',
          status: 'complete' as const, source: { backendId: 'fixture', backendVersion: '1' },
          geometry: { status: 'none' as const }, warnings: [] }
      },
    } } as ReaderProps
    await render(input)
    await act(async () => { await Promise.resolve() })
    const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
    const ocr = [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
      .find(button => button.textContent === 'reader.ocrPage')!
    assert.equal(ocr.disabled, false)
    available = false
    await act(async () => { tools.open = true; ocr.click(); await Promise.resolve() })
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Visual model disconnected/)
    assert.equal(recognizeCalls, 0, 'the Host preflight must prevent stale or unauthorized OCR work')

    available = true
    await act(async () => { dom.dispatchEvent(new dom.Event('focus')); await Promise.resolve() })
    assert.equal(ocr.disabled, false)
    await act(async () => { tools.open = true; ocr.click(); await Promise.resolve() })
    assert.equal(recognizeCalls, 1)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reader.ocrStale/)
  })
})

test('Reader handles native Save As failure and exits screenshot mode with Escape', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const dirty = fixtureSnapshot({ dirty: true, canUndo: true })
    api.open = async () => dirty
    let discarded = false
    api.discard = async () => { discarded = true; return fixtureSnapshot() }
    await render({ ...props, pickSavePath: async () => { throw new Error('The system save dialog failed') } })
    await act(async () => { await Promise.resolve() })
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save-as')!.click(); await Promise.resolve() })
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /The system save dialog failed/)

    const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
    const discard = [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
      .find(button => button.textContent === 'reader.discard')!
    await act(async () => { tools.open = true; discard.click(); await Promise.resolve() })
    assert.equal(discarded, true)
    assert.equal(container.querySelector('[role="alert"]'), null, 'discard clears the failed save error')
    const screenshot = [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
      .find(button => button.textContent === 'reader.regionScreenshot')!
    await act(async () => { tools.open = true; screenshot.click() })
    assert.match(container.textContent ?? '', /reader.screenshotHint/)
    await act(async () => { tools.open = true; container.querySelector('.dsh-pdf-reader')!
      .dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(tools.open, false)
    assert.doesNotMatch(container.textContent ?? '', /reader.screenshotHint/)
  })
})

test('Reader reasserts and clears the active page lease across a transient Host failure and tab hide', async () => {
  await withReader(async ({ render, props, api, tab }) => {
    api.open = async () => fixtureSnapshot()
    const updates: Array<{ action: string; page?: number }> = []
    const warnings: unknown[][] = []
    let rejectReports = false
    let heartbeat: (() => void) | undefined
    const realSetInterval = globalThis.setInterval
    const realWarn = console.warn
    globalThis.setInterval = ((callback: () => void, delay?: number) => {
      if (delay === 30_000) heartbeat = callback
      return realSetInterval(callback, delay)
    }) as typeof setInterval
    console.warn = (...values: unknown[]) => { warnings.push(values) }
    try {
      const visible = { ...props, allowReadingContext: true,
        reportReadingContext: async (update: { action: string; page?: number }) => {
          updates.push(update)
          if (rejectReports) throw new Error('Reader context transport disconnected')
        },
      } as ReaderProps
      await render(visible)
      await act(async () => { await Promise.resolve() })
      assert.deepEqual(updates.map(update => update.action), ['set'])
      assert.equal(updates[0]?.page, 1)
      assert.ok(heartbeat, 'the visible Reader installs its lease refresh interval')
      await act(async () => { heartbeat!(); await Promise.resolve() })
      assert.deepEqual(updates.map(update => update.action), ['set', 'set'])
      rejectReports = true
      await act(async () => { heartbeat!(); await Promise.resolve() })
      assert.match(String(warnings.at(-1)?.[0]), /Could not synchronize the active reading page/)
      rejectReports = false
      await render({ ...visible, useTabInfo: () => ({ tab: { id: 'tab-1', signal: tab.signal, visible: false } }) } as ReaderProps)
      assert.equal(updates.at(-1)?.action, 'clear', 'hiding the tab releases the published lease')
    } finally {
      globalThis.setInterval = realSetInterval
      console.warn = realWarn
    }
  })
})

test('Reader reports failed position lookup, saves through its compact menu, and adopts a new source version', async () => {
  await withReader(async ({ container, render, props, api, loaded }) => {
    const dirty = fixtureSnapshot({ dirty: true, canUndo: true })
    const clean = fixtureSnapshot()
    let publish: ((value: WorkspaceSnapshot) => void) | undefined
    const saves: string[] = []
    const warnings: unknown[][] = []
    const realWarn = console.warn
    api.open = async () => dirty
    api.positions.get = async () => { throw new Error('Position storage disconnected') }
    api.subscribe = (_id, callback) => { publish = callback; return () => { publish = undefined } }
    api.save = async () => { saves.push('save'); return clean }
    console.warn = (...values: unknown[]) => { warnings.push(values) }
    try {
      await render(props)
      await act(async () => { await Promise.resolve() })
      assert.match(String(warnings.at(-1)?.[0]), /Could not read the remembered reading position/)
      const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
      const save = [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
        .find(button => button.textContent === 'reader.save')!
      assert.equal(save.disabled, false)
      await act(async () => { tools.open = true; save.click(); await Promise.resolve() })
      assert.deepEqual(saves, ['save'])
      assert.ok(publish)
      await act(async () => { publish!({ ...clean, sourceVersion: 'source-2' }) })
      assert.equal(loaded.at(-1), 'source-2', 'content owner sees external saved source version updates')
    } finally { console.warn = realWarn }
  })
})

test('Reader reports failed reading-position writes while open and on unmount', async () => {
  const warnings: unknown[][] = []
  const writes: Array<AbortSignal | undefined> = []
  const realWarn = console.warn
  console.warn = (...values: unknown[]) => { warnings.push(values) }
  try {
    await withReader(async ({ container, render, props, api, dom }) => {
      api.positions.set = async (_session, _document, _position, signal) => {
        writes.push(signal)
        throw new Error('Position storage is unavailable')
      }
      await render(props)
      await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
      const scroll = container.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      assert.ok(scroll, 'the opened PDF has a scrollport')
      await act(async () => {
        scroll.dispatchEvent(new dom.Event('scroll', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 1_020))
      })
      assert.ok(writes.some(signal => signal === props.useTabInfo().tab.signal), 'the visible reader writes with its tab signal')
    })
    assert.ok(writes.some(signal => signal === undefined), 'unmount persists without the already-closing tab signal')
    assert.ok(warnings.some(values => String(values[0]).includes('Could not remember the reading position')))
  } finally { console.warn = realWarn }
})

test('Reader restores a previously open tab from its retained reading position', async () => {
  await withReader(async ({ container, render, props, api }) => {
    const records: unknown[] = []
    let lookups = 0
    api.positions.set = async (_session, _document, position) => { records.push(position) }
    api.positions.get = async () => { lookups++; return null }
    await render(props)
    await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.ok(container.querySelector('.dsh-pdf-windowed-pages'))
    assert.ok(records.length > 0, 'the initial reader decides a position before it can be retained')
    assert.equal(lookups, 1)
    await render(null)
    await render(props)
    await act(async () => { await Promise.resolve() })
    assert.equal(lookups, 1, 'reopening the same tab resumes its retained position without a second Host lookup')
  })
})

test('Reader rolls an edited annotation color back when the Host rejects the change', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const annotation = { id: 'existing-highlight', page: 1, subtype: 'Highlight',
      rect: [40, 400, 100, 420] as [number, number, number, number],
      color: [1, 1, 0] as [number, number, number], contents: 'Original comment',
      flags: 0, supported: true, editable: true }
    api.open = async () => fixtureSnapshot({ document: { ...fixtureSnapshot().document, annotations: [annotation] } })
    const operations: unknown[] = []
    api.change = async (_session, _document, _revision, next) => {
      operations.push(next)
      throw new Error('The annotation store rejected the color')
    }
    await render(props)
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector<HTMLButtonElement>('.dsh-pdf-comment-item')!
    assert.ok(row, 'an existing highlight is selectable from the annotation list')
    await act(async () => { row.click(); await Promise.resolve() })
    const color = container.querySelector<HTMLInputElement>('.dsh-pdf-comment-editor-color input[type="color"]')!
    assert.ok(color, 'selecting a highlight opens its comment editor')
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(color, '#ff0000')
      color.dispatchEvent(new dom.Event('input', { bubbles: true }))
      color.dispatchEvent(new dom.Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 250))
    })
    assert.equal(operations.length, 1)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /The annotation store rejected the color/)
    assert.equal(color.value, '#ffff00', 'failed color writes restore the persisted annotation color')
  })
})

test('Reader drops a queued color edit when an external PDF update removes that annotation', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const annotation = { id: 'externally-removed-highlight', page: 1, subtype: 'Highlight',
      rect: [40, 400, 100, 420] as [number, number, number, number],
      color: [1, 1, 0] as [number, number, number], flags: 0, supported: true, editable: true }
    api.open = async () => fixtureSnapshot({ document: { ...fixtureSnapshot().document, annotations: [annotation] } })
    let publish: ((snapshot: WorkspaceSnapshot) => void) | undefined
    let writes = 0
    api.subscribe = (_id, callback) => { publish = callback; return () => { publish = undefined } }
    api.change = async () => { writes++; throw new Error('a removed annotation must not be changed') }
    await render(props)
    await act(async () => { await Promise.resolve() })
    assert.ok(publish)
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-pdf-comment-item')!.click() })
    const color = container.querySelector<HTMLInputElement>('.dsh-pdf-comment-editor-color input[type="color"]')!
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(color, '#ff0000')
      color.dispatchEvent(new dom.Event('input', { bubbles: true }))
      color.dispatchEvent(new dom.Event('change', { bubbles: true }))
      publish!({ ...fixtureSnapshot(), revision: 2 })
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    assert.equal(writes, 0, 'queued edits never target an annotation removed by another client')
    assert.equal(container.querySelector('.dsh-pdf-comment-editor-color'), null)
  })
})

test('Reader reports a Host raster failure after a user drags a screenshot region', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    // JSDOM does not lay out pages. Give its actual Reader/Page components the
    // viewport geometry of a visible PDF, then dispatch the real drag events.
    const oldBounds = dom.HTMLElement.prototype.getBoundingClientRect
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('dsh-pdf-scroll')) return new dom.DOMRect(0, 0, 800, 700)
      if (this.classList.contains('dsh-pdf-page-wrap') || this.classList.contains('dsh-pdf-page')
        || this.classList.contains('dsh-pdf-tile-surface')) return new dom.DOMRect(100, 100, 400, 600)
      if (this.classList.contains('dsh-pdf-reader')) return new dom.DOMRect(0, 0, 1_100, 700)
      return oldBounds.call(this)
    }
    const oldContext = dom.HTMLCanvasElement.prototype.getContext
    dom.HTMLCanvasElement.prototype.getContext = (() => ({ fillRect() {}, drawImage() {} })) as unknown as typeof oldContext
    let tileReads = 0
    api.native.tile = async () => { tileReads++; throw new Error('Native tile read failed') }
    try {
      await render(props)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
      const screenshot = [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
        .find(button => button.textContent === 'reader.regionScreenshot')!
      await act(async () => { tools.open = true; screenshot.click() })
      const page = container.querySelector<HTMLElement>('.dsh-pdf-page')!
      assert.ok(page, 'the Reader rendered a visible PDF page')
      page.setPointerCapture = () => {}
      page.hasPointerCapture = () => true
      page.releasePointerCapture = () => {}
      const pointer = async (kind: string, x: number, y: number) => {
        await act(async () => {
          const event = new dom.MouseEvent(kind, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
          Object.defineProperty(event, 'pointerId', { value: 5 })
          page.dispatchEvent(event)
        })
      }
      await pointer('pointerdown', 140, 180)
      await pointer('pointermove', 220, 280)
      await pointer('pointerup', 220, 280)
      await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
      assert.ok(tileReads > 0)
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Native tile read failed/)
      assert.doesNotMatch(container.textContent ?? '', /reader.screenshotHint/, 'a failed screenshot exits region mode')

      // A second attempt hangs in a real Host tile read until the user uses
      // the visible progress chip's Cancel action.
      const pending: AbortSignal[] = []
      api.native.tile = async (_session, _document, _reader, _request, signal) => {
        assert.ok(signal, 'native tile reads carry an abort signal')
        return new Promise((_, reject) => {
        pending.push(signal)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      await act(async () => { tools.open = true; screenshot.click() })
      await pointer('pointerdown', 140, 180)
      await pointer('pointermove', 220, 280)
      await pointer('pointerup', 220, 280)
      const status = container.querySelector<HTMLElement>('[data-status-id="screenshot"]')!
      assert.match(status?.textContent ?? '', /reader.screenshotPreparing/)
      await act(async () => { status.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve() })
      assert.ok(pending.some(signal => signal.aborted), 'cancel reaches the in-flight native tile request')
      assert.equal(container.querySelector('[data-status-id="screenshot"]'), null)
      assert.doesNotMatch(container.textContent ?? '', /reader.screenshotHint/)
    } finally {
      dom.HTMLElement.prototype.getBoundingClientRect = oldBounds
      dom.HTMLCanvasElement.prototype.getContext = oldContext
    }
  })
})

test('Reader confines keyboard shortcuts to the focused translation sidebar', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    let saves = 0
    api.save = async () => { saves++; return fixtureSnapshot() }
    await render(props)
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="reader.sidebar.translation"]')!
    assert.ok(tab)
    await act(async () => { tab.click() })
    const panel = container.querySelector<HTMLElement>('.dsh-pdf-translation-panel .dsh-pdf-panel-scroll')!
    assert.ok(panel && !panel.closest('[hidden]'), 'the translation panel is the currently visible sidebar section')
    panel.focus()
    assert.equal(dom.document.activeElement, panel)
    await act(async () => {
      panel.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(saves, 0, 'typing inside the translation pane cannot save the PDF')
    const escape = new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { panel.dispatchEvent(escape) })
    assert.equal(escape.defaultPrevented, true)
  })
})

test('Reader preserves a region question when its native image capture fails', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const oldBounds = dom.HTMLElement.prototype.getBoundingClientRect
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('dsh-pdf-scroll')) return new dom.DOMRect(0, 0, 800, 700)
      if (this.classList.contains('dsh-pdf-page-wrap') || this.classList.contains('dsh-pdf-page')
        || this.classList.contains('dsh-pdf-tile-surface')) return new dom.DOMRect(100, 100, 400, 600)
      if (this.classList.contains('dsh-pdf-reader')) return new dom.DOMRect(0, 0, 1_100, 700)
      return oldBounds.call(this)
    }
    const oldContext = dom.HTMLCanvasElement.prototype.getContext
    const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    dom.HTMLCanvasElement.prototype.getContext = (() => ({
      fillRect() {}, drawImage() {}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {},
    })) as unknown as typeof oldContext
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true,
      value: async () => ({ width: 400, height: 600, close() {} }) })
    let failRaster = false
    api.native.tile = async (_session, _document, _reader, request) => {
      if (failRaster) throw new Error('Host explanation raster failed')
      return { bytes: new Uint8Array([137, 80, 78, 71]), width: request.width,
        height: request.height, mime: 'image/png' }
    }
    const input = { ...props,
      promptExplanation: async () => {},
      imageUnderstanding: {
        availability: async () => ({ status: 'available' as const, kind: 'direct-image' as const, backendId: 'session-vision' }),
        prepare: async () => { throw new Error('not called before a question is saved') },
      },
    } as ReaderProps
    try {
      await render(input)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
      const explain = [...tools.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tools-menu button')]
        .find(button => button.textContent === 'reader.explain.start')!
      await act(async () => { tools.open = true; explain.click(); await Promise.resolve() })
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
      assert.ok(editor, 'a dragged PDF region opens a question editor')
      const question = editor.querySelector<HTMLTextAreaElement>('textarea')!
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(question, 'Explain the chart')
        question.dispatchEvent(new dom.Event('input', { bubbles: true }))
      })
      const save = editor.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-question-save')!
      assert.equal(save.disabled, false)
      failRaster = true
      await act(async () => { save.click(); await Promise.resolve() })
      assert.match(container.querySelector('.dsh-pdf-explanation-status-error')?.textContent ?? '', /Host explanation raster failed/)
      assert.ok(container.querySelector('.dsh-pdf-explanation-question-editor'), 'raster failure preserves the question for retry')
    } finally {
      dom.HTMLElement.prototype.getBoundingClientRect = oldBounds
      dom.HTMLCanvasElement.prototype.getContext = oldContext
      if (oldBitmap) Object.defineProperty(globalThis, 'createImageBitmap', oldBitmap)
      else Reflect.deleteProperty(globalThis, 'createImageBitmap')
    }
  })
})

test('Reader pinches over a mounted page before its native PageView registers', async () => {
  await withReader(async ({ container, render, props, dom }) => {
    const oldBounds = dom.HTMLElement.prototype.getBoundingClientRect
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('dsh-pdf-page')) return new dom.DOMRect(100, 100, 400, 600)
      if (this.classList.contains('dsh-pdf-scroll')) return new dom.DOMRect(0, 0, 800, 700)
      return oldBounds.call(this)
    }
    try {
      await render(props)
      const page = container.querySelector<HTMLElement>('.dsh-pdf-page')!
      assert.ok(page, 'the virtualized page DOM exists before its native PageView is ready')
      const gesture = new dom.WheelEvent('wheel', { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: -20, clientX: 180, clientY: 220 })
      await act(async () => { page.dispatchEvent(gesture) })
      assert.equal(gesture.defaultPrevented, true, 'the reader, not the app shell, owns the pinch gesture')
    } finally { dom.HTMLElement.prototype.getBoundingClientRect = oldBounds }
  })
})

test('Reader coalesces two quick page-step requests while the first jump is pending', async () => {
  await withReader(async ({ container, render, props, api, tab }) => {
    const first = fixtureSnapshot().document.pages[0]!
    api.open = async () => fixtureSnapshot({ document: {
      ...fixtureSnapshot().document, pageCount: 2,
      pages: [first, { ...first, page: 2 }],
    } })
    await render(props)
    await act(async () => { await Promise.resolve() })
    const next = container.querySelector<HTMLButtonElement>('[aria-label="reader.next"]')!
    assert.equal(next.disabled, false)
    await act(async () => {
      next.click()
      next.click()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value, '2',
      'the coalesced navigation settles on the requested page')
    tab.abort()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  })
})

test('Reader lets an explicit page step supersede a retained-tab resume', async () => {
  await withReader(async ({ container, render, props, api, tab }) => {
    const first = fixtureSnapshot().document.pages[0]!
    api.open = async () => fixtureSnapshot({ document: {
      ...fixtureSnapshot().document, pageCount: 2, pages: [first, { ...first, page: 2 }],
    } })
    await render(props)
    await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
    await render(null)

    const originalFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')!
    const held: FrameRequestCallback[] = []
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true,
      value: (callback: FrameRequestCallback) => { held.push(callback); return held.length + 1_000_000 } })
    try {
      await render(props)
      assert.ok(held.length > 0, 'retained-tab resume is waiting for a layout frame')
      const next = container.querySelector<HTMLButtonElement>('[aria-label="reader.next"]')!
      assert.equal(next.disabled, false)
      await act(async () => { next.click() })
    } finally {
      Object.defineProperty(globalThis, 'requestAnimationFrame', originalFrame)
      await act(async () => { for (const callback of held) callback(Date.now()) })
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value, '2')
    tab.abort()
  })
})

test('Reader can return through history after both viewport capture and Host resume fail', async () => {
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...values: unknown[]) => { warnings.push(values) }
  try { await withReader(async ({ container, render, props, api, tab, dom, loaded }) => {
    const first = fixtureSnapshot().document.pages[0]!
    const initial = fixtureSnapshot({ document: {
      ...fixtureSnapshot().document, pageCount: 2, pages: [first, { ...first, page: 2 }],
    } })
    api.open = async () => initial
    let lookups = 0
    let rejectHostLookup: ((reason: Error) => void) | undefined
    api.positions.get = async () => {
      if (++lookups === 1) return null
      return new Promise((_resolve, reject) => { rejectHostLookup = reject })
    }
    Object.defineProperty(dom.HTMLElement.prototype, 'clientHeight', { configurable: true,
      get(this: HTMLElement) { return this.classList.contains('dsh-pdf-scroll') ? 800
        : this.classList.contains('dsh-pdf-thumbnail-scroll') ? 480 : 0 } })
    const originalBounds = dom.HTMLElement.prototype.getBoundingClientRect
    let failViewportMeasurement = false
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      if (failViewportMeasurement && this.classList.contains('dsh-pdf-scroll')) throw new Error('The viewport is no longer measurable')
      return this.classList.contains('dsh-pdf-scroll') ? new dom.DOMRect(0, 0, 800, 800) : originalBounds.call(this)
    }

    await render(props)
    await act(async () => { await Promise.resolve() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="reader.sidebar.pages"]')!.click() })
    const pageTwo = container.querySelector<HTMLButtonElement>('.dsh-pdf-thumbnail-tile[aria-label="reader.page 2 / 2"]')!
    assert.ok(pageTwo, 'the pages sidebar provides a history-recording jump')
    await act(async () => { pageTwo.click(); await new Promise(resolve => setTimeout(resolve, 90)) })
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value, '2',
      container.querySelector('[role="alert"]')?.textContent ?? 'Page 2 navigation did not settle')
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-back-split [aria-label="reader.back"]')?.disabled, false)
    const lifetime = readerLifetime(props.sessionId, 'tab-1', tab.signal, props.settings.historyCapacity)
    assert.equal(lifetime.history.snapshot().positions.length, 1)
    // A tab can hide after a successful jump but before its viewport is
    // measurable for a retained position. Its real history survives that
    // failed capture; reopening then asks the Host for a fallback position.
    failViewportMeasurement = true
    await render(null)
    failViewportMeasurement = false
    assert.equal(lifetime.position, undefined, 'failed viewport measurement leaves no local resume position')
    await render(props)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    assert.equal(loaded.length, 2, 'the reopened document is fully published')
    assert.equal(lookups, 2, 'the Host fallback was used after the local viewport capture failed')
    await act(async () => {
      rejectHostLookup!(new Error('Remembered position is temporarily unavailable'))
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    assert.ok(warnings.some(values => String(values[0]).includes('Could not read the remembered reading position')))
    assert.equal(lifetime.history.snapshot().positions.length, 1, 'the original navigation remains in tab history')
    const back = container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-back-split [aria-label="reader.back"]')!
    assert.equal(back.disabled, false, 'a failed resume does not discard same-document history')
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.disabled, false,
      'the reader is no longer navigating when Back is clicked')
    await act(async () => { back.click() })
    for (let attempt = 0; attempt < 20 && lifetime.history.snapshot().positions.length > 0; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    }
    assert.equal(lifetime.history.snapshot().positions.length, 0,
      `Back consumed the retained stop; page: ${container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value}; positions: ${JSON.stringify(lifetime.history.snapshot().positions.map(position => position.page))}; alert: ${container.querySelector('[role="alert"]')?.textContent}`)
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value, '1')
    tab.abort()
  }) } finally { console.warn = originalWarn }
})
