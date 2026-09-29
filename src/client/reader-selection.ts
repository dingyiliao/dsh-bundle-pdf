import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfRect } from '../core/pdf-types.js'

export type PageViewport = ReturnType<PDFPageProxy['getViewport']>
export interface PageView {
  element: HTMLElement
  viewport: PageViewport
  page: PDFPageProxy
}
export interface ReaderSelection {
  revision: number
  text: string
  kind: 'text' | 'region'
  fragments: { page: number; rect: PdfRect; quadPoints: number[] }[]
}

export function unionRects(rects: readonly PdfRect[]): PdfRect {
  return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))]
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

export function overlapFraction(rect: PdfRect, other: PdfRect): number {
  const area = Math.max(0, Math.min(rect[2], other[2]) - Math.max(rect[0], other[0])) * Math.max(0, Math.min(rect[3], other[3]) - Math.max(rect[1], other[1]))
  return area / Math.max(0.00001, (rect[2] - rect[0]) * (rect[3] - rect[1]))
}

/** Collect selected text nodes individually: a container's bounding box would include other columns. */
export function captureTextSelection(container: HTMLElement, views: Map<number, PageView>, revision: number): ReaderSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
  const fragments: ReaderSelection['fragments'] = []
  const selectedText: string[] = []
  for (const [page, view] of [...views].sort(([a], [b]) => a - b)) {
    const layers = [...view.element.querySelectorAll<HTMLElement>('[data-pdf-text="active"]')].filter((layer) => range.intersectsNode(layer))
    if (!layers.length) continue
    const pageBox = view.element.getBoundingClientRect()
    const rects: PdfRect[] = [], quads: number[] = [], text: string[] = []
    for (const layer of layers) {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (!node.textContent || !range.intersectsNode(node)) continue
      const piece = document.createRange()
      piece.selectNodeContents(node)
      if (range.startContainer === node) piece.setStart(node, range.startOffset)
      if (range.endContainer === node) piece.setEnd(node, range.endOffset)
      if (piece.collapsed) continue
      text.push(piece.toString())
      for (const box of piece.getClientRects()) {
        if (box.width < 0.1 || box.height < 0.1) continue
        const left = Math.max(0, box.left - pageBox.left), top = Math.max(0, box.top - pageBox.top)
        const right = Math.min(view.viewport.width, box.right - pageBox.left), bottom = Math.min(view.viewport.height, box.bottom - pageBox.top)
        if (right <= left || bottom <= top) continue
        const converted = viewportRectToPdf(view.viewport, [left, top, right, bottom])
        rects.push(converted.rect)
        quads.push(...converted.quadPoints)
      }
    }
    }
    if (rects.length) {
      fragments.push({ page, rect: unionRects(rects), quadPoints: quads })
      selectedText.push(text.join(''))
    }
  }
  return fragments.length ? { revision, kind: 'text', text: selectedText.join('\n'), fragments } : null
}

export function colorFromHex(value: string): [number, number, number] {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : 'ffff00'
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number]
}

export function colorToHex(value?: readonly number[]): string {
  return '#' + (value ?? [1, 0.85, 0]).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')
}
