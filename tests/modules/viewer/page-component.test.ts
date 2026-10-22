import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { Page, type PageProps } from '../../../src/modules/viewer/rendering/Page.tsx'
import { NativeViewport } from '../../../src/modules/viewer/rendering/viewport.ts'
import type { NativeDocument, NativePage } from '../../../src/modules/viewer/rendering/document.ts'
import type { PdfAnnotation, PdfPageInfo } from '../../../src/core/pdf-types.ts'
import type { PdfOcrTextPart } from '../../../src/ocr/mapping.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const geometry: PdfPageInfo = { page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }

function annotation(id: string, subtype: string, rect: [number, number, number, number],
  other: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return { id, page: 1, subtype, rect, flags: 0, editable: true, supported: true, ...other }
}

function word(id: string, rect: [number, number, number, number] | null): PdfOcrTextPart {
  return { id, text: `OCR ${id}`, box: null, confidence: null,
    pdf: rect && { rect, quad: [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]] } }
}

async function withPage(run: (env: {
  dom: Window & typeof globalThis
  mount: HTMLElement
  scrollRoot: HTMLElement
  render: (props: Partial<PageProps>) => Promise<void>
  pointer: (target: Element, kind: string, x: number, y: number, other?: MouseEventInit) => Promise<void>
  flush: () => Promise<void>
  setPageVisible(visible: boolean): Promise<void>
  pageLoads(): number
  calls: { annotations: string[]; annotationIntents: string[]; destinations: unknown[]; actions: string[]; errors: string[]; opened: string[]; tileAnnotations: boolean[] }
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="scroll"><div id="mount"></div></div></body></html>',
    { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  let pageVisible = true
  const rect = (width: number, height: number, top = 0) => ({ x: 0, y: top, left: 0, top, right: width, bottom: top + height,
    width, height, toJSON() {} })
  const globals = {
    window: dom, document: dom.document, Element: dom.Element, HTMLElement: dom.HTMLElement,
    MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver,
    HTMLCanvasElement: dom.HTMLCanvasElement,
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const oldBounds = dom.HTMLElement.prototype.getBoundingClientRect
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'scroll') return rect(500, 600) as DOMRect
    if (this.classList.contains('dsh-pdf-page-wrap') || this.classList.contains('dsh-pdf-page')
      || this.classList.contains('dsh-pdf-tile-surface')) return rect(300, 400, pageVisible ? 0 : 5000) as DOMRect
    return oldBounds.call(this)
  }
  const oldContext = dom.HTMLCanvasElement.prototype.getContext
  dom.HTMLCanvasElement.prototype.getContext = function () {
    return { measureText: (text: string) => ({ width: text.length * 10 }), drawImage() {}, save() {}, restore() {},
      beginPath() {}, rect() {}, clip() {} } as unknown as CanvasRenderingContext2D
  } as unknown as typeof oldContext
  const scrollRoot = dom.document.getElementById('scroll')!
  Object.defineProperties(scrollRoot, { clientWidth: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 600 } })
  const links = [
    { id: 'destination', subtype: 'Link', rect: [10, 350, 60, 380], dest: [2, { name: 'Fit' }] },
    { id: 'named', subtype: 'Link', rect: [70, 350, 120, 380], action: 'NextPage' },
    { id: 'url', subtype: 'Link', rect: [130, 350, 180, 380], url: 'https://example.org/manual' },
  ]
  const tileAnnotations: boolean[] = []
  const nativePage = { pageNumber: 1, rotate: 0, getViewport: ({ scale, rotation }: { scale: number; rotation: number }) =>
    new NativeViewport(geometry, scale, rotation),
    getAnnotations: async () => links,
    getTextContent: async () => ({ items: [{ str: 'linked', transform: [1, 0, 0, 1, 10, 350],
      width: 50, height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }],
    styles: { Helvetica: { fontFamily: 'sans-serif', ascent: 0.8, descent: 0.2, vertical: false } }, lang: null }),
    tile: async ({ annotations }: { annotations: boolean }) => {
      tileAnnotations.push(annotations)
      return { width: 300, height: 400 }
    },
  } as unknown as NativePage
  let pageLoadCount = 0
  const pdf = { getPage: async () => { pageLoadCount++; return nativePage } } as unknown as NativeDocument
  const calls = { annotations: [] as string[], annotationIntents: [] as string[], destinations: [] as unknown[], actions: [] as string[],
    errors: [] as string[], opened: [] as string[], tileAnnotations }
  dom.open = ((url?: string | URL) => { calls.opened.push(String(url)); return null }) as typeof dom.open
  const { createRoot } = await import('react-dom/client')
  const mount = dom.document.getElementById('mount')!
  const view = createRoot(mount)
  const baseProps: PageProps = {
    pdf, geometry, scale: 1, rotation: 0, mode: 'text', annotations: [], selection: null, scrollRoot,
    t: key => key, onView() {}, onDestination: value => calls.destinations.push(value),
    onNamedAction: action => calls.actions.push(action), onAnnotation: (id, intent) => {
      calls.annotations.push(id); calls.annotationIntents.push(intent ?? 'select')
    },
    onRegion() {}, onNote() {}, onError: message => calls.errors.push(message),
  }
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
  const render = async (props: Partial<PageProps>) => {
    await act(async () => { view.render(React.createElement(Page, { ...baseProps, ...props })) })
    await flush()
  }
  const pointer = async (target: Element, kind: string, x: number, y: number, other: MouseEventInit = {}) => {
    await act(async () => {
      const event = new dom.MouseEvent(kind, { bubbles: true, cancelable: true, button: 0,
        clientX: x, clientY: y, ...other })
      Object.defineProperty(event, 'pointerId', { value: 7 })
      target.dispatchEvent(event)
    })
  }
  const setPageVisible = async (visible: boolean) => {
    pageVisible = visible
    await act(async () => { scrollRoot.dispatchEvent(new dom.Event('scroll')); await new Promise(resolve => setTimeout(resolve, 0)) })
    await flush()
  }
  try { await run({ dom, mount, scrollRoot, render, pointer, flush, setPageVisible,
    pageLoads: () => pageLoadCount, calls }) }
  finally {
    await act(async () => { view.unmount() })
    dom.HTMLElement.prototype.getBoundingClientRect = oldBounds
    dom.HTMLCanvasElement.prototype.getContext = oldContext
    dom.close()
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

test('page reuses its cached native text layer after leaving and re-entering the viewport', async () => {
  await withPage(async ({ render, setPageVisible, pageLoads, mount }) => {
    await render({ retainTextLayer: true })
    assert.equal(pageLoads(), 1)
    await render({ retainTextLayer: false })
    await setPageVisible(false)
    assert.equal(mount.querySelector('[data-pdf-run]'), null)
    await setPageVisible(true)
    assert.equal(pageLoads(), 1, 'the cached NativePage and links should avoid another native read')
    assert.ok(mount.querySelector('[data-pdf-run]'))
  })
})

test('page renders OCR text, repaired markup, note marker and native keyboard links', async () => {
  await withPage(async ({ mount, render, flush, calls }) => {
    const old = annotation('older', 'Highlight', [20, 350, 100, 370], { color: [1, 0, 0] })
    const changed = { ...old, color: [0, 1, 0] as [number, number, number] }
    const adjoining = annotation('adjoining', 'Highlight', [50, 350, 110, 370])
    const emptyNote = annotation('empty-note', 'Text', [220, 200, 240, 220], { contents: 'Saved note' })
    await render({ annotations: [changed, adjoining, emptyNote], renderedAnnotations: [old, adjoining, emptyNote],
      ocrWords: [word('visible', [150, 100, 180, 120]), word('no-geometry', null)] })
    await flush()
    assert.equal(mount.querySelectorAll('.dsh-pdf-ocr-word').length, 1)
    assert.match(mount.querySelector('.dsh-pdf-ocr-word')?.textContent ?? '', /OCR visible/)
    assert.ok(mount.querySelector('.dsh-pdf-annotation-overlay clipPath rect'))
    assert.ok(mount.querySelector('.dsh-pdf-annotation-overlay clipPath rect[x="218"][y="178"]'),
      'the note icon baked into a native tile must be replaced by the custom marker')
    assert.ok(calls.tileAnnotations.includes(false), 'a clean native tile must repaint the old icon region')
    assert.ok(mount.querySelectorAll('.dsh-pdf-annotation-overlay path').length >= 2)
    const note = mount.querySelector<HTMLButtonElement>('.dsh-pdf-note-marker')!
    assert.ok(note)
    await act(async () => { note.click() })
    assert.deepEqual(calls.annotations, ['empty-note'])
    assert.deepEqual(calls.annotationIntents, ['note'])
    const keyboard = mount.querySelector('.dsh-pdf-keyboard-links')!
    assert.equal(keyboard.querySelectorAll('button').length, 2)
    assert.equal(keyboard.querySelectorAll('a').length, 1)
    await act(async () => { keyboard.querySelectorAll('button')[0]!.click() })
    await act(async () => { keyboard.querySelectorAll('button')[1]!.click() })
    assert.deepEqual(calls.destinations, [[2, { name: 'Fit' }]])
    assert.deepEqual(calls.actions, ['NextPage'])
    assert.deepEqual(calls.errors, [])
  })
})

test('note marker cancels an unfinished drag and persists accessible keyboard movement', async () => {
  await withPage(async ({ mount, render, pointer, flush, dom }) => {
    const moved: Array<{ x: number; y: number }> = []
    const noteAnnotation = annotation('move-note', 'Text', [100, 200, 120, 220], { contents: 'Move me' })
    await render({ annotations: [noteAnnotation], onMoveNoteMarker: async (_id, _page, delta) => {
      moved.push(delta)
      return true
    } })
    const note = mount.querySelector<HTMLButtonElement>('.dsh-pdf-note-marker')!
    const layer = note.parentElement!
    layer.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 400,
      width: 300, height: 400, toJSON() {} }) as DOMRect
    await pointer(note, 'pointerdown', 10, 10)
    await pointer(note, 'pointermove', 25, 18)
    assert.equal(note.dataset.dragging, 'true')
    await pointer(note, 'pointercancel', 25, 18)
    assert.equal(note.dataset.dragging, undefined)
    assert.equal(note.style.transform, '')
    assert.deepEqual(moved, [])
    await act(async () => {
      note.dispatchEvent(new dom.KeyboardEvent('keydown', {
        key: 'ArrowLeft', bubbles: true, cancelable: true,
      }))
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    await flush()
    assert.deepEqual(moved, [{ x: -2, y: 0 }])
  })
})

test('page hover advertises a real PDF link and single-click follows after the double-click window', async () => {
  await withPage(async ({ mount, render, pointer, calls }) => {
    await render({})
    const span = mount.querySelector<HTMLElement>('[data-pdf-run]')!
    assert.ok(span)
    await pointer(span, 'pointerover', 20, 30)
    assert.equal(span.style.cursor, 'pointer')
    await pointer(span, 'pointerdown', 20, 30)
    await pointer(span, 'pointerup', 20, 30)
    assert.equal(calls.destinations.length, 0, 'a click must remain selectable until the double-click window closes')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 530)) })
    assert.deepEqual(calls.destinations, [[2, { name: 'Fit' }]])
    await pointer(span, 'pointerover', 140, 30)
    assert.equal(span.style.cursor, 'pointer')
    await pointer(span, 'pointerdown', 140, 30)
    await pointer(span, 'pointerup', 140, 30)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 530)) })
    assert.deepEqual(calls.opened, ['https://example.org/manual'])
    await pointer(span, 'pointerout', 200, 30)
    assert.equal(span.style.cursor, '')
  })
})

test('page ignores cancelled native reads but reports genuine page and text failures', async () => {
  await withPage(async ({ render, calls }) => {
    const cancellation = (name: string) => Object.assign(new Error('signal is aborted without reason'), { name })
    const document = (getPage: () => Promise<NativePage>) => ({ getPage }) as unknown as NativeDocument
    const page = (getAnnotations: () => Promise<unknown[]>, getTextContent: () => Promise<unknown>) => ({
      pageNumber: 1, rotate: 0,
      getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => new NativeViewport(geometry, scale, rotation),
      getAnnotations, getTextContent,
      tile: async () => ({ width: 300, height: 400 }),
    }) as unknown as NativePage

    await render({ pdf: document(async () => { throw cancellation('AbortError') }), retainTextLayer: true })
    assert.deepEqual(calls.errors, [])

    await render({ pdf: document(async () => { throw new Error('Native page unavailable') }), retainTextLayer: true })
    assert.deepEqual(calls.errors, ['Error: Native page unavailable'])
    calls.errors.length = 0

    await render({ pdf: document(async () => page(
      async () => { throw cancellation('AbortException') },
      async () => { throw cancellation('AbortError') },
    )), retainTextLayer: true })
    assert.deepEqual(calls.errors, [])

    await render({ pdf: document(async () => page(async () => [], async () => { throw new Error('Text unavailable') })),
      retainTextLayer: true })
    assert.deepEqual(calls.errors, ['Error: Text unavailable'])
  })
})

test('page ignores tiles cancelled by an old document but reports live tile failures', async () => {
  await withPage(async ({ render, flush, calls }) => {
    const oldLifetime = new AbortController()
    let started!: () => void
    const tileStarted = new Promise<void>(resolve => { started = resolve })
    const page = (lifetime: AbortController, tile: NativePage['tile']) => ({
      pageNumber: 1, rotate: 0, owner: { lifetime },
      getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => new NativeViewport(geometry, scale, rotation),
      getAnnotations: async () => [],
      getTextContent: async () => ({ items: [], styles: {}, lang: null }),
      tile,
    }) as unknown as NativePage
    const document = (value: NativePage) => ({ getPage: async () => value }) as unknown as NativeDocument
    await render({ pdf: document(page(oldLifetime, () => new Promise((_resolve, reject) => {
      started()
      oldLifetime.signal.addEventListener('abort', () => reject(oldLifetime.signal.reason), { once: true })
    }))) })
    await tileStarted
    oldLifetime.abort()
    await flush()
    assert.deepEqual(calls.errors, [], 'retiring the old document must not show a rendering error')

    const liveLifetime = new AbortController()
    await render({ pdf: document(page(liveLifetime, async () => { throw new Error('Live tile unavailable') })) })
    assert.deepEqual(calls.errors, ['Error: Live tile unavailable'])
  })
})

test('editable AcroForm widgets overlay their page positions and commit text on blur', async () => {
  await withPage(async ({ render, mount }) => {
    const changes: Array<[string, string | boolean | string[]]> = []
    await render({ formFields: [
      { id: 'pdf-field:6:0', name: 'applicant', type: 'text', value: '', widgets: [{ page: 1, rect: [30, 100, 180, 130] }],
        readOnly: false, required: false },
      { name: 'locked', type: 'text', value: 'visible in PDF', widgets: [{ page: 1, rect: [30, 70, 180, 90] }],
        readOnly: true, required: false },
      { name: 'single-list', type: 'option-list', value: ['one'], options: ['one', 'two'], multiple: false,
        widgets: [{ page: 1, rect: [30, 150, 180, 190] }], readOnly: false, required: false },
    ], onFormChange: async (name, value) => { changes.push([name, value]) } })
    const input = mount.querySelector<HTMLInputElement>('.dsh-pdf-form-widgets input[aria-label="applicant"]')
    assert.ok(input)
    assert.equal(input.style.left, '30px')
    assert.equal(input.style.top, '270px')
    assert.equal(mount.querySelector('[aria-label="locked"]'), null)
    assert.equal(mount.querySelector<HTMLSelectElement>('[aria-label="single-list"]')!.multiple, false)
    await act(async () => { input.focus(); input.value = 'Edited'; input.blur() })
    assert.deepEqual(changes, [['pdf-field:6:0', 'Edited']])
  })
})
