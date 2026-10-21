import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { AnnotationColorBar } from '../../../src/modules/viewer/components/AnnotationColorBar.tsx'
import { AnnotationList } from '../../../src/modules/viewer/components/AnnotationList.tsx'
import { BookmarkPanel } from '../../../src/modules/viewer/components/BookmarkPanel.tsx'
import { ExplanationQuestionEditor } from '../../../src/modules/viewer/components/ExplanationQuestionEditor.tsx'
import { FloatingToolbar } from '../../../src/modules/viewer/components/FloatingToolbar.tsx'
import { OcrTranscriptPanel } from '../../../src/modules/viewer/components/OcrTranscriptPanel.tsx'
import { ReadingSidebar } from '../../../src/modules/viewer/components/ReadingSidebar.tsx'
import { ScreenshotPreview } from '../../../src/modules/viewer/components/ScreenshotPreview.tsx'
import { SplitActionControl } from '../../../src/modules/viewer/components/SplitActionControl.tsx'
import { TranslationPanel } from '../../../src/modules/viewer/components/TranslationPanel.tsx'
import { ToolbarTooltip } from '../../../src/modules/viewer/components/ToolbarTooltip.tsx'
import { TranslationError, type TranslationResult } from '../../../src/translation/index.ts'
import type { HostOcrRecognition } from '../../../src/adapters/client/remote/host-ocr-api.ts'
import type { ReaderDocument, ReaderOutlineItem } from '../../../src/modules/viewer/ports/reader-document.ts'
import { HIGHLIGHT_QUICK_COLORS_KEY } from '../../../src/modules/viewer/model/highlight-colors.ts'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withDom(run: (dom: Window & typeof globalThis, container: HTMLElement,
  render: (element: React.ReactElement) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const values = { window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, HTMLDialogElement: dom.HTMLDialogElement, Node: dom.Node, Element: dom.Element,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    CustomEvent: dom.CustomEvent, StorageEvent: dom.StorageEvent, localStorage: dom.localStorage,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
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
    await act(async () => { rootView.render(element); await Promise.resolve() })
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

const t = (key: string) => key

test('OCR transcript surfaces clipboard denial and clears it after a successful retry', async () => {
  await withDom(async (dom, container, render) => {
    const result: HostOcrRecognition = {
      documentId: 'doc', page: 2, revision: 1, contentVersion: 'v1', text: 'Recognized text', status: 'partial',
      source: { backendId: 'local', backendVersion: '1' }, geometry: { status: 'none' }, warnings: [],
    }
    await render(React.createElement(OcrTranscriptPanel, { result, region: true, t }))
    assert.match(container.textContent ?? '', /reader\.ocrPartial/)
    const copy = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => { copy.click() })
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reader\.ocrCopyFailed/)
    Object.defineProperty(dom.navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('permission denied') } } })
    await act(async () => { copy.click(); await Promise.resolve() })
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /reader\.ocrCopyFailed/)
    let copied = ''
    Object.defineProperty(dom.navigator, 'clipboard', { configurable: true,
      value: { writeText: async (text: string) => { copied = text } } })
    await act(async () => { copy.click(); await Promise.resolve() })
    assert.equal(copied, result.text)
    assert.equal(container.querySelector('[role="alert"]'), null)
  })
})

test('split action menu closes on Escape and outside pointer while preserving the main action', async () => {
  await withDom(async (dom, container, render) => {
    let actions = 0
    await render(React.createElement('div', { className: 'dsh-pdf-reader' },
      React.createElement(SplitActionControl, {
        label: 'Highlight', actionLabel: 'Apply highlight', menuLabel: 'Pick highlight color',
        action: React.createElement('span', null, 'marker'), onAction: () => { actions++ },
        children: close => React.createElement('button', { type: 'button', onClick: close }, 'Yellow'),
      })))
    const main = container.querySelector<HTMLButtonElement>('.dsh-pdf-split-action-main')!
    const trigger = container.querySelector<HTMLButtonElement>('.dsh-pdf-split-action-trigger')!
    await act(async () => { trigger.click() })
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    await act(async () => { dom.document.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(dom.document.activeElement, trigger)
    await act(async () => { trigger.click() })
    await act(async () => { dom.document.body.dispatchEvent(new dom.Event('pointerdown', { bubbles: true })) })
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    await act(async () => { main.click() })
    assert.equal(actions, 1)
  })
})

test('translation panel handles provider cancellation and shows partial-result warnings and preference failures', async () => {
  await withDom(async (_dom, container, render) => {
    const selection = { text: 'word', pages: [1], targetLanguage: 'en' }
    const base = { selection, engineName: 'Test', onClose() {}, t }
    await render(React.createElement(TranslationPanel, { ...base,
      translate: async () => { throw new TranslationError('cancelled', 'cancelled by provider') } }))
    assert.match(container.querySelector('.dsh-pdf-translation-status')?.textContent ?? '', /reader\.translation\.cancelled/)

    const result: TranslationResult = { text: 'translation', status: 'partial',
      warnings: ['max-tokens', 'backend-note'], detectedSourceLanguage: 'xx',
      source: { engineId: 'test', engineVersion: '1', instanceId: 'test', configurationRevision: '1' } }
    await render(React.createElement(TranslationPanel, { ...base, selection: { ...selection },
      translate: async () => result, rememberTargetLanguage: async () => { throw new Error('storage offline') } }))
    assert.match(container.textContent ?? '', /reader\.translation\.detectedLanguage xx/)
    assert.match(container.textContent ?? '', /reader\.translation\.partial/)
    assert.match(container.textContent ?? '', /reader\.translation\.warningMaxTokens/)
    assert.match(container.textContent ?? '', /reader\.translation\.warningUnknown backend-note/)
    const french = container.querySelector<HTMLButtonElement>('button[aria-label="reader.translation.language.fr"]')!
    assert.ok(french)
    await act(async () => { french.click(); await Promise.resolve() })
    assert.match(container.querySelector('.dsh-pdf-translation-preference.is-error')?.textContent ?? '',
      /reader\.translation\.languageSaveFailed/)
  })
})

test('screenshot preview reports modal failure and handles native cancellation', async () => {
  await withDom(async (dom, container, render) => {
    const errors: unknown[] = []
    let closes = 0
    const image = { blob: new Blob(['image'], { type: 'image/png' }), width: 10, height: 10, page: 1 }
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL
    const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')
    URL.createObjectURL = () => 'blob:preview'
    URL.revokeObjectURL = () => {}
    const prototype = dom.HTMLDialogElement.prototype
    const originalShow = prototype.showModal, originalClose = prototype.close
    prototype.showModal = function () { throw new Error('modal unavailable') }
    prototype.close = function () { this.removeAttribute('open') }
    try {
      const props = { image, t, onError: (error: unknown) => errors.push(error), onClose: () => { closes++ } }
      await render(React.createElement(ScreenshotPreview, props))
      assert.equal(closes, 1)
      assert.match(String(errors[0]), /reader\.screenshot\.previewFailed/)
      prototype.showModal = function () { this.setAttribute('open', '') }
      await render(React.createElement(ScreenshotPreview, { ...props, image: { ...image } }))
      // A new component instance is required after a failed showModal request.
      await render(React.createElement('div'))
      await render(React.createElement(ScreenshotPreview, props))
      const dialog = container.querySelector<HTMLDialogElement>('dialog')!
      assert.equal(dialog.open, true)
      await act(async () => { dialog.dispatchEvent(new dom.KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Tab',
      })) })
      assert.equal(dom.document.activeElement, dialog, 'a modal without visible tab stops retains keyboard focus')
      Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true,
        value: class { static supports() { return true }; constructor(_data: unknown) {} } })
      Object.defineProperty(dom.navigator, 'clipboard', { configurable: true,
        value: { write: async () => { throw new Error('clipboard permission denied') } } })
      await act(async () => { dialog.querySelector<HTMLButtonElement>('.dsh-pdf-screenshot-actions button')!.click() })
      assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /reader\.screenshot\.copyFailed/)
      assert.equal(errors.length, 2)
      await act(async () => { dialog.dispatchEvent(new dom.Event('cancel', { cancelable: true })) })
      assert.equal(closes, 2)
      assert.equal(dialog.open, false)
    } finally {
      prototype.showModal = originalShow
      prototype.close = originalClose
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      if (originalClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItem)
      else Reflect.deleteProperty(globalThis, 'ClipboardItem')
    }
  })
})

test('page comment card stays attached above its mark and tolerates transient missing anchors', async () => {
  // The real component imports a CSS asset that Node cannot load. Its placement
  // logic uses measured DOM geometry, so only that non-executable asset is stubbed.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  const { AnnotationCommentCard } = await import('../../../src/modules/viewer/components/AnnotationCommentCard.tsx')
  await withDom(async (dom, _container, render) => {
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, right: left + width, bottom: top + height, width, height,
      x: left, y: top, toJSON() {},
    }) as DOMRect
    function pointer(type: string, x: number, y: number) {
      const event = new dom.Event(type, { bubbles: true, cancelable: true })
      for (const [key, value] of Object.entries({ pointerId: 7, isPrimary: true, button: 0, clientX: x, clientY: y }))
        Object.defineProperty(event, key, { configurable: true, value })
      return event
    }
    const reader = dom.document.createElement('div')
    reader.className = 'dsh-pdf-reader'
    const viewport = dom.document.createElement('div')
    viewport.tabIndex = 0
    reader.append(viewport)
    dom.document.body.append(reader)
    reader.getBoundingClientRect = () => rect(0, 0, 500, 500)
    viewport.getBoundingClientRect = () => rect(0, 0, 500, 500)
    const heightDescriptor = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(dom.HTMLElement.prototype, 'offsetHeight', { configurable: true,
      get() { return this instanceof dom.HTMLElement && this.classList.contains('dsh-pdf-page-comment-card') ? 100 : 0 } })
    let anchor: DOMRect | null = rect(200, 450, 100, 20)
    let visible = 0
    const props = { viewport, getAnchor: () => anchor, label: 'Edit comment',
      children: React.createElement(React.Fragment, null,
        React.createElement('button', { type: 'button', 'data-comment-card-drag-handle': '' }, 'Move'),
        React.createElement('button', { type: 'button', className: 'edit-comment' }, 'Edit')),
      onVisible: () => { visible++ } }
    try {
      await render(React.createElement(AnnotationCommentCard, props))
      const card = reader.querySelector<HTMLElement>('.dsh-pdf-page-comment-card')!
      assert.equal(card.dataset.visible, 'true')
      assert.ok(Number.parseFloat(card.style.top) < 450, 'a narrow viewport places the card above the selected mark')
      assert.match(reader.querySelector('svg path[marker-end]')?.getAttribute('d') ?? '', /^M /)
      assert.equal(visible, 1)
      let committedMove: { x: number; y: number } | undefined
      const noteProps = { ...props, connector: false, cardKind: 'note' as const,
        sizeKey: 'document:note-1', resizeLabel: 'Resize note',
        onMove: (delta: { x: number; y: number }) => { committedMove = delta; return true } }
      await render(React.createElement(AnnotationCommentCard, noteProps))
      assert.equal(card.dataset.cardKind, 'note')
      assert.equal(reader.querySelector('svg.dsh-pdf-comment-connector'), null,
        'a standalone note card is placed beside its marker without a comment arrow')
      assert.equal(card.dataset.visible, 'true')
      for (const [x, y] of [[4, 4], [476, 4], [4, 476], [476, 476]]) {
        anchor = rect(x, y, 20, 20)
        await render(React.createElement(AnnotationCommentCard, noteProps))
        const left = Number.parseFloat(card.style.left), top = Number.parseFloat(card.style.top)
        assert.equal(card.dataset.visible, 'true', `a note opens at the ${x},${y} corner`)
        assert.ok(left >= 12 && left + Number.parseFloat(card.style.width) <= 488,
          'the opened note stays inside the horizontal reader edges')
        assert.ok(top >= 12 && top + 100 <= 488, 'the opened note stays inside the vertical reader edges')
      }
      anchor = rect(200, 450, 100, 20)
      const noteMoveHandle = card.querySelector<HTMLButtonElement>('[data-comment-card-drag-handle]')!
      await act(async () => {
        noteMoveHandle.dispatchEvent(pointer('pointerdown', 420, 200))
        noteMoveHandle.dispatchEvent(pointer('pointermove', 438, 217))
        noteMoveHandle.dispatchEvent(pointer('pointerup', 438, 217))
        await Promise.resolve()
      })
      assert.deepEqual(committedMove, { x: 18, y: 17 }, 'moving an open note commits its displacement to the owner')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      await act(async () => {
        noteMoveHandle.dispatchEvent(new dom.KeyboardEvent('keydown', {
          bubbles: true, cancelable: true, key: 'ArrowRight', shiftKey: true,
        }))
        await new Promise(resolve => setTimeout(resolve, 5))
      })
      assert.deepEqual(committedMove, { x: 10, y: 0 }, 'keyboard movement persists the note position')
      await render(React.createElement(AnnotationCommentCard, { ...noteProps,
        onMove: async () => { throw new Error('storage unavailable') },
      }))
      await act(async () => {
        noteMoveHandle.dispatchEvent(new dom.KeyboardEvent('keydown', {
          bubbles: true, cancelable: true, key: 'ArrowDown',
        }))
        await new Promise(resolve => setTimeout(resolve, 5))
      })
      assert.equal(card.dataset.moving, undefined, 'failed keyboard persistence releases its moving state')
      anchor = rect(20, 20, 20, 20)
      await render(React.createElement(AnnotationCommentCard, noteProps))
      const originalCardBounds = card.getBoundingClientRect
      card.getBoundingClientRect = () => rect(Number.parseFloat(card.style.left), Number.parseFloat(card.style.top),
        Number.parseFloat(card.style.width), Number.parseFloat(card.style.height) || 130)
      const resize = card.querySelector<HTMLButtonElement>('[data-note-card-resize-handle]')!
      await act(async () => {
        resize.dispatchEvent(pointer('pointerdown', 250, 200))
        resize.dispatchEvent(pointer('pointermove', 290, 230))
        resize.dispatchEvent(pointer('pointerup', 290, 230))
      })
      const savedSize = JSON.parse(dom.localStorage.getItem('dsh-pdf:note-card-size:v1:document:note-1')!)
      assert.ok(savedSize.width >= 330, 'dragging the resize corner expands the note')
      assert.ok(savedSize.height >= 160)
      await act(async () => { resize.dispatchEvent(new dom.KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'ArrowLeft', shiftKey: true,
      })) })
      assert.equal(JSON.parse(dom.localStorage.getItem('dsh-pdf:note-card-size:v1:document:note-1')!).width,
        savedSize.width - 10, 'keyboard resizing persists the new width')
      card.getBoundingClientRect = originalCardBounds
      await render(React.createElement(AnnotationCommentCard, props))
      await render(React.createElement(AnnotationCommentCard, noteProps))
      assert.equal(Number.parseFloat(card.style.width), savedSize.width - 10,
        'reopening the note restores its individually saved width')
      assert.equal(Number.parseFloat(card.style.height), savedSize.height,
        'reopening the note restores its individually saved height')
      await render(React.createElement(AnnotationCommentCard, props))
      const toolbar = dom.document.createElement('div')
      toolbar.className = 'dsh-pdf-annotation-toolbar'
      toolbar.dataset.visible = 'true'
      toolbar.getBoundingClientRect = () => rect(0, 350, 400, 100)
      reader.append(toolbar)
      await render(React.createElement(AnnotationCommentCard, props))
      assert.ok(Number.parseFloat(card.style.top) <= 238, 'the comment card moves above a lower toolbar')
      toolbar.remove()
      reader.getBoundingClientRect = viewport.getBoundingClientRect = () => rect(0, 0, 800, 500)
      anchor = rect(300, 200, 100, 20)
      const tallToolbar = dom.document.createElement('div')
      tallToolbar.className = 'dsh-pdf-annotation-toolbar'
      tallToolbar.dataset.visible = 'true'
      tallToolbar.getBoundingClientRect = () => rect(500, 100, 300, 400)
      reader.append(tallToolbar)
      await render(React.createElement(AnnotationCommentCard, props))
      assert.ok(Number.parseFloat(card.style.left) >= 12, 'the card stays clamped when neither vertical side fits')
      tallToolbar.remove()
      await render(React.createElement(AnnotationCommentCard, props))
      const initialLeft = Number.parseFloat(card.style.left)
      const initialTop = Number.parseFloat(card.style.top)
      const connector = reader.querySelector('svg path[marker-end]')!
      const initialPath = connector.getAttribute('d')
      const move = card.querySelector<HTMLButtonElement>('[data-comment-card-drag-handle]')!
      await act(async () => {
        move.dispatchEvent(pointer('pointerdown', 420, 200))
        move.dispatchEvent(pointer('pointermove', 360, 230))
        await new Promise(resolve => setTimeout(resolve, 5))
      })
      assert.equal(Number.parseFloat(card.style.left), initialLeft - 60, 'drag follows the pointer horizontally')
      assert.equal(Number.parseFloat(card.style.top), initialTop + 30, 'drag follows the pointer vertically')
      assert.notEqual(connector.getAttribute('d'), initialPath, 'the connector is redrawn to the moved card')
      await act(async () => {
        move.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
      })
      assert.equal(Number.parseFloat(card.style.left), initialLeft - 58, 'the accessible move handle supports arrow-key nudging')
      await act(async () => {
        move.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }))
      })
      assert.equal(Number.parseFloat(card.style.top), initialTop + 28, 'the accessible move handle supports vertical arrow-key nudging')
      await act(async () => {
        move.dispatchEvent(pointer('pointermove', -500, -500))
        await new Promise(resolve => setTimeout(resolve, 5))
        move.dispatchEvent(pointer('pointerup', -500, -500))
      })
      assert.ok(Number.parseFloat(card.style.left) >= 12, 'dragging cannot move the card beyond the reader edge')
      assert.ok(Number.parseFloat(card.style.top) >= 12, 'dragging cannot move the card above the reader')
      anchor = null
      await render(React.createElement(AnnotationCommentCard, props))
      assert.equal(card.dataset.visible, 'true', 'the missing anchor grace period avoids a zoom flash')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
      assert.equal(card.dataset.visible, 'false', 'a genuinely removed mark hides its editor')
      anchor = rect(200, 450, 100, 20)
      await render(React.createElement(AnnotationCommentCard, props))
      assert.equal(card.dataset.visible, 'true')
      anchor = null
      await render(React.createElement(AnnotationCommentCard, props))
      anchor = rect(200, 450, 100, 20)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
      assert.equal(card.dataset.visible, 'true', 'a rebound PageView keeps its in-page editor')
      const editorButton = card.querySelector<HTMLButtonElement>('.edit-comment')!
      editorButton.focus()
      viewport.removeAttribute('tabindex')
      anchor = rect(900, 200, 50, 20)
      await render(React.createElement(AnnotationCommentCard, props))
      assert.equal(card.dataset.visible, 'false')
      assert.notEqual(dom.document.activeElement, editorButton, 'a hidden comment editor must release focus')
    } finally {
      if (heightDescriptor) Object.defineProperty(dom.HTMLElement.prototype, 'offsetHeight', heightDescriptor)
      else Reflect.deleteProperty(dom.HTMLElement.prototype, 'offsetHeight')
      reader.remove()
    }
  })
})

test('question editor keyboard shortcuts save a nonempty question or cancel the draft', async () => {
  await withDom(async (dom, _container, render) => {
    // React's legacy input fallback asks for these methods in jsdom even
    // though modern browsers use native input events.
    const priorAttach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, 'attachEvent')
    const priorDetach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, 'detachEvent')
    Object.defineProperty(dom.HTMLElement.prototype, 'attachEvent', { configurable: true, value() {} })
    Object.defineProperty(dom.HTMLElement.prototype, 'detachEvent', { configurable: true, value() {} })
    const reader = dom.document.createElement('div')
    reader.className = 'dsh-pdf-reader'
    const viewport = dom.document.createElement('div')
    reader.append(viewport)
    dom.document.body.append(reader)
    const rect = { left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400,
      x: 0, y: 0, toJSON() {} } as DOMRect
    reader.getBoundingClientRect = viewport.getBoundingClientRect = () => rect
    let saves = 0, cancellations = 0
    try {
      await render(React.createElement(ExplanationQuestionEditor, {
        viewport, getAnchor: () => ({ ...rect, left: 100, top: 140, right: 200, bottom: 160,
          width: 100, height: 20 } as DOMRect), mode: 'new', index: 0,
        question: 'Why does this equation hold?', disabled: false, t,
        onChange() {}, onSave() { saves++ }, onCancel() { cancellations++ },
      }))
      const editor = reader.querySelector<HTMLElement>('.dsh-pdf-explanation-question-editor')!
      assert.ok(editor)
      await act(async () => { editor.dispatchEvent(new dom.KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Enter', metaKey: true,
      })) })
      assert.equal(saves, 1)
      await act(async () => { editor.dispatchEvent(new dom.KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Escape',
      })) })
      assert.equal(cancellations, 1)
    } finally {
      reader.remove()
      if (priorAttach) Object.defineProperty(dom.HTMLElement.prototype, 'attachEvent', priorAttach)
      else Reflect.deleteProperty(dom.HTMLElement.prototype, 'attachEvent')
      if (priorDetach) Object.defineProperty(dom.HTMLElement.prototype, 'detachEvent', priorDetach)
      else Reflect.deleteProperty(dom.HTMLElement.prototype, 'detachEvent')
    }
  })
})

test('contextual toolbar hides when its actions cannot fit below the main toolbar', async () => {
  await withDom(async (dom, container, render) => {
    const viewport = dom.document.createElement('div')
    const bounds = { left: 0, top: 0, right: 300, bottom: 40, width: 300, height: 40,
      x: 0, y: 0, toJSON() {} } as DOMRect
    viewport.getBoundingClientRect = () => bounds
    const anchor = { ...bounds, left: 50, right: 100, top: 10, bottom: 20, width: 50, height: 10 } as DOMRect
    const descriptor = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(dom.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
      return this instanceof dom.HTMLElement && this.classList.contains('dsh-pdf-context-toolbar') ? 60 : 0
    } })
    try {
      await render(React.createElement('div', { className: 'dsh-pdf-reader' },
        React.createElement(FloatingToolbar, {
          viewport,
          getAnchor: () => anchor,
          label: 'Actions',
          children: React.createElement('button', null, 'Explain'),
        })))
      assert.equal(container.querySelector<HTMLElement>('.dsh-pdf-context-toolbar')?.dataset.visible, 'false')
    } finally {
      if (descriptor) Object.defineProperty(dom.HTMLElement.prototype, 'offsetHeight', descriptor)
      else Reflect.deleteProperty(dom.HTMLElement.prototype, 'offsetHeight')
    }
  })
})

test('unmounting the sidebar releases an in-progress resize pointer capture', async () => {
  await withDom(async (dom, container, render) => {
    const props = {
      activeSection: 'ocr' as const, onSectionChange() {}, expanded: true, onExpandedChange() {},
      panels: {}, pdf: null, currentPage: 1, pageInput: '1', navigating: false,
      onPageInputChange() {}, onPageInputSubmit() {}, onPageInputReset() {},
      onNavigatePage() {}, onStepPage() {}, onNavigateDestination() {}, t,
    }
    await render(React.createElement(ReadingSidebar, props))
    const divider = container.querySelector<HTMLElement>('.dsh-pdf-sidebar-divider')!
    let captured = false, releases = 0
    divider.setPointerCapture = () => { captured = true }
    divider.hasPointerCapture = () => captured
    divider.releasePointerCapture = () => { captured = false; releases++ }
    const start = new dom.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 240 })
    Object.defineProperty(start, 'pointerId', { value: 7 })
    await act(async () => { divider.dispatchEvent(start) })
    assert.equal(captured, true)
    await render(React.createElement('div'))
    assert.equal(releases, 1)
  })
})

test('annotation previews cancel their shared page text request after the final visible consumer leaves', async () => {
  await withDom(async (_dom, _container, render) => {
    let textSignal: AbortSignal | undefined
    const pdf = { text(_page: number, signal: AbortSignal) {
      textSignal = signal
      return new Promise<never>(() => {})
    } }
    const mark = { id: 'highlight', page: 1, subtype: 'Highlight', flags: 4,
      supported: true, editable: true, rect: [10, 10, 30, 20] as [number, number, number, number],
      quadPoints: [10, 20, 30, 20, 10, 10, 30, 10] }
    await render(React.createElement('div', { className: 'dsh-pdf-panel-scroll' },
      React.createElement(AnnotationList, {
        annotations: [mark], pdf: pdf as never, onSelect() {}, onDeselect() {}, t,
      })))
    assert.ok(textSignal, 'a visible highlight requests its page text')
    assert.equal(textSignal.aborted, false)
    await render(React.createElement('div'))
    assert.equal(textSignal.aborted, true)
  })
})

test('outline leaves invalid named destinations disabled while retaining external links', async () => {
  await withDom(async (_dom, container, render) => {
    const outline: ReaderOutlineItem[] = [
      { title: 'First chapter', dest: [0, { name: 'Fit' }], items: [] },
      { title: 'Missing chapter', dest: 'missing', items: [] },
      { title: 'Reference website', url: 'https://example.com/', items: [] },
    ]
    const destinations: unknown[] = []
    const pdf = { numPages: 1, async getOutline() { return outline },
      async getDestination() { throw new Error('destination removed') }, async getPageIndex() { return 0 },
    } as unknown as ReaderDocument
    await render(React.createElement(BookmarkPanel, { pdf, active: true, currentPage: 1,
      onNavigateDestination: destination => { destinations.push(destination) }, t }))
    const valid = [...container.querySelectorAll<HTMLElement>('.dsh-pdf-bookmark-row')]
      .find(row => row.textContent?.includes('First chapter'))!
    await act(async () => { valid.click() })
    assert.deepEqual(destinations, [outline[0]!.dest], 'the entire valid row navigates')
    await act(async () => { valid.querySelector<HTMLButtonElement>('.dsh-pdf-bookmark-link')!.click() })
    assert.deepEqual(destinations, [outline[0]!.dest, outline[0]!.dest], 'button click does not navigate twice')
    assert.ok(container.querySelector('[title="destination removed"]'))
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/"]')
    assert.equal(link?.textContent, 'Reference website')
    assert.equal(link?.rel, 'noopener noreferrer')
  })
})

test('quick-color storage reset and focused tooltip survive indirect browser events', async () => {
  await withDom(async (dom, container, render) => {
    dom.localStorage.setItem(HIGHLIGHT_QUICK_COLORS_KEY, JSON.stringify(['#ffff00']))
    await render(React.createElement(AnnotationColorBar, {
      value: '#ffff00', label: 'Palette', t, onQuickColor() {}, onPaletteColor() {},
    }))
    assert.equal(container.querySelectorAll('.dsh-pdf-highlight-swatch').length, 1)
    dom.localStorage.setItem(HIGHLIGHT_QUICK_COLORS_KEY, JSON.stringify(['#ffff00', '#ff9f0a']))
    await act(async () => { dom.dispatchEvent(new dom.StorageEvent('storage', { key: null })) })
    assert.equal(container.querySelectorAll('.dsh-pdf-highlight-swatch').length, 2)
    await render(React.createElement(ToolbarTooltip, { children: React.createElement('div', null,
      React.createElement('button', { 'data-tooltip': 'Zoom in' }, 'Zoom')) }))
    const button = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      button.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      button.focus()
      await Promise.resolve()
    })
    assert.match(dom.document.body.querySelector('[role="tooltip"]')?.textContent ?? '', /Zoom in/)
    await act(async () => { dom.dispatchEvent(new dom.Event('scroll', { bubbles: true })) })
    assert.match(dom.document.body.querySelector('[role="tooltip"]')?.textContent ?? '', /Zoom in/)
  })
})
