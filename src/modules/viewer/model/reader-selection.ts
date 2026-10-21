import type { PdfRect } from '../../../core/pdf-types.js'
import { mergeSelectionRects } from './selection-highlight.js'
import type { ReaderPage } from '../ports/reader-document.js'

export type PageViewport = ReturnType<ReaderPage['getViewport']>
export interface PageView {
  element: HTMLElement
  viewport: PageViewport
  page: ReaderPage
}
export interface ReaderSelection {
  revision: number
  text: string
  kind: 'text' | 'region'
  fragments: { page: number; rect: PdfRect; quadPoints: number[] }[]
  selectionBefore?: string
  selectionAfter?: string
}

export function unionRects(rects: readonly PdfRect[]): PdfRect {
  const result: PdfRect = [Infinity, Infinity, -Infinity, -Infinity]
  for (const rect of rects) {
    result[0] = Math.min(result[0], rect[0]); result[1] = Math.min(result[1], rect[1])
    result[2] = Math.max(result[2], rect[2]); result[3] = Math.max(result[3], rect[3])
  }
  return result
}

export function viewportRectToPdf(viewport: PageViewport, rect: PdfRect) {
  const [left, top, right, bottom] = rect
  const points = [viewport.convertToPdfPoint(left, top), viewport.convertToPdfPoint(right, top),
    viewport.convertToPdfPoint(left, bottom), viewport.convertToPdfPoint(right, bottom)]
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
  return { rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as PdfRect, quadPoints: points.flat() }
}

export function pdfRectToViewport(viewport: PageViewport, rect: readonly number[]): PdfRect {
  const first = viewport.convertToViewportPoint(rect[0], rect[1])
  const second = viewport.convertToViewportPoint(rect[2], rect[3])
  return [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])]
}

/** Translate a PDF-space rectangle by a CSS-pixel delta in the current viewport. */
export function translatePdfRectInViewport(viewport: PageViewport, rect: PdfRect, deltaX: number, deltaY: number): PdfRect {
  const [left, top, right, bottom] = pdfRectToViewport(viewport, rect)
  return viewportRectToPdf(viewport, [left + deltaX, top + deltaY, right + deltaX, bottom + deltaY]).rect
}

/** Map a PDF note's bounded rectangle onto the fixed-size marker's travel area. */
export function noteMarkerViewportPosition(viewport: PageViewport, rect: PdfRect, markerSize = 22) {
  const [left, top, right, bottom] = pdfRectToViewport(viewport, rect)
  const rangeX = Math.max(0, viewport.width - (right - left))
  const rangeY = Math.max(0, viewport.height - (bottom - top))
  const markerRangeX = Math.max(0, viewport.width - markerSize)
  const markerRangeY = Math.max(0, viewport.height - markerSize)
  return {
    left: rangeX ? Math.max(0, Math.min(left, rangeX)) * markerRangeX / rangeX : 0,
    top: rangeY ? Math.max(0, Math.min(top, rangeY)) * markerRangeY / rangeY : 0,
  }
}

/** Invert the marker mapping so a dragged marker stays under the pointer even at page edges. */
export function movePdfNoteRectByMarker(viewport: PageViewport, rect: PdfRect, deltaX: number, deltaY: number,
  markerSize = 22): PdfRect {
  const [left, top, right, bottom] = pdfRectToViewport(viewport, rect)
  const position = noteMarkerViewportPosition(viewport, rect, markerSize)
  const rangeX = Math.max(0, viewport.width - (right - left))
  const rangeY = Math.max(0, viewport.height - (bottom - top))
  const markerRangeX = Math.max(0, viewport.width - markerSize)
  const markerRangeY = Math.max(0, viewport.height - markerSize)
  const nextLeft = markerRangeX ? Math.max(0, Math.min(position.left + deltaX, markerRangeX)) * rangeX / markerRangeX : left
  const nextTop = markerRangeY ? Math.max(0, Math.min(position.top + deltaY, markerRangeY)) * rangeY / markerRangeY : top
  return translatePdfRectInViewport(viewport, rect, nextLeft - left, nextTop - top)
}

/** Keep a moved note wholly inside the page while preserving its dimensions. */
export function clampPdfRectToBounds(rect: PdfRect, bounds: PdfRect): PdfRect {
  const width = Math.min(rect[2] - rect[0], bounds[2] - bounds[0])
  const height = Math.min(rect[3] - rect[1], bounds[3] - bounds[1])
  const left = Math.max(bounds[0], Math.min(rect[0], bounds[2] - width))
  const bottom = Math.max(bounds[1], Math.min(rect[1], bounds[3] - height))
  return [left, bottom, left + width, bottom + height]
}

export function overlapFraction(rect: PdfRect, other: PdfRect): number {
  const area = Math.max(0, Math.min(rect[2], other[2]) - Math.max(rect[0], other[0])) * Math.max(0, Math.min(rect[3], other[3]) - Math.max(rect[1], other[1]))
  return area / Math.max(0.00001, (rect[2] - rect[0]) * (rect[3] - rect[1]))
}

function selectionBoundaryContext(range: Range): Pick<ReaderSelection, 'selectionBefore' | 'selectionAfter'> {
  const start = range.startContainer, end = range.endContainer
  if (start.nodeType !== Node.TEXT_NODE || end.nodeType !== Node.TEXT_NODE) return {}
  if (start === end) {
    const text = start.textContent ?? ''
    return {
      selectionBefore: text.slice(Math.max(0, range.startOffset - 80), range.startOffset),
      selectionAfter: text.slice(range.endOffset, range.endOffset + 80),
    }
  }
  // Native PDFium positioning uses one span per glyph. Recover surrounding
  // letters only inside the same PDFium text run, never across unrelated runs.
  const startSpan = start.parentElement?.closest<HTMLElement>('[data-pdf-run]')
  const endSpan = end.parentElement?.closest<HTMLElement>('[data-pdf-run]')
  const layer = startSpan?.closest<HTMLElement>('[data-pdf-text="active"]')
  if (!startSpan || !endSpan || !layer || layer !== endSpan.closest('[data-pdf-text="active"]') ||
      startSpan.dataset.pdfRun !== endSpan.dataset.pdfRun) return {}
  const spans = [...layer.querySelectorAll<HTMLElement>('[data-pdf-run]')]
    .filter(span => span.dataset.pdfRun === startSpan.dataset.pdfRun)
  const first = spans.indexOf(startSpan), last = spans.indexOf(endSpan)
  if (first < 0 || last < first) return {}
  const before = spans.slice(0, first).map(span => span.textContent ?? '').join('') +
    (start.textContent ?? '').slice(0, range.startOffset)
  const after = (end.textContent ?? '').slice(range.endOffset) +
    spans.slice(last + 1).map(span => span.textContent ?? '').join('')
  return { selectionBefore: before.slice(-80), selectionAfter: after.slice(0, 80) }
}

/** Collect selected text nodes individually: a container's bounding box would include other columns. */
export function captureTextSelection(container: HTMLElement, views: Map<number, PageView>, revision: number): ReaderSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
  const fragments: ReaderSelection['fragments'] = []
  const selectedText: string[] = []
  const selectedViews = [...views].filter(([, view]) => range.intersectsNode(view.element)).sort(([a], [b]) => a - b)
  const piece = document.createRange()
  for (const [page, view] of selectedViews) {
    const layers = [...view.element.querySelectorAll<HTMLElement>('[data-pdf-text="active"]')].filter((layer) => range.intersectsNode(layer))
    if (!layers.length) continue
    const pageBox = view.element.getBoundingClientRect()
    const bounds: PdfRect = [Infinity, Infinity, -Infinity, -Infinity]
    const boxes: PdfRect[] = [], text: string[] = []
    for (const layer of layers) {
      // A word selection usually has a text/span ancestor, not the entire page.
      const root = layer.contains(range.commonAncestorContainer) ? range.commonAncestorContainer : layer
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      if (root.nodeType === Node.TEXT_NODE) node = root
      else if (root.contains(range.startContainer)) {
        // Start at the boundary instead of visiting every preceding text span.
        walker.currentNode = range.startContainer
        node = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : walker.nextNode()
      } else node = walker.nextNode()
      while (node) {
        if (range.comparePoint(node, 0) > 0) break
        if (node.textContent && range.intersectsNode(node)) {
          piece.selectNodeContents(node)
          if (range.startContainer === node) piece.setStart(node, range.startOffset)
          if (range.endContainer === node) piece.setEnd(node, range.endOffset)
          if (!piece.collapsed) {
            text.push(piece.toString())
            for (const box of piece.getClientRects()) {
              if (box.width < 0.1 || box.height < 0.1) continue
              const left = Math.max(0, box.left - pageBox.left), top = Math.max(0, box.top - pageBox.top)
              const right = Math.min(view.viewport.width, box.right - pageBox.left), bottom = Math.min(view.viewport.height, box.bottom - pageBox.top)
              if (right <= left || bottom <= top) continue
              boxes.push([left, top, right, bottom])
            }
          }
        }
        if (node === range.endContainer || root.nodeType === Node.TEXT_NODE) break
        node = walker.nextNode()
      }
    }
    // One region per line: PDFium paints each quad separately, so per-glyph quads
    // would multiply into a striped highlight instead of one mark.
    const quads: number[] = []
    for (const box of mergeSelectionRects(boxes)) {
      const converted = viewportRectToPdf(view.viewport, box)
      bounds[0] = Math.min(bounds[0], converted.rect[0]); bounds[1] = Math.min(bounds[1], converted.rect[1])
      bounds[2] = Math.max(bounds[2], converted.rect[2]); bounds[3] = Math.max(bounds[3], converted.rect[3])
      quads.push(...converted.quadPoints)
    }
    if (quads.length) {
      fragments.push({ page, rect: bounds, quadPoints: quads })
      selectedText.push(text.join(''))
    }
  }
  if (!fragments.length) return null
  return {
    revision, kind: 'text', text: selectedText.join('\n'), fragments,
    ...selectionBoundaryContext(range),
  }
}

export function colorFromHex(value: string): [number, number, number] {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : 'ffff00'
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number]
}

export function colorToHex(value?: readonly number[]): string {
  return '#' + (value ?? [1, 0.85, 0]).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')
}
