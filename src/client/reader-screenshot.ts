import { AnnotationMode, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import type { PdfRect } from '../core/pdf-types.js'
import { pdfRectToViewport } from './reader-selection.js'

export interface CapturePdfRegionOptions {
  signal?: AbortSignal
  /** Additional reader rotation, relative to the PDF page's intrinsic rotation. */
  rotation?: number
  /** Pixels per PDF unit before UserUnit; defaults to 2 and cannot exceed 2. */
  scale?: number
}

export interface PdfRegionScreenshot {
  blob: Blob
  width: number
  height: number
}

const maxPixels = 16_000_000
// Chromium also limits individual canvas dimensions, including very narrow crops.
const maxDimension = 32_767

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The screenshot was cancelled.', 'AbortError')
}

/** Abort a wait without disposing the shared PDF document or its page resources. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) abort()
  })
}

/**
 * Render a PDF-space rectangle directly into a clipped PNG canvas. The supplied
 * document/worker is shared with the reader; this never changes PDF data or frees
 * shared page resources. Native annotation appearances are included.
 */
export async function capturePdfRegion(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  region: PdfRect,
  options: CapturePdfRegionOptions = {},
): Promise<PdfRegionScreenshot> {
  const { signal } = options
  signal?.throwIfAborted()
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
    throw new RangeError('The screenshot page is outside the PDF.')
  }
  if (region.length !== 4 || !region.every(Number.isFinite)) {
    throw new RangeError('The screenshot region must contain four finite coordinates.')
  }
  const extraRotation = options.rotation ?? 0
  const requestedScale = options.scale ?? 2
  if (!Number.isFinite(extraRotation) || extraRotation % 90 !== 0) {
    throw new RangeError('The screenshot rotation must be a multiple of 90 degrees.')
  }
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) {
    throw new RangeError('The screenshot scale must be positive and finite.')
  }

  const page = await abortable(pdf.getPage(pageNumber), signal)
  signal?.throwIfAborted()
  const [viewLeft, viewBottom, viewRight, viewTop] = page.view
  const clipped: PdfRect = [
    Math.max(Math.min(region[0], region[2]), viewLeft),
    Math.max(Math.min(region[1], region[3]), viewBottom),
    Math.min(Math.max(region[0], region[2]), viewRight),
    Math.min(Math.max(region[1], region[3]), viewTop),
  ]
  if (clipped[2] <= clipped[0] || clipped[3] <= clipped[1]) {
    throw new RangeError('The screenshot region does not intersect the page.')
  }
  const rotation = ((page.rotate + extraRotation) % 360 + 360) % 360
  const unitRect = pdfRectToViewport(page.getViewport({ scale: 1, rotation }), clipped)
  const unitWidth = unitRect[2] - unitRect[0]
  const unitHeight = unitRect[3] - unitRect[1]
  if (!(unitWidth > 0 && unitHeight > 0) || !Number.isFinite(unitWidth + unitHeight)) {
    throw new RangeError('The screenshot region has invalid dimensions.')
  }
  let scale = Math.min(2, requestedScale, maxDimension / unitWidth, maxDimension / unitHeight)
  const dimensions = (value: number) => ({
    width: Math.max(1, Math.ceil(unitWidth * value)),
    height: Math.max(1, Math.ceil(unitHeight * value)),
  })
  let { width, height } = dimensions(scale)
  if (width * height > maxPixels) {
    // The integer canvas dimensions, including rounding, must fit the budget.
    let low = 0, high = scale
    for (let index = 0; index < 40; index++) {
      const middle = (low + high) / 2
      const size = dimensions(middle)
      if (size.width * size.height <= maxPixels) low = middle
      else high = middle
    }
    scale = low
    ;({ width, height } = dimensions(scale))
  }

  const viewport = page.getViewport({ scale, rotation })
  const [left, top] = pdfRectToViewport(viewport, clipped)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let task: RenderTask | undefined
  let renderFinished = false
  let cancelled = false
  const cancel = () => {
    if (!cancelled && task && !renderFinished) {
      cancelled = true
      task.cancel()
    }
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    signal?.throwIfAborted()
    task = page.render({
      canvas,
      viewport,
      transform: [1, 0, 0, 1, -left, -top],
      annotationMode: AnnotationMode.ENABLE,
      background: '#ffffff',
    })
    await task.promise
    renderFinished = true
    signal?.throwIfAborted()
    const blob = await abortable(new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result)
        else reject(new Error('The screenshot could not be encoded as PNG.'))
      }, 'image/png')
    }), signal)
    signal?.throwIfAborted()
    return { blob, width, height }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
    canvas.width = 0
    canvas.height = 0
  }
}
