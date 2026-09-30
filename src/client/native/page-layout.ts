import type { PdfPageInfo } from '../../core/pdf-types.js'

/** Initial window estimate; the mounted window uses the browser's actual label and gap height. */
export const PAGE_CHROME_HEIGHT = 43

export interface PageGeometry {
  page: number
  top: number
  width: number
  height: number
  outerHeight: number
  scale: number
}

export interface PageWindow {
  /** Zero-based first mounted page index. */
  start: number
  /** Zero-based exclusive end of the mounted range. */
  end: number
}

/** Invert PDF.js PageViewport's default (vertically flipped) transform. */
export function pagePixelToPdfPoint(
  page: PdfPageInfo, scale: number, rotation: number, pixelX: number, pixelY: number,
): [number, number] {
  const factor = scale * page.userUnit
  if (!(factor > 0) || !Number.isFinite(factor)) throw new RangeError('Page scale must be positive and finite')
  const [left, bottom, right, top] = page.cropBox
  const angle = ((page.rotation + rotation) % 360 + 360) % 360
  switch (angle) {
    case 0: return [left + pixelX / factor, top - pixelY / factor]
    case 90: return [left + pixelY / factor, bottom + pixelX / factor]
    case 180: return [right - pixelX / factor, bottom + pixelY / factor]
    case 270: return [right - pixelY / factor, top - pixelX / factor]
    default: throw new RangeError('Page rotation must be a multiple of 90 degrees')
  }
}

/** Mirror Page's unloaded PDF viewport size without loading a PDF.js page. */
export function buildPageLayout(
  pages: readonly PdfPageInfo[], getScale: (page: PdfPageInfo) => number, rotation: number,
): PageGeometry[] {
  let top = 0
  return pages.map((geometry) => {
    const scale = getScale(geometry)
    const quarterTurn = ((geometry.rotation + rotation) % 180 + 180) % 180 !== 0
    const baseWidth = (geometry.cropBox[2] - geometry.cropBox[0]) * geometry.userUnit
    const baseHeight = (geometry.cropBox[3] - geometry.cropBox[1]) * geometry.userUnit
    const width = (quarterTurn ? baseHeight : baseWidth) * scale
    const height = (quarterTurn ? baseWidth : baseHeight) * scale
    const outerHeight = height + PAGE_CHROME_HEIGHT
    const result = { page: geometry.page, top, width, height, outerHeight, scale }
    top += outerHeight
    return result
  })
}

/** Binary search the first page whose bottom extends beyond the offset. */
function firstPageEndingAfter(layout: readonly PageGeometry[], offset: number): number {
  let low = 0, high = layout.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (layout[middle]!.top + layout[middle]!.outerHeight <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/** The visible pages and one viewport of overscan on both sides. */
export function windowForViewport(
  layout: readonly PageGeometry[], scrollTop: number, viewportHeight: number,
): PageWindow {
  if (!layout.length) return { start: 0, end: 0 }
  const height = Math.max(1, viewportHeight)
  const top = Math.max(0, scrollTop)
  const start = Math.min(layout.length - 1, firstPageEndingAfter(layout, top - height))
  const end = Math.max(start + 1, Math.min(layout.length, firstPageEndingAfter(layout, top + height * 2) + 1))
  return { start, end }
}
