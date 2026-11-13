import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { defaultSettings, type PdfClientApi, type WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderProps } from '../../../src/client/contracts.ts'
import type { NativeTextContent, NativeTile, NativeTileRequest } from '../../../src/shared/native.ts'
import { readerLifetime } from '../../../src/client/viewer/controllers/reader-lifetime.ts'
import { TranslationRegistry, type TranslationRequest } from '../../../src/translation/index.ts'
import type { VisiblePdfReader } from '../../../src/client/toolview/pdf-evidence-navigation.ts'

// The shipped Client bundles CSS as text. The Node component test only needs
// the actual Reader implementation; stylesheet contents are irrelevant here.
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
  return next(url, context)
} })

function fixtureSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    id: 'document-1', path: '/tmp/reader-boundary.pdf', sourceVersion: 'source-1', contentVersion: 'contents-1',
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false },
    ...overrides,
  }
}

async function waitForReader(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    // Each turn commits React's pending layout/PageView effects. Holding one
    // act() open while sleeping prevents the very render navigation awaits.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

function readerCommand(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-tool-rail button,.dsh-pdf-tools-menu button')]
    .find(button => button.getAttribute('aria-label') === label || button.textContent === label)
  assert.ok(button, `Reader command ${label} is available in the tool rail or its file menu`)
  return button
}

async function openReaderFileMenu(container: HTMLElement): Promise<HTMLDetailsElement> {
  const tools = container.querySelector<HTMLDetailsElement>('.dsh-pdf-tools')!
  await act(async () => {
    if (!tools.open) tools.querySelector<HTMLElement>('summary')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.equal(tools.open, true)
  const menu = [...container.querySelectorAll<HTMLElement>('.dsh-pdf-tools-menu')]
    .find(menu => menu.getAttribute('aria-label') === tools.getAttribute('aria-label'))
  assert.equal(menu?.closest<HTMLElement>('.dsh-pdf-disclosure-popover')?.hidden, false)
  return tools
}

async function clickReaderCommand(container: HTMLElement, label: string): Promise<void> {
  const button = readerCommand(container, label)
  if (button.closest('.dsh-pdf-tools-menu')) await openReaderFileMenu(container)
  await act(async () => { button.click(); await Promise.resolve() })
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
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })
  // JSDOM has no raster backend; these tests exercise Reader chrome and
  // controller actions, not painting. Page bounds stay zero unless a raster
  // test explicitly supplies them, while the scrollport has measurable size.
  Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null })
  const originalBounds = dom.HTMLElement.prototype.getBoundingClientRect
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('dsh-pdf-scroll') ? new dom.DOMRect(0, 0, 600, 700) : originalBounds.call(this)
  }
  for (const [property, dimension, fallback] of [['clientWidth', 'width', 600], ['clientHeight', 'height', 700]] as const) {
    Object.defineProperty(dom.HTMLElement.prototype, property, { configurable: true,
      get(this: HTMLElement) {
        const measured = this.getBoundingClientRect()[dimension]
        return Math.round(measured || (this.classList.contains('dsh-pdf-scroll') ? fallback : 0))
      } })
  }

  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    PointerEvent: dom.PointerEvent ?? dom.MouseEvent, MutationObserver: dom.MutationObserver,
    DOMRect: dom.DOMRect, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class {
      private targets = new Set<Element>()
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target)
        // Deliver the browser's initial observation from the same dimensions
        // exposed through clientWidth/Height. Reader's fit layout must not see
        // an old default size paired with a differently measured live pane.
        queueMicrotask(() => {
          if (!this.targets.has(target)) return
          const element = target as HTMLElement
          const contentRect = new dom.DOMRect(0, 0, element.clientWidth, element.clientHeight)
          this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver)
        })
      }
      unobserve(target: Element) { this.targets.delete(target) }
      disconnect() { this.targets.clear() }
    },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  installDom(values)
  const { Reader } = await import('../../../src/client/Reader.tsx')
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
    async refresh() { return snapshot },
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
    restoreDom()

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

    await clickReaderCommand(container, 'reader.reload')
    assert.match(container.querySelector('.dsh-pdf-dialog')?.textContent ?? '', /reader.reloadConfirm/)
    assert.deepEqual(calls, [], 'reload must be confirmed while the PDF is dirty')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-dialog button')]
      .find(button => button.textContent === 'reader.cancel')!.click() })
    assert.equal(container.querySelector('.dsh-pdf-dialog'), null)
    await clickReaderCommand(container, 'reader.reload')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-dialog button')]
      .find(button => button.textContent === 'reader.reload')!.click(); await Promise.resolve() })
    assert.deepEqual(calls, ['reload'])

    await clickReaderCommand(container, 'reader.undo')
    await clickReaderCommand(container, 'reader.redo')
    assert.deepEqual(calls, ['reload', 'undo', 'redo'])
    await clickReaderCommand(container, 'reader.saveAs')
    const saveAs = container.querySelector<HTMLDialogElement>('.dsh-pdf-save-as')!
    assert.equal(saveAs.getAttribute('role'), 'dialog')
    assert.equal(saveAs.querySelector<HTMLInputElement>('input')?.value, 'reader-boundary-annotated.pdf')
    assert.equal(saveAs.querySelector('.dsh-pdf-save-as-directory')?.textContent?.replace(/\/+$/, ''), '/tmp')
    assert.equal(dom.document.activeElement, saveAs.querySelector('input'), 'filename editing is ready without another click')
    assert.equal(saveAs.querySelector('input[type=checkbox]'), null, 'replacement is a dedicated confirmation step')
    await act(async () => { [...saveAs.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'reader.cancel')!.click() })
    assert.equal(container.querySelector('.dsh-pdf-save-as'), null)

    const reader = container.querySelector<HTMLElement>('.dsh-pdf-reader')!
    await act(async () => { reader.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
      await Promise.resolve() })
    assert.deepEqual(calls, ['reload', 'undo', 'redo', 'save'])
    assert.match(container.textContent ?? '', /reader.saved/)
  })
})

test('Reader keeps encrypted documents readable while disabling outbound and editing actions', async () => {
  await withReader(async ({ container, render, props, api }) => {
    const encrypted = fixtureSnapshot({ document: { ...fixtureSnapshot().document,
      encrypted: true, readOnly: true, readOnlyReason: 'encrypted-document' } })
    const calls: string[] = []
    api.open = async () => { calls.push('open'); return encrypted }
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
    assert.equal(readerCommand(container, 'reader.ocrPage').disabled, true)
    assert.equal(readerCommand(container, 'reader.regionScreenshot').disabled, true)
    assert.equal(readerCommand(container, 'reader.explain.start').disabled, true)
    assert.equal(container.querySelector('[aria-label="reader.sidebar.translation"]'), null)
    assert.equal(container.querySelector('[aria-label="reader.sidebar.ocr"]'), null)
    assert.equal(container.querySelector('[aria-label="reader.sidebar.search"]'), null)
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save')?.disabled, true)
    assert.equal(readerCommand(container, 'reader.saveAs').disabled, true)

    await clickReaderCommand(container, 'reader.reload')
    assert.deepEqual(calls, ['open', 'open'], 'protected PDFs reload through the open and password workflow')
    assert.equal(container.querySelector('.dsh-pdf-explanation-status'), null)
  })
})

test('Reader unlocks from its file view, clears wrong passwords and cancels without retaining input', async () => {
  await withReader(async ({ container, render, props, api, dom, loaded, failed }) => {
    const protectedSnapshot = fixtureSnapshot({ document: { ...fixtureSnapshot().document,
      encrypted: true, readOnly: true, readOnlyReason: 'encrypted-document' } })
    const passwords: string[] = []
    api.open = async () => { throw Object.assign(new Error('password needed'), { code: 'pdf/password-required' }) }
    api.unlock = async (_session, _address, password) => {
      passwords.push(password)
      if (password === 'wrong') throw Object.assign(new Error('wrong password'), { code: 'pdf/password-incorrect' })
      return protectedSnapshot
    }
    await render(props)
    assert.ok(container.querySelector('.dsh-pdf-password-prompt'))
    assert.deepEqual(failed, [])
    const enter = async (value: string) => {
      const input = container.querySelector<HTMLInputElement>('.dsh-pdf-password-prompt input')!
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new dom.Event('input', { bubbles: true }))
      })
      await act(async () => {
        input.closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
        await Promise.resolve()
      })
    }
    await enter('wrong')
    assert.match(container.textContent ?? '', /reader.passwordIncorrect/)
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-password-prompt input')?.value, '')
    await enter('correct')
    await waitForReader(() => !!container.querySelector('.dsh-pdf-windowed-pages'), 'unlocked PDF should render')
    assert.deepEqual(passwords, ['wrong', 'correct'])
    assert.ok(loaded.includes('source-1'))
    assert.equal(container.querySelector('.dsh-pdf-password-prompt'), null)
    assert.match(container.textContent ?? '', /reader.encryptedReadOnly/)

    await render({ ...props, resourceAddress: 'file:///tmp/another-protected.pdf',
      content: { ...props.content, revision: 2 } })
    assert.ok(container.querySelector('.dsh-pdf-password-prompt'))
    const input = container.querySelector<HTMLInputElement>('.dsh-pdf-password-prompt input')!
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'unsent'); input.dispatchEvent(new dom.Event('input', { bubbles: true })) })
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-pdf-password-actions button[type="button"]')!.click() })
    assert.equal(container.querySelector('.dsh-pdf-password-prompt input'), null)
    assert.deepEqual(failed, ['failed'])
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-pdf-password-prompt button')!.click() })
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-password-prompt input')?.value, '')
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
    const ocr = readerCommand(container, 'reader.ocrPage')
    assert.equal(ocr.disabled, false)
    available = false
    await clickReaderCommand(container, 'reader.ocrPage')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Visual model disconnected/)
    assert.equal(recognizeCalls, 0, 'the Host preflight must prevent stale or unauthorized OCR work')

    available = true
    await act(async () => { dom.dispatchEvent(new dom.Event('focus')); await Promise.resolve() })
    assert.equal(ocr.disabled, false)
    await clickReaderCommand(container, 'reader.ocrPage')
    assert.equal(recognizeCalls, 1)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reader.ocrStale/)
  })
})

test('Reader routes whole and partial OCR transcripts to its shared translation panel without native text geometry', async () => {
  const registry = new TranslationRegistry({ timeoutMs: 1_000, maxInputCharacters: 1_000, maxOutputCharacters: 1_000 })
  const requests: TranslationRequest[] = []
  const recognized = 'First recognized line.\n这是 OCR 文字 😀。\nFinal recognized line.'
  registry.register({ descriptor: { id: 'fixture-translation', name: 'Fixture', version: '1', execution: 'local' },
    async translate(request) { requests.push(request); return { text: 'Translated OCR text', status: 'complete', warnings: [] } } })
  registry.select({ id: 'fixture', engineId: 'fixture-translation', configurationRevision: '1', config: {} })
  try {
    await withReader(async ({ container, render, props, api, dom }) => {
      let recognizes = 0
      api.open = async () => fixtureSnapshot()
      await render({ ...props, translation: registry,
        settings: { ...defaultSettings, translationEngine: 'fixture-translation' },
        hostOcr: { async availability() { return { status: 'available' } },
          async recognize(request) {
            recognizes++
            assert.deepEqual([request.sessionId, request.documentId, request.page], ['session-1', 'document-1', 1])
            return { documentId: 'document-1', page: 1, revision: 1, contentVersion: 'contents-1', text: recognized,
              status: 'complete', source: { backendId: 'fixture-ocr', backendVersion: '1' }, geometry: { status: 'none' }, warnings: [] }
          } },
      })
      await clickReaderCommand(container, 'reader.ocrPage')
      await waitForReader(() => !!container.querySelector('.dsh-pdf-ocr-transcript'), 'OCR result should appear')
      assert.equal(container.querySelector('.dsh-pdf-ocr-transcript')!.textContent, recognized)
      const action = (label: string) => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-ocr-actions button')]
          .find(button => button.getAttribute('aria-label') === label || button.textContent === label)
        assert.ok(button, `OCR action ${label} exists`)
        return button
      }
      await act(async () => { action('reader.ocrTranslateAll').click() })
      await waitForReader(() => requests.length === 1, 'whole OCR text should reach the translation engine')
      assert.equal(container.querySelector('.dsh-pdf-translation-source-text')!.textContent, recognized)
      assert.equal(container.querySelector('.dsh-pdf-translation-source-label')!.textContent, 'reader.translation.ocrOriginal')
      assert.equal(container.querySelector('.dsh-pdf-translation-text')!.textContent, 'Translated OCR text')
      assert.equal(requests[0]!.text, recognized)
      assert.deepEqual(requests[0]!.context, { sessionId: 'session-1', documentId: 'document-1', contentVersion: 'contents-1', pages: [1] })

      await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.translation.backToOcr"]')!.click() })
      assert.equal(container.querySelector('[role="tab"][aria-label="reader.sidebar.ocr"]')!.getAttribute('aria-selected'), 'true')
      const pre = container.querySelector('.dsh-pdf-ocr-transcript')!
      const selected = '这是 OCR 文字 😀。'
      const start = recognized.indexOf(selected), end = start + selected.length
      const range = dom.document.createRange()
      range.setStart(pre.firstChild!, start); range.setEnd(pre.firstChild!, end)
      await act(async () => {
        dom.getSelection()!.removeAllRanges(); dom.getSelection()!.addRange(range)
        dom.document.dispatchEvent(new dom.Event('selectionchange'))
      })
      assert.equal(action('reader.ocrTranslateSelection').disabled, false)
      await act(async () => { action('reader.ocrTranslateSelection').click() })
      await waitForReader(() => requests.length === 2, 'selected OCR text should use the same translation engine')
      assert.equal(requests[1]!.text, selected)
      assert.equal(container.querySelector('.dsh-pdf-translation-source-text')!.textContent, selected)
      assert.deepEqual(requests[1]!.context, { sessionId: 'session-1', documentId: 'document-1', contentVersion: 'contents-1',
        pages: [1], selectionBefore: recognized.slice(0, start), selectionAfter: recognized.slice(end) })
      assert.equal(recognizes, 1, 'translating a subset reuses the same OCR result')
      assert.equal(container.querySelector('[role="alert"]'), null)
    })
  } finally { registry.dispose() }
})

test('Reader keeps a directory picker failure inside Save As and exits screenshot mode with Escape', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const dirty = fixtureSnapshot({ dirty: true, canUndo: true })
    api.open = async () => dirty
    let discarded = false
    api.discard = async () => { discarded = true; return fixtureSnapshot() }
    let pickerCalls = 0
    await render({ ...props, pickSaveDirectory: async () => { pickerCalls++; throw new Error('The system directory dialog failed') } })
    await act(async () => { await Promise.resolve() })
    await clickReaderCommand(container, 'reader.saveAs')
    const dialog = container.querySelector<HTMLDialogElement>('.dsh-pdf-save-as')!
    assert.ok(dialog)
    assert.equal(pickerCalls, 0, 'opening Save As only opens the filename/location sheet')
    const choose = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'reader.changeSaveLocation')!
    await act(async () => { choose.click(); await Promise.resolve() })
    assert.equal(pickerCalls, 1)
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /The system directory dialog failed/)
    assert.equal(container.querySelectorAll('[role="alert"]').length, 1, 'the picker error is not duplicated outside the modal')
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'reader.cancel')!.click() })
    assert.equal(container.querySelector('.dsh-pdf-save-as'), null)

    await clickReaderCommand(container, 'reader.discard')
    assert.equal(discarded, true)
    assert.equal(container.querySelector('[role="alert"]'), null, 'discard clears the failed save error')
    await clickReaderCommand(container, 'reader.regionScreenshot')
    assert.match(container.textContent ?? '', /reader.screenshotHint/)
    const tools = await openReaderFileMenu(container)
    await act(async () => { container.querySelector('.dsh-pdf-reader')!
      .dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(tools.open, false)
    assert.match(container.textContent ?? '', /reader.screenshotHint/, 'closing a menu preserves the active screenshot mode')
    await act(async () => { container.querySelector('.dsh-pdf-reader')!
      .dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
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
      const save = readerCommand(container, 'reader.save')
      assert.equal(save.disabled, false)
      await clickReaderCommand(container, 'reader.save')
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
    assert.ok(container.querySelector('.dsh-pdf-page-comment-card'), 'existing comments open directly in read mode')
    const color = container.querySelector<HTMLInputElement>('.dsh-pdf-annotation-toolbar .dsh-pdf-highlight-palette')!
    assert.ok(color, 'mark actions remain available while comments are visible')
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
    const color = container.querySelector<HTMLInputElement>('.dsh-pdf-annotation-toolbar .dsh-pdf-highlight-palette')!
    assert.ok(color)
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(color, '#ff0000')
      color.dispatchEvent(new dom.Event('input', { bubbles: true }))
      color.dispatchEvent(new dom.Event('change', { bubbles: true }))
      publish!({ ...fixtureSnapshot(), revision: 2 })
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    assert.equal(writes, 0, 'queued edits never target an annotation removed by another client')
    assert.equal(container.querySelector('.dsh-pdf-annotation-toolbar'), null)
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
      await clickReaderCommand(container, 'reader.regionScreenshot')
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
      await clickReaderCommand(container, 'reader.regionScreenshot')
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

test('Reader preserves a region question when Host region preparation fails', async () => {
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
      return { bytes: new Uint8Array([137, 80, 78, 71]), width: request.width,
        height: request.height, mime: 'image/png' }
    }
    const input = { ...props,
      promptExplanation: async () => {},
      imageUnderstanding: {
        availability: async () => ({ status: 'available' as const, kind: 'direct-image' as const, backendId: 'session-vision' }),
        prepare: async () => { throw new Error('not called before a question is saved') },
        prepareReference: async () => { throw new Error('not called before a question is saved') },
      },
      regionEvidence: { prepare: async () => {
        if (failRaster) throw new Error('Host explanation raster failed')
        throw new Error('Unexpected region request')
      } },
    } as ReaderProps
    try {
      await render(input)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      await clickReaderCommand(container, 'reader.explain.start')
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
      const failure = container.querySelector<HTMLElement>('.dsh-pdf-floating-status[data-status-id="explanation"]')!
      assert.match(failure?.textContent ?? '', /Host explanation raster failed/)
      const indicator = container.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!
      assert.equal(indicator.dataset.kind, 'error')
      await act(async () => { indicator.click() })
      assert.equal(failure.closest<HTMLElement>('.dsh-pdf-activity-popover')!.hidden, false,
        'the shared task entry exposes explanation failures')
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
    })
    await waitForReader(() => container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value === '2',
      'the coalesced navigation settles on the requested page')
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
    await waitForReader(() => container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value === '2',
      'the explicit page step supersedes the held resume')
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
    await act(async () => { pageTwo.click() })
    await waitForReader(() => container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value === '2',
      'Page 2 navigation did not settle')
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value, '2',
      container.querySelector('[role="alert"]')?.textContent ?? 'Page 2 navigation did not settle')
    // History is published after the asynchronous destination settles; a busy
    // CI worker can render page 2 before that toolbar state has committed.
    for (let attempt = 0; attempt < 20 && container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-back-split [aria-label="reader.back"]')?.disabled; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    }
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

test('Reader registers only its visible, ready PDF for validated tool-card navigation', async () => {
  await withReader(async ({ render, props, api }) => {
    const snapshot = fixtureSnapshot()
    api.open = async () => snapshot
    let lease: VisiblePdfReader | undefined
    let releases = 0
    const evidenceNavigation: NonNullable<ReaderProps['evidenceNavigation']> = {
      subscribe: () => () => {}, getRevision: () => 0,
      register(reader) { lease = reader; return () => { lease = undefined; releases++ } },
      canNavigate: () => false, navigate: async () => 'unavailable',
    }
    await render({ ...props, evidenceNavigation })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(lease?.sessionId, 'session-1')
    assert.equal(lease?.current()?.id, 'document-1')
    let finish!: (snapshot: WorkspaceSnapshot) => void
    api.open = () => new Promise(resolve => { finish = resolve })
    await render({ ...props, evidenceNavigation, content: { ...props.content, revision: 2 } })
    assert.equal(lease, undefined, 'tool-card navigation cannot claim a refreshing display owner')
    await act(async () => { finish(snapshot); await Promise.resolve() })
    await waitForReader(() => !!lease, 'the ready replacement did not re-register tool-card navigation')
    assert.equal((lease as VisiblePdfReader | undefined)?.current(), snapshot)
    await render(null)
    assert.equal(lease, undefined)
    assert.equal(releases, 2)
  })
})

function formSnapshot(id = 'document-1', value = 'source'): WorkspaceSnapshot {
  const base = fixtureSnapshot({ id, contentVersion: `${id}-contents` })
  const page = base.document.pages[0]!
  return { ...base, document: { ...base.document, pageCount: 2, pages: [page, { ...page, page: 2 }],
    formFields: [{ id: 'name', name: 'Name', type: 'text', value, readOnly: false, required: false,
      widgets: [{ page: 1, rect: [20, 20, 100, 40] }] }] } }
}

function exposeFormPage(dom: Window & typeof globalThis) {
  const previous = dom.HTMLElement.prototype.getBoundingClientRect
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('dsh-pdf-page') || this.classList.contains('dsh-pdf-page-wrap')
      || this.classList.contains('dsh-pdf-tile-surface') ? new dom.DOMRect(0, 0, 400, 600) : previous.call(this)
  }
}

test('Reader flushes focused form drafts before keyboard save, button Save and Undo using the resulting revision', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    exposeFormPage(dom)
    let current = formSnapshot()
    const calls: string[] = []
    let finishChange: (() => void) | undefined
    api.open = async () => current
    api.change = async (_session, id, revision, operations) => {
      const operation = operations[0]!
      assert.equal(operation.type, 'set-field')
      calls.push(`change:${id}:${revision}:${operation.type === 'set-field' ? operation.value : ''}`)
      await new Promise<void>(resolve => { finishChange = resolve })
      current = { ...current, revision: revision + 1, dirty: true, canUndo: true }
      return current
    }
    api.save = async (_session, id, revision) => { calls.push(`save:${id}:${revision}`); return current }
    api.undo = async (_session, id, revision) => { calls.push(`undo:${id}:${revision}`); return current }
    await render(props)
    await waitForReader(() => !!container.querySelector('.dsh-pdf-form-control'), 'form widget did not mount')
    const input = container.querySelector<HTMLInputElement>('.dsh-pdf-form-control')!
    const save = container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save')!
    assert.equal(save.disabled, true, 'a clean PDF starts with Save disabled')
    await act(async () => {
      input.focus(); input.value = 'keyboard draft'; input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    assert.equal(save.disabled, false, 'a staged form draft makes Save reachable before blur')
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))
    })
    assert.deepEqual(calls, ['change:document-1:1:keyboard draft'], 'Save waits for the field RPC')
    await act(async () => { finishChange!(); await Promise.resolve() })
    await waitForReader(() => calls.includes('save:document-1:2'), 'Save did not use the field commit revision')
    await act(async () => {
      input.value = 'undo draft'; input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    const undo = readerCommand(container, 'reader.undo')
    await act(async () => { undo.focus() })
    assert.deepEqual(calls.slice(-1), ['save:document-1:2'], 'focus on a document command keeps the blur draft staged')
    assert.equal(undo.disabled, false, 'blur cannot disable the command before its click')
    await act(async () => { undo.click() })
    assert.deepEqual(calls.slice(-1), ['change:document-1:2:undo draft'])
    await act(async () => { finishChange!(); await Promise.resolve() })
    await waitForReader(() => calls.includes('undo:document-1:3'), 'Undo did not wait for the focused field')
    await act(async () => {
      input.focus(); input.value = 'click draft'; input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    await act(async () => { save.focus() })
    assert.deepEqual(calls.slice(-1), ['undo:document-1:3'], 'moving focus onto Save stages the blur without a premature write')
    assert.equal(save.disabled, false, 'the Save click remains reachable after the field blurs')
    await act(async () => { save.click() })
    assert.deepEqual(calls.slice(-1), ['change:document-1:3:click draft'])
    await act(async () => { finishChange!(); await Promise.resolve() })
    await waitForReader(() => calls.includes('save:document-1:4'), 'the Save button did not flush its blur draft')
  })
})

test('Reader keeps failed form drafts and blocks both Save and right-sidebar page navigation until retry succeeds', async () => {
  await withReader(async ({ container, render, props, api, dom, tab }) => {
    exposeFormPage(dom)
    let current = formSnapshot(), changes = 0, saves = 0, fail = true
    api.open = async () => current
    api.change = async (_session, _id, revision) => {
      changes++
      if (fail) throw new Error('Form submission failed')
      current = { ...current, revision: revision + 1, dirty: true }
      return current
    }
    api.save = async () => { saves++; return current }
    await render(props)
    await waitForReader(() => !!container.querySelector('.dsh-pdf-form-control'), 'form widget did not mount')
    const input = container.querySelector<HTMLInputElement>('.dsh-pdf-form-control')!
    await act(async () => {
      input.focus(); input.value = 'keep this draft'; input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save')!.click() })
    assert.equal(saves, 0)
    assert.equal(changes, 1)
    assert.equal(input.value, 'keep this draft')
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.next"]')!.click() })
    assert.equal(changes, 2, 'page navigation retries the same retained draft')
    assert.equal(container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')!.value, '1')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Form submission failed/)
    fail = false
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.next"]')!.click() })
    await waitForReader(() => container.querySelector<HTMLInputElement>('.dsh-pdf-page-input')?.value === '2',
      'navigation did not proceed after a successful retry')
    assert.equal(changes, 3)
    tab.abort()
  })
})

test('Reader rejects a late form result and its waiting Save after switching documents', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    exposeFormPage(dom)
    const first = formSnapshot(), second = formSnapshot('document-2', 'second source')
    const calls: string[] = []
    let finishFirst: ((snapshot: WorkspaceSnapshot) => void) | undefined
    api.open = async (_session, address) => address.includes('second') ? second : first
    api.change = async (_session, id, revision) => {
      calls.push(`change:${id}:${revision}`)
      return id === first.id ? new Promise(resolve => { finishFirst = resolve })
        : { ...second, revision: revision + 1, dirty: true }
    }
    api.save = async (_session, id, revision) => { calls.push(`save:${id}:${revision}`); return second }
    await render(props)
    await waitForReader(() => !!container.querySelector('.dsh-pdf-form-control'), 'form widget did not mount')
    const firstInput = container.querySelector<HTMLInputElement>('.dsh-pdf-form-control')!
    await act(async () => {
      firstInput.focus(); firstInput.value = 'first draft'; firstInput.dispatchEvent(new dom.Event('input', { bubbles: true }))
      firstInput.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    })
    assert.deepEqual(calls, ['change:document-1:1'])
    await render({ ...props, resourceAddress: 'file:///tmp/second.pdf', content: { ...props.content, revision: 2 } })
    await waitForReader(() => container.querySelector<HTMLInputElement>('.dsh-pdf-form-control')?.value === 'second source',
      'replacement document form did not mount')
    await act(async () => { finishFirst!({ ...first, revision: 2, dirty: true }); await Promise.resolve() })
    assert.deepEqual(calls, ['change:document-1:1'], 'the waiting Save cannot write the replacement document')
    const secondInput = container.querySelector<HTMLInputElement>('.dsh-pdf-form-control')!
    await act(async () => {
      secondInput.focus(); secondInput.value = 'second draft'; secondInput.dispatchEvent(new dom.Event('input', { bubbles: true }))
      secondInput.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    })
    await waitForReader(() => calls.includes('save:document-2:2'), 'the replacement document did not save its own draft')
    assert.deepEqual(calls, ['change:document-1:1', 'change:document-2:1', 'save:document-2:2'])
  })
})

test('Reader confirms reload for an unsubmitted form and can enter explanation after flushing that same draft', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    exposeFormPage(dom)
    let current = formSnapshot()
    const calls: string[] = []
    api.open = async () => current
    api.reload = async () => { calls.push('reload'); return current }
    api.change = async (_session, _id, revision) => {
      calls.push(`change:${revision}`)
      current = { ...current, revision: revision + 1, dirty: true }
      return current
    }
    await render({ ...props, promptExplanation: async () => {} })
    await waitForReader(() => !!container.querySelector('.dsh-pdf-form-control'), 'form widget did not mount')
    const input = container.querySelector<HTMLInputElement>('.dsh-pdf-form-control')!
    await act(async () => {
      input.focus(); input.value = 'pending form'; input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    await clickReaderCommand(container, 'reader.reload')
    assert.match(container.querySelector('.dsh-pdf-dialog')?.textContent ?? '', /reader.reloadConfirm/)
    assert.deepEqual(calls, [], 'the pending form cannot be flushed and discarded without reload confirmation')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-dialog button')]
      .find(button => button.textContent === 'reader.cancel')!.click() })
    await clickReaderCommand(container, 'reader.explain.start')
    assert.deepEqual(calls, ['change:1'])
    assert.ok(container.querySelector('.dsh-pdf-mode-explanation'), 'the deferred start callback accepts the newly committed revision')
    assert.equal(readerCommand(container, 'reader.explain.exit').disabled, false)
  })
})

test('Reader executes a toolbar command once after a same-resource refresh becomes ready', async () => {
  await withReader(async ({ container, render, props, api }) => {
    await render(props)
    await waitForReader(() => !!container.querySelector('[data-pdf-page="1"]'), 'initial page did not mount')
    let finish!: (snapshot: WorkspaceSnapshot) => void
    api.open = () => new Promise(resolve => { finish = resolve })
    await render({ ...props, content: { ...props.content, revision: 2 } })
    assert.equal(readerCommand(container, 'reader.regionScreenshot').disabled, false)
    await clickReaderCommand(container, 'reader.regionScreenshot')
    assert.equal(container.querySelector('.dsh-pdf-mode-region'), null, 'the command waits for its display owner')
    await act(async () => { finish(fixtureSnapshot({ revision: 2 })); await Promise.resolve() })
    await waitForReader(() => !!container.querySelector('.dsh-pdf-mode-region'), 'the original click was dropped during refresh')
    assert.equal(container.querySelectorAll('.dsh-pdf-mode-region').length, 1)
  })
})

test('Reader cancels a command waiting for refresh when another resource takes the view', async () => {
  await withReader(async ({ container, render, props, api }) => {
    await render(props)
    await waitForReader(() => !!container.querySelector('[data-pdf-page="1"]'), 'initial page did not mount')
    let finishOld!: (snapshot: WorkspaceSnapshot) => void
    api.open = (_session, address) => address.includes('second') ? Promise.resolve(fixtureSnapshot({ id: 'document-2' }))
      : new Promise(resolve => { finishOld = resolve })
    await render({ ...props, content: { ...props.content, revision: 2 } })
    await clickReaderCommand(container, 'reader.regionScreenshot')
    await render({ ...props, resourceAddress: 'file:///tmp/second.pdf', content: { ...props.content, revision: 3 } })
    await act(async () => { finishOld(fixtureSnapshot({ revision: 2 })); await Promise.resolve() })
    assert.equal(container.querySelector('.dsh-pdf-mode-region'), null)
    await clickReaderCommand(container, 'reader.regionScreenshot')
    assert.ok(container.querySelector('.dsh-pdf-mode-region'), 'the replacement document accepts its own commands')
  })
})

/** Supply browser layout/painting ports while leaving Reader, Page and editor logic intact. */
function exposeReaderPageAndCards(dom: Window & typeof globalThis, api: PdfClientApi) {
  const previousBounds = dom.HTMLElement.prototype.getBoundingClientRect
  const previousContext = Object.getOwnPropertyDescriptor(dom.HTMLCanvasElement.prototype, 'getContext')!
  const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('dsh-pdf-reader')) return new dom.DOMRect(0, 0, 1100, 700)
    if (this.classList.contains('dsh-pdf-scroll')) return new dom.DOMRect(0, 0, 900, 700)
    if (this.classList.contains('dsh-pdf-page') || this.classList.contains('dsh-pdf-page-wrap')
      || this.classList.contains('dsh-pdf-tile-surface') || this.classList.contains('dsh-pdf-links')) return new dom.DOMRect(100, 80, 400, 600)
    if (this.classList.contains('dsh-pdf-page-comment-card')) {
      return new dom.DOMRect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0,
        parseFloat(this.style.width) || 300, 160)
    }
    return previousBounds.call(this)
  }
  Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({
    fillRect() {}, drawImage() {}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {},
    measureText(value: string) { return { width: value.length * 50 } },
  }) })
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true,
    value: async () => ({ width: 400, height: 600, close() {} }) })
  api.native.tile = async (_session, _document, _reader, request) => ({
    bytes: new Uint8Array([137, 80, 78, 71]), width: request.width, height: request.height, mime: 'image/png',
  })
  return () => {
    dom.HTMLElement.prototype.getBoundingClientRect = previousBounds
    Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', previousContext)
    if (previousBitmap) Object.defineProperty(globalThis, 'createImageBitmap', previousBitmap)
    else Reflect.deleteProperty(globalThis, 'createImageBitmap')
  }
}

function pendingRead<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: unknown) => void
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function freshReaderSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return fixtureSnapshot({ revision: 2, sourceVersion: 'source-2',
    reader: { bytesHash: `sha256:${'b'.repeat(64)}`, generation: 2, protocolVersion: 1 }, ...overrides })
}

function nativeReaderText(text: string) {
  return { items: [{ str: text, transform: [12, 0, 0, 12, 30, 500], width: 150, height: 12,
    dir: 'ltr', fontName: 'sans', hasEOL: true }],
  styles: { sans: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: 'en' }
}

function nativeReaderTile(request: NativeTileRequest): NativeTile {
  return { bytes: new Uint8Array([137, 80, 78, 71]), width: request.width, height: request.height, mime: 'image/png' }
}

test('Reader recovers real text and tile reads when Save advances the baseline before its response or watch', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const restore = exposeReaderPageAndCards(dom, api)
    const dirty = fixtureSnapshot({ dirty: true, canUndo: true })
    const saved = freshReaderSnapshot()
    const saveResponse = pendingRead<WorkspaceSnapshot>()
    const staleText = pendingRead<NativeTextContent>()
    const staleTiles: ReturnType<typeof pendingRead<NativeTile>>[] = []
    const obsoleteSignals: AbortSignal[] = []
    let opens = 0, refreshes = 0, saves = 0, reloads = 0
    let hostSaved = false
    api.open = async () => { opens++; return dirty }
    api.reload = async () => { reloads++; return saved }
    api.save = async () => { saves++; hostSaved = true; return saveResponse.promise }
    api.refresh = async (sessionId, id) => {
      assert.equal(hostSaved, true, 'the Host has committed Save before recovery starts')
      assert.equal(sessionId, props.sessionId); assert.equal(id, saved.id)
      refreshes++; return saved
    }
    api.native.text = async (_session, _id, reader, _page, signal) => {
      if (reader.bytesHash === saved.reader.bytesHash) return nativeReaderText('Fresh saved PDF text')
      assert.ok(signal); obsoleteSignals.push(signal)
      return staleText.promise
    }
    api.native.tile = async (_session, _id, reader, request, signal) => {
      if (reader.bytesHash === saved.reader.bytesHash) return nativeReaderTile(request)
      assert.ok(signal); obsoleteSignals.push(signal)
      const read = pendingRead<NativeTile>()
      staleTiles.push(read); return read.promise
    }
    try {
      await render(props)
      await waitForReader(() => obsoleteSignals.length > 1 && staleTiles.length > 0, 'real Page text and TileSurface reads did not start')
      await clickReaderCommand(container, 'reader.save')
      assert.equal(saves, 1)
      const stale = Object.assign(new Error('PDF baseline changed; use latest reader snapshot'), { code: 'pdf/stale-reader' })
      await act(async () => {
        staleText.reject(stale)
        for (const read of staleTiles) read.reject(stale)
        await Promise.resolve()
      })
      await waitForReader(() => container.querySelector('.dsh-pdf-text-layer')?.textContent?.includes('Fresh saved PDF text') === true
        && !!container.querySelector('canvas[data-pdf-raster-ready="true"]'), 'the recovered native baseline did not paint selectable text and tiles')
      assert.equal(refreshes, 1, 'simultaneous stale reads share one readonly snapshot refresh')
      assert.ok(obsoleteSignals.every(signal => signal.aborted), 'recovery cancels every obsolete native request')
      assert.equal(container.querySelector('[role="alert"]'), null, 'obsolete reads never leave a stale-reader banner')
      await act(async () => { saveResponse.resolve(saved); await Promise.resolve() })
      assert.equal(container.querySelector('[role="alert"]'), null)
      assert.equal(opens, 1, 'recovery retains the current document reference')
      assert.equal(reloads, 0, 'recovery does not reload or discard its working copy')
    } finally { restore() }
  })
})

test('Reader clears a failed stale-baseline recovery only after a replacement native read succeeds', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const restore = exposeReaderPageAndCards(dom, api)
    const staleText = pendingRead<NativeTextContent>()
    const nextText = pendingRead<NativeTextContent>()
    const nextTiles: { request: NativeTileRequest; read: ReturnType<typeof pendingRead<NativeTile>> }[] = []
    const nextLinks = pendingRead<unknown[]>()
    const nextOutline = pendingRead<null>()
    const next = freshReaderSnapshot()
    let publish: ((value: WorkspaceSnapshot) => void) | undefined
    let textStarted = false, nextReadsReady = false, refreshes = 0
    api.subscribe = (_id, listener) => { publish = listener; return () => { publish = undefined } }
    api.refresh = async () => {
      refreshes++
      throw Object.assign(new Error('Could not refresh the changed PDF baseline'), { code: 'pdf/stale-reader' })
    }
    api.native.text = async (_session, _id, reader) => {
      if (reader.bytesHash === next.reader.bytesHash) return nextText.promise
      textStarted = true; return staleText.promise
    }
    api.native.links = async (_session, _id, reader) => reader.bytesHash === next.reader.bytesHash ? nextLinks.promise : []
    api.native.outline = async (_session, _id, reader) => reader.bytesHash === next.reader.bytesHash ? nextOutline.promise : null
    api.native.tile = async (_session, _id, reader, request) => {
      if (reader.bytesHash !== next.reader.bytesHash || nextReadsReady) return nativeReaderTile(request)
      const read = pendingRead<NativeTile>()
      nextTiles.push({ request, read }); return read.promise
    }
    try {
      await render(props)
      await waitForReader(() => textStarted && !!container.querySelector('canvas[data-pdf-raster-ready="true"]'),
        'initial native Page reads did not start or its tile did not paint')
      const previousCanvas = container.querySelector<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')!
      await act(async () => {
        staleText.reject(Object.assign(new Error('PDF baseline changed'), { code: 'pdf/stale-reader' }))
        await Promise.resolve()
      })
      await waitForReader(() => !!container.querySelector('[role="alert"]'), 'failed snapshot recovery did not report an error')
      assert.equal(refreshes, 1)
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Could not refresh the changed PDF baseline/)
      assert.ok(publish)
      await act(async () => { publish!(next); await Promise.resolve() })
      await waitForReader(() => nextTiles.length > 0, 'replacement Page/TileSurface did not request a native tile')
      assert.ok(container.contains(previousCanvas), 'the last rendered frame remains visible during recovery')
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Could not refresh the changed PDF baseline/,
        'accepting a local document handle does not prove the new native baseline is readable')
      await act(async () => {
        nextReadsReady = true
        nextText.resolve(nativeReaderText('Recovered after watch'))
        for (const { request, read } of nextTiles) read.resolve(nativeReaderTile(request))
        await Promise.resolve()
      })
      await waitForReader(() => container.querySelector('.dsh-pdf-text-layer')?.textContent?.includes('Recovered after watch') === true
        && [...container.querySelectorAll('canvas[data-pdf-raster-ready="true"]')].some(canvas => canvas !== previousCanvas),
      'replacement baseline did not finish real Page painting')
      assert.equal(container.querySelector('[role="alert"]'), null, 'a successful current native read dismisses the obsolete recovery error')
      assert.equal(container.contains(previousCanvas), false, 'new native tiles replace the retained frame only when ready')
      assert.equal(refreshes, 1, 'a later watch publication does not start another automatic refresh')
    } finally { restore() }
  })
})

test('Reader preserves genuine Save and permission failures when a later native baseline becomes readable', async () => {
  for (const failure of [new Error('Writing the PDF failed'), Object.assign(new Error('Permission to save was denied'), { code: 'pdf/access-denied' })]) {
    await withReader(async ({ container, render, props, api, dom }) => {
      const restore = exposeReaderPageAndCards(dom, api)
      const next = freshReaderSnapshot({ dirty: true })
      let publish: ((value: WorkspaceSnapshot) => void) | undefined
      api.open = async () => fixtureSnapshot({ dirty: true })
      api.save = async () => { throw failure }
      api.subscribe = (_id, listener) => { publish = listener; return () => { publish = undefined } }
      api.native.text = async (_session, _id, reader) => nativeReaderText(
        reader.bytesHash === next.reader.bytesHash ? 'New current native text' : 'Original native text')
      try {
        await render(props)
        await waitForReader(() => container.querySelector('.dsh-pdf-text-layer')?.textContent?.includes('Original native text') === true,
          'original native Page did not render')
        await clickReaderCommand(container, 'reader.save')
        assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', new RegExp(failure.message))
        assert.ok(publish)
        await act(async () => { publish!(next); await Promise.resolve() })
        await waitForReader(() => container.querySelector('.dsh-pdf-text-layer')?.textContent?.includes('New current native text') === true,
          'replacement native Page did not render')
        assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', new RegExp(failure.message),
          'successful background reads must not erase an unrelated failed write')
      } finally { restore() }
    })
  }
})

test('Reader persists comment placement and independently moves the sticky-note card and its closed marker', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    const restore = exposeReaderPageAndCards(dom, api)
    const highlight = { id: 'commented-highlight', page: 1, subtype: 'Highlight',
      rect: [40, 400, 100, 420] as [number, number, number, number],
      commentPosition: [250, 300] as [number, number], color: [1, 1, 0] as [number, number, number],
      contents: 'Read this paragraph again', flags: 0, supported: true, editable: true }
    const note = { id: 'standalone-note', page: 1, subtype: 'Text',
      rect: [100, 250, 180, 330] as [number, number, number, number],
      color: [1, 1, 0] as [number, number, number], contents: 'Review this later', flags: 0, supported: true, editable: true }
    let current = fixtureSnapshot({ document: { ...fixtureSnapshot().document, annotations: [highlight, note] } })
    const writes: Parameters<PdfClientApi['change']>[3][] = []
    api.open = async () => current
    api.change = async (_session, id, revision, operations) => {
      assert.equal(id, current.id); assert.equal(revision, current.revision)
      writes.push(operations)
      current = { ...current, revision: revision + 1, dirty: true, canUndo: true,
        document: { ...current.document, annotations: current.document.annotations.map(annotation => {
          const update = operations.find(operation => operation.type === 'update' && operation.id === annotation.id)
          return update?.type === 'update' ? { ...annotation, ...update.patch } : annotation
        }) } }
      return current
    }
    try {
      await render(props)
      await waitForReader(() => !!container.querySelector('[data-pdf-note-id="standalone-note"]'), 'native PageView did not expose its sticky-note marker')
      const row = [...container.querySelectorAll<HTMLButtonElement>('.dsh-pdf-comment-item')]
        .find(button => button.textContent?.includes('Read this paragraph again'))!
      await act(async () => { row.click() })
      await waitForReader(() => container.querySelector<HTMLElement>('.dsh-pdf-page-comment-card')?.dataset.visible === 'true',
        'the comment did not attach to its real page anchor')
      await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.moveCommentCard"]')!
        .dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
      await waitForReader(() => writes.length === 1, 'moving the comment did not reach the shared mutation API')
      assert.deepEqual(writes[0], [{ type: 'update', id: highlight.id, patch: { commentPosition: [252, 300] } }])
      await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.closeComments"]')!.click() })
      const marker = () => container.querySelector<HTMLButtonElement>('[data-pdf-note-id="standalone-note"]')!
      await act(async () => { marker().click() })
      await waitForReader(() => container.querySelector<HTMLElement>('[data-card-kind="note"]')?.dataset.visible === 'true', 'the note card did not open at its marker')
      await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.moveNoteCard"]')!
        .dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
      await waitForReader(() => writes.length === 2, 'moving the note card did not persist its PDF anchor')
      const moved = current.document.annotations.find(annotation => annotation.id === note.id)!.rect!
      assert.equal(moved[0], 100); assert.equal(moved[2], 180)
      assert.ok(moved[1] < 250 && moved[1] > 247, 'moving down on screen decreases the PDF Y coordinate at the live page scale')
      assert.ok(Math.abs(moved[3] - moved[1] - 80) < 1e-6, 'moving preserves the note height')
      await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.closeNote"]')!.click() })
      assert.equal(container.querySelector('[data-card-kind="note"]'), null)
      await act(async () => { marker().dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
      await waitForReader(() => writes.length === 3, 'moving the closed note marker did not persist its PDF anchor')
      const movedMarker = current.document.annotations.find(annotation => annotation.id === note.id)!.rect!
      assert.ok(movedMarker[0] > moved[0] && movedMarker[0] < moved[0] + 3)
      assert.ok(Math.abs(movedMarker[1] - moved[1]) < 1e-6)
      assert.ok(Math.abs(movedMarker[2] - movedMarker[0] - 80) < 1e-6, 'moving the closed marker preserves note width')
      assert.equal(current.dirty, true); assert.equal(current.revision, 4)
      await act(async () => { marker().click() })
      await waitForReader(() => !!container.querySelector('[data-card-kind="note"]'), 'the moved marker did not reopen its note')
      assert.match(container.querySelector('.dsh-pdf-note-body')?.textContent ?? '', /Review this later/)
    } finally { restore() }
  })
})

test('Reader creates an embedded bookmark through its sidebar editor and the shared revision-checked mutation API', async () => {
  await withReader(async ({ container, render, props, api, dom }) => {
    let current = fixtureSnapshot({ document: { ...fixtureSnapshot().document, outline: [] } })
    const operations: Parameters<PdfClientApi['change']>[3][] = []
    api.open = async () => current
    api.native.outline = async () => (current.document.outline ?? []).map(item => ({ id: item.id, title: item.title,
      dest: [(item.page ?? 1) - 1, { name: 'Fit' }], items: [] }))
    api.change = async (_session, id, revision, changes) => {
      assert.equal(id, current.id); assert.equal(revision, 1)
      operations.push(changes)
      const addition = changes[0]!
      assert.equal(addition.type, 'outline-add')
      assert.ok(addition.type === 'outline-add')
      current = { ...current, revision: 2, dirty: true, document: { ...current.document,
        outline: [{ id: addition.id, title: addition.title, page: addition.page, children: [] }] } }
      return current
    }
    await render(props)
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="reader.sidebar.bookmarks"]')!.click() })
    await waitForReader(() => !!container.querySelector('[aria-label="reader.sidebar.addPdfBookmark"]'), 'the editable bookmark panel did not load')
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="reader.sidebar.addPdfBookmark"]')!.click() })
    const editor = container.querySelector<HTMLFormElement>('.dsh-pdf-outline-name-editor')!
    assert.ok(editor, 'Add bookmark opens an inline title editor')
    const name = editor.querySelector<HTMLInputElement>('input')!
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(name, 'A useful reading stop'); name.dispatchEvent(new dom.Event('input', { bubbles: true })) })
    await act(async () => { editor.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })) })
    await waitForReader(() => operations.length === 1, 'the inline editor did not submit its bookmark')
    assert.equal(current.dirty, true); assert.equal(current.revision, 2)
    assert.equal(current.document.outline?.[0]?.title, 'A useful reading stop')
    await waitForReader(() => container.querySelector('.dsh-pdf-bookmark-panel')?.textContent?.includes('A useful reading stop') ?? false,
      'the created bookmark did not appear in the Reader sidebar')
  })
})
