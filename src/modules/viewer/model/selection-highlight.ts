import type { PdfRect } from '../../../core/pdf-types.js'

/**
 * Typical glyph advance of one line. A per-character DOM box is one glyph wide,
 * so box width predicts the text size better than the line height does.
 */
function medianAdvance(boxes: readonly PdfRect[]): number {
  const widths = boxes.map((box) => box[2] - box[0]).sort((a, b) => a - b)
  return widths[Math.floor(widths.length / 2)] ?? 0
}

function sameLine(box: PdfRect, cluster: PdfRect): boolean {
  const height = box[3] - box[1]
  if (Math.min(cluster[3], box[3]) - Math.max(cluster[1], box[1]) < height * 0.5) return false
  // A heading beside body text, or a footnote marker beside its sentence, must
  // not grow the highlight to the taller box.
  const ratio = height / Math.max(0.00001, cluster[3] - cluster[1])
  return ratio > 0.625 && ratio < 1.6
}

function extend(cluster: PdfRect, box: PdfRect): void {
  cluster[0] = Math.min(cluster[0], box[0])
  cluster[1] = Math.min(cluster[1], box[1])
  cluster[2] = Math.max(cluster[2], box[2])
  cluster[3] = Math.max(cluster[3], box[3])
}

/** Stacked lines of one paragraph read as one region, not as one stripe per line. */
function joinClusters(clusters: PdfRect[]): PdfRect[] {
  const joined: PdfRect[] = []
  for (const cluster of clusters.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const previous = joined.at(-1)
    if (!previous) { joined.push(cluster); continue }
    const overlap = Math.min(previous[2], cluster[2]) - Math.max(previous[0], cluster[0])
    const shorter = Math.min(previous[2] - previous[0], cluster[2] - cluster[0])
    if (overlap >= shorter * 0.5 && cluster[1] - previous[3] <= (previous[3] - previous[1]) * 0.45) extend(previous, cluster)
    else joined.push(cluster)
  }
  return joined
}

/**
 * How wide a gap between two glyph boxes may be before it stops being a rendering
 * seam. A renderer returns one box per glyph, and its rounding can leave a
 * fractional gap between two glyphs that touch in the PDF; a gap up to 60% of the
 * glyph advance is too small to be a column gutter, an indent or a word break.
 */
function selectionBoxTolerance(boxes: readonly PdfRect[]): number {
  const measurable = boxes.filter((box) => box[2] > box[0] && box[3] > box[1])
  if (!measurable.length) return 2
  const shortest = Math.min(...measurable.map((box) => box[3] - box[1]))
  return Math.max(2, Math.min(medianAdvance(measurable), shortest) * 0.6)
}

/**
 * Merge adjacent glyph selection boxes without joining separate lines, columns or
 * text sizes.
 *
 * Closing every gap narrower than the tolerance removes the seams that make one
 * word look like a row of separate character boxes, while a column gutter, a word
 * break or a different line stays wide enough, or tall enough, to remain separate.
 */
export function mergeSelectionRects(rects: readonly PdfRect[]): PdfRect[] {
  const boxes = rects.filter((box) => box[2] > box[0] && box[3] > box[1])
  const tolerance = selectionBoxTolerance(boxes)
  const clusters: PdfRect[] = []
  for (const box of boxes) {
    const current = clusters.at(-1)
    if (current && box[0] - current[2] <= tolerance && sameLine(box, current)) extend(current, box)
    else clusters.push([...box])
  }
  return joinClusters(clusters)
}

/** Read only text selected on this page; a parent range box may cover other columns. */
export function selectedTextRects(host: HTMLElement, page: HTMLElement): PdfRect[] {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return []
  const range = selection.getRangeAt(0)
  if (!range.intersectsNode(host)) return []
  const pageBox = page.getBoundingClientRect()
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const piece = document.createRange()
  const rects: PdfRect[] = []
  let node: Node | null
  if (host.contains(range.startContainer)) {
    walker.currentNode = range.startContainer
    node = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : walker.nextNode()
  } else node = walker.nextNode()
  while (node) {
    if (range.comparePoint(node, 0) > 0) break
    if (node.textContent && range.intersectsNode(node)) {
      piece.selectNodeContents(node)
      if (range.startContainer === node) piece.setStart(node, range.startOffset)
      if (range.endContainer === node) piece.setEnd(node, range.endOffset)
      if (!piece.collapsed) for (const box of piece.getClientRects()) {
        if (box.width < 0.1 || box.height < 0.1) continue
        const left = Math.max(0, box.left - pageBox.left)
        const top = Math.max(0, box.top - pageBox.top)
        const right = Math.min(pageBox.width, box.right - pageBox.left)
        const bottom = Math.min(pageBox.height, box.bottom - pageBox.top)
        if (right > left && bottom > top) rects.push([left, top, right, bottom])
      }
    }
    if (node === range.endContainer) break
    node = walker.nextNode()
  }
  return mergeSelectionRects(rects)
}
