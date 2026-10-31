import type { PdfPageInfo } from '../../../core/pdf-types.js'
import type { NavigationPosition } from '../../../navigation/index.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { NativeDocument } from '../rendering/document.js'
import { pageIndexAtOffset, pageWindowLeft, windowLayout } from '../rendering/window-layout.js'
import { pagePixelToPdfPoint, READING_TOP_INSET, readingPageProbe, readingSafeTop } from '../rendering/page-layout.js'
import { pdfRectToViewport, type PageView } from '../model/reader-selection.js'
import type { PdfViewportSize } from './use-pdf-viewport-size.js'

export interface ReaderViewportState {
  snapshot: WorkspaceSnapshot | null
  scrollRoot: HTMLDivElement | null
  fit: 'custom' | 'width' | 'page'
  zoom: number
  size: PdfViewportSize
  currentPage: number
}

export function readerPageScale(page: PdfPageInfo, state: Pick<ReaderViewportState, 'fit' | 'zoom' | 'size'>,
  fit = state.fit, zoom = state.zoom): number {
  if (fit === 'custom') return zoom
  const rotated = page.rotation % 180 !== 0
  const width = (page.cropBox[2] - page.cropBox[0]) * page.userUnit
  const height = (page.cropBox[3] - page.cropBox[1]) * page.userUnit
  const widthScale = Math.max(0.1, (state.size.width - (state.size.paddingLeft ?? 16) - (state.size.paddingRight ?? 16)) / (rotated ? height : width))
  return fit === 'page' ? Math.min(widthScale,
    Math.max(0.1, (state.size.height - READING_TOP_INSET - 16) / (rotated ? width : height))) : widthScale
}

/** Capture the visible page even before a distant windowed PageView has mounted. */
export function captureReaderPosition(state: ReaderViewportState, views: ReadonlyMap<number, PageView>, notReady: string): NavigationPosition {
  const { snapshot, scrollRoot: root } = state
  if (!snapshot || !root) throw new Error(notReady)
  const outer = root.getBoundingClientRect()
  const visibleTop = outer.top + readingSafeTop(outer.height)
  const visibleLeft = outer.left + (state.size.paddingLeft ?? 0)
  const ordered = [...views.entries()].sort(([a], [b]) => a - b)
  const visible = ([, view]: [number, PageView]) => {
    const box = view.element.getBoundingClientRect()
    return box.bottom > visibleTop && box.top < outer.bottom
  }
  // An explicit destination can be the lower of two visible pages when the
  // browser clamps scrolling at the end. History must retain that page and its
  // viewport anchor instead of silently recording the preceding page.
  const pair = ordered.find(entry => entry[0] === state.currentPage && visible(entry)) ?? ordered.find(visible)
  if (!pair) {
    const numeric = windowLayout(root)
    if (numeric?.length) {
      const preferred = numeric[state.currentPage - 1]
      const item = preferred?.page === state.currentPage
        && preferred.top + preferred.height > root.scrollTop + readingSafeTop(outer.height)
        && preferred.top < root.scrollTop + root.clientHeight ? preferred
        : numeric[pageIndexAtOffset(numeric, root.scrollTop + readingPageProbe(root.clientHeight))]
      const page = snapshot.document.pages[item.page - 1]
      const pageLeft = outer.left + pageWindowLeft(root, item) - root.scrollLeft
      const pageTop = outer.top + item.top - root.scrollTop
      const screenX = Math.max(visibleLeft, pageLeft), screenY = Math.max(visibleTop, pageTop)
      const [x, y] = pagePixelToPdfPoint(page, item.scale, 0, screenX - pageLeft, screenY - pageTop)
      return { documentVersion: snapshot.contentVersion, page: page.page, x, y, fit: state.fit, scale: item.scale,
        viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)),
          y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
    }
    const page = snapshot.document.pages[state.currentPage - 1] ?? snapshot.document.pages[0]!
    return { documentVersion: snapshot.contentVersion, page: page.page,
      x: page.cropBox[0], y: page.cropBox[3], fit: state.fit, scale: readerPageScale(page, state),
      viewportAnchor: { x: 0, y: 0 } }
  }
  const [page, view] = pair
  const box = view.element.getBoundingClientRect()
  const screenX = Math.max(box.left, visibleLeft), screenY = Math.max(box.top, visibleTop)
  const [x, y] = view.viewport.convertToPdfPoint(screenX - box.left, screenY - box.top)
  return { documentVersion: snapshot.contentVersion, page, x, y, scale: view.viewport.scale, fit: state.fit,
    viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)),
      y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
}

/** Resolve PDF destination syntax without initiating a Client navigation. */
export async function resolvePdfDestination(document: NativeDocument, snapshot: WorkspaceSnapshot,
  size: ReaderViewportState['size'], value: unknown, invalidDestination: string): Promise<{ page: number; options: Partial<NavigationPosition> }> {
  const destination = typeof value === 'string' ? await document.getDestination(value) : value
  if (!Array.isArray(destination) || destination.length < 2) throw new Error(invalidDestination)
  const pageIndex = typeof destination[0] === 'number' ? destination[0] : await document.getPageIndex(destination[0])
  const geometry = snapshot.document.pages[pageIndex]
  if (!geometry) throw new Error(invalidDestination)
  const kind = destination[1]?.name
  const options: Partial<NavigationPosition> = {}
  if (kind === 'XYZ') {
    if (typeof destination[2] === 'number') options.x = destination[2]
    if (typeof destination[3] === 'number') options.y = destination[3]
    if (typeof destination[4] === 'number' && destination[4] > 0) { options.scale = destination[4]; options.fit = 'custom' }
  } else if (kind === 'Fit' || kind === 'FitB') options.fit = 'page'
  else if (kind === 'FitH' || kind === 'FitBH') {
    options.fit = 'width'
    if (typeof destination[2] === 'number') options.y = destination[2]
  } else if (kind === 'FitV' || kind === 'FitBV') {
    const page = await document.getPage(pageIndex + 1)
    const base = page.getViewport({ scale: 1, rotation: geometry.rotation })
    options.fit = 'custom'
    options.scale = Math.max(0.1, (size.height - READING_TOP_INSET - 16) / base.height)
    if (typeof destination[2] === 'number') options.x = destination[2]
  } else if (kind === 'FitR') {
    if (![destination[2], destination[3], destination[4], destination[5]].every(Number.isFinite)) throw new Error(invalidDestination)
    const page = await document.getPage(pageIndex + 1)
    const base = page.getViewport({ scale: 1, rotation: geometry.rotation })
    const box = pdfRectToViewport(base, [destination[2], destination[3], destination[4], destination[5]])
    if (box[2] <= box[0] || box[3] <= box[1]) throw new Error(invalidDestination)
    options.fit = 'custom'
    options.scale = Math.max(0.1, Math.min((size.width - (size.paddingLeft ?? 16) - (size.paddingRight ?? 16)) / (box[2] - box[0]),
      (size.height - READING_TOP_INSET - 16) / (box[3] - box[1])))
    const [x, y] = base.convertToPdfPoint(box[0], box[1]); options.x = x; options.y = y
  } else throw new Error(invalidDestination)
  return { page: pageIndex + 1, options }
}
