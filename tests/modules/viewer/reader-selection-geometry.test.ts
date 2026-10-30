import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { captureTextSelection, clampPdfRectToBounds, movePdfNoteRectByMarker, noteMarkerViewportPosition, overlapFraction,
  pdfRectToViewport, translatePdfRectInViewport, viewportRectToPdf } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { PageView, PageViewport } from '../../../src/modules/viewer/model/reader-selection.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close(): void } }
}

function withSelectionDom(html: string, run: (document: Document, select: (range: Range) => ReturnType<typeof captureTextSelection>) => void) {
  const dom = new JSDOM(`<div id="root">${html}</div>`).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, Node: dom.Node, NodeFilter: dom.NodeFilter })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  try {
    const createRange = dom.document.createRange.bind(dom.document)
    dom.document.createRange = () => {
      const range = createRange()
      range.getClientRects = () => [{ left: 10, top: 10, right: 20, bottom: 20, width: 10, height: 10 }] as unknown as DOMRectList
      return range
    }
    const views = new Map<number, PageView>()
    for (const [index, element] of [...dom.document.querySelectorAll<HTMLElement>('[data-test-page]')].entries()) {
      element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100,
        x: 0, y: 0, toJSON() {} })
      views.set(index + 1, { element, viewport: { width: 100, height: 100,
        convertToPdfPoint: (x: number, y: number) => [x, 100 - y] } } as unknown as PageView)
    }
    run(dom.document, (range) => {
      dom.getSelection()!.removeAllRanges()
      dom.getSelection()!.addRange(range)
      return captureTextSelection(dom.document.getElementById('root')!, views, 1)
    })
  } finally {
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const viewport = {
  convertToPdfPoint(x: number, y: number) { return [x + 100, 200 - y] },
  convertToViewportPoint(x: number, y: number) { return [x - 100, 200 - y] },
} as unknown as PageViewport

test('reader geometry preserves all four corners across the viewport/PDF transform', () => {
  const converted = viewportRectToPdf(viewport, [10, 20, 30, 40])
  assert.deepEqual(converted.rect, [110, 160, 130, 180])
  assert.deepEqual(converted.quadPoints, [110, 180, 130, 180, 110, 160, 130, 160])
  assert.deepEqual(pdfRectToViewport(viewport, converted.rect), [10, 20, 30, 40])
  assert.equal(overlapFraction([0, 0, 20, 20], [10, 0, 30, 20]), 0.5)
  assert.equal(overlapFraction([0, 0, 20, 20], [30, 30, 40, 40]), 0)
})

test('note movement follows viewport deltas and stays inside the page bounds', () => {
  const moved = translatePdfRectInViewport(viewport, [110, 160, 130, 180], 8, -6)
  assert.deepEqual(moved, [118, 166, 138, 186])
  assert.deepEqual(clampPdfRectToBounds([-10, 195, 10, 215], [0, 0, 200, 200]), [0, 180, 20, 200])
})

test('a fixed-size note marker reaches every page corner while its PDF rectangle stays inside', () => {
  const page = { ...viewport, width: 300, height: 200 } as PageViewport
  const rect: [number, number, number, number] = [100, 140, 160, 200]
  assert.deepEqual(noteMarkerViewportPosition(page, rect), { left: 0, top: 0 })
  const moved = movePdfNoteRectByMarker(page, rect, 278, 178)
  assert.deepEqual(noteMarkerViewportPosition(page, moved), { left: 278, top: 178 })
  assert.deepEqual(pdfRectToViewport(page, moved), [240, 140, 300, 200])
  assert.deepEqual(noteMarkerViewportPosition(page, movePdfNoteRectByMarker(page, moved, -500, -500)), { left: 0, top: 0 })
})

test('selection context crosses font runs and exposes the omitted final letter without changing the source', () => {
  withSelectionDom('<button>outside before</button><div data-test-page><div data-pdf-text="active">' +
    '<span data-pdf-run="normal">Given this</span><span id="start" data-pdf-run="normal"> reduces a </span>' +
    '<span id="end" data-pdf-run="italic">tensor</span><span data-pdf-run="normal"> to a scalar.</span>' +
    '</div><button>outside after</button></div>', (document, select) => {
    const range = document.createRange()
    range.setStart(document.getElementById('start')!.firstChild!, 0)
    range.setEnd(document.getElementById('end')!.firstChild!, 5)
    const result = select(range)!
    assert.equal(result.text, ' reduces a tenso')
    assert.equal(result.selectionBefore, 'Given this')
    assert.equal(result.selectionAfter, 'r to a scalar.')
  })
})

test('selection context is bounded to 80 original characters in each direction without reading a whole text layer', () => {
  withSelectionDom('<button>outside before</button><div data-test-page><div data-pdf-text="active">' +
    '<span>' + 'a'.repeat(120) + '</span><span id="selected">word</span><span>' + 'b'.repeat(120) + '</span>' +
    '</div><button>outside after</button></div>', (document, select) => {
    const layer = document.querySelector('[data-pdf-text]')!
    Object.defineProperty(layer, 'textContent', { get() { throw new Error('Do not materialize the entire page text') } })
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('selected')!.firstChild!)
    const result = select(range)!
    assert.equal(result.text, 'word')
    assert.equal(result.selectionBefore, 'a'.repeat(80))
    assert.equal(result.selectionAfter, 'b'.repeat(80))
  })
})

test('cross-page context stays in each endpoint text layer and excludes surrounding controls', () => {
  withSelectionDom('<button>control before</button><div data-test-page><div data-pdf-text="active">' +
    '<span>first page </span><span id="start">selection</span></div><button>first control</button></div>' +
    '<div data-test-page><button>second control</button><div data-pdf-text="active">' +
    '<span id="end">continued</span><span> next paragraph</span></div></div><button>control after</button>', (document, select) => {
    const range = document.createRange()
    range.setStart(document.getElementById('start')!.firstChild!, 0)
    range.setEnd(document.getElementById('end')!.firstChild!, 9)
    const result = select(range)!
    assert.equal(result.text, 'selection\ncontinued')
    assert.equal(result.selectionBefore, 'first page ')
    assert.equal(result.selectionAfter, ' next paragraph')
  })
})

test('element selection endpoints remain safe without inventing boundary context', () => {
  withSelectionDom('<div data-test-page><div data-pdf-text="active"><span>selected</span></div></div>', (document, select) => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('[data-pdf-text]')!)
    const result = select(range)!
    assert.equal(result.text, 'selected')
    assert.equal(result.selectionBefore, undefined)
    assert.equal(result.selectionAfter, undefined)
  })
})
