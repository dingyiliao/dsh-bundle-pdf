import type { PdfPageInfo, PdfRect } from '../../core/pdf-types.js'
import { NativeViewport } from '../../shared/geometry/native-viewport.js'

export interface NativeRenderPlan {
  rasterWidth: number
  rasterHeight: number
  x: number
  y: number
  width: number
  height: number
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** Bound a whole page to one native tile while respecting crop, UserUnit and rotation. */
export function pageRenderPlan(geometry: PdfPageInfo, maxEdge: number): NativeRenderPlan {
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 256 || maxEdge > 1024) {
    fail('pdf/invalid-render-size', 'Page render size must be between 256 and 1024 pixels')
  }
  const [left, bottom, right, top] = geometry.cropBox
  let pageWidth = Math.abs(right - left) * geometry.userUnit
  let pageHeight = Math.abs(top - bottom) * geometry.userUnit
  if (Math.abs(geometry.rotation) % 180 === 90) [pageWidth, pageHeight] = [pageHeight, pageWidth]
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
    fail('pdf/invalid-page', 'Page geometry is invalid')
  }
  const factor = maxEdge / Math.max(pageWidth, pageHeight)
  const width = Math.max(1, Math.min(1024, Math.round(pageWidth * factor)))
  const height = Math.max(1, Math.min(1024, Math.round(pageHeight * factor)))
  return { rasterWidth: width, rasterHeight: height, x: 0, y: 0, width, height }
}

/** Compute an OCR tile without transporting a Client-side screenshot to Host. */
export function ocrRegionRenderPlan(geometry: PdfPageInfo, region: readonly number[] | undefined,
  maxEdge: number): NativeRenderPlan & { pdfRegion: PdfRect } {
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 256 || maxEdge > 1024) {
    fail('pdf/invalid-render-size', 'OCR render size must be between 256 and 1024 pixels')
  }
  const [pageLeft, pageBottom, pageRight, pageTop] = geometry.cropBox
  const pdfRegion: PdfRect = region
    ? [Math.max(pageLeft, region[0]), Math.max(pageBottom, region[1]),
      Math.min(pageRight, region[2]), Math.min(pageTop, region[3])]
    : [pageLeft, pageBottom, pageRight, pageTop]
  if (region && (region.length !== 4 || !region.every(Number.isFinite)
    || region[2] <= region[0] || region[3] <= region[1])) {
    fail('pdf/invalid-region', 'OCR region must be a finite, ordered PDF rectangle')
  }
  if (pdfRegion[2] <= pdfRegion[0] || pdfRegion[3] <= pdfRegion[1]) {
    fail('pdf/invalid-region', 'OCR region does not intersect the PDF page')
  }
  const viewport = new NativeViewport(geometry, 1)
  const first = viewport.convertToViewportPoint(pdfRegion[0], pdfRegion[1])
  const second = viewport.convertToViewportPoint(pdfRegion[2], pdfRegion[3])
  const left = Math.min(first[0], second[0]), right = Math.max(first[0], second[0])
  const top = Math.min(first[1], second[1]), bottom = Math.max(first[1], second[1])
  const span = Math.max(right - left, bottom - top)
  if (![viewport.width, viewport.height, left, right, top, bottom, span].every(Number.isFinite)
    || !(viewport.width > 0 && viewport.height > 0 && span > 0)) {
    fail('pdf/invalid-page', 'PDF page geometry is invalid')
  }
  // PDFium allocates the clipped tile, but its virtual raster still has a
  // finite coordinate range. Avoid oversized virtual pages for tiny regions.
  const density = Math.min(4, maxEdge / span, 1_048_575 / viewport.width, 1_048_575 / viewport.height)
  if (!(density > 0)) fail('pdf/invalid-region', 'OCR region cannot be rendered at a usable size')
  const rasterWidth = Math.max(1, Math.ceil(viewport.width * density))
  const rasterHeight = Math.max(1, Math.ceil(viewport.height * density))
  const sx = rasterWidth / viewport.width, sy = rasterHeight / viewport.height
  const x = Math.max(0, Math.floor(left * sx)), y = Math.max(0, Math.floor(top * sy))
  const endX = Math.min(rasterWidth, Math.ceil(right * sx))
  const endY = Math.min(rasterHeight, Math.ceil(bottom * sy))
  const width = endX - x, height = endY - y
  if (width < 1 || height < 1 || width > 1026 || height > 1026) {
    fail('pdf/invalid-region', 'OCR region exceeds the native tile size')
  }
  return { rasterWidth, rasterHeight, x, y, width, height, pdfRegion }
}
