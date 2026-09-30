import { AnnotationMode } from 'pdfjs-dist'
import type { PdfAnnotation, PdfRect } from '../core/pdf-types.js'
import type { ReaderDocument, ReaderRenderTask } from './reader-document.js'
import { pdfRectToViewport } from './reader-selection.js'
import { annotationPatchBoxes, markupOverlappingPatches, paintMarkupAnnotations, paintNoteMarkers, pendingMarkupAnnotations, staleNativeAnnotations } from './reader-annotations.js'

export interface CapturePdfRegionOptions {
  signal?: AbortSignal
  /** Additional reader rotation, relative to the PDF page's intrinsic rotation. */
  rotation?: number
  /** Pixels per PDF unit before UserUnit; defaults to 2 and cannot exceed 2. */
  scale?: number
  /** Current operation projection and immutable annotations baked into pdf. */
  annotations?: readonly PdfAnnotation[]
  sourceAnnotations?: readonly PdfAnnotation[]
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
 * shared page resources. Native appearances outside edited regions are retained;
 * operation changes are composed over the unannotated page only where needed.
 */
export async function capturePdfRegion(
  pdf: ReaderDocument,
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
  let task: ReaderRenderTask | undefined
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
    if (options.annotations && options.sourceAnnotations) {
      const context = canvas.getContext('2d')!
      const stale = staleNativeAnnotations(options.annotations, options.sourceAnnotations)
      const patchBoxes = stale.flatMap(annotation => annotationPatchBoxes(annotation, viewport))
      if (stale.length) {
        const clean = document.createElement('canvas')
        clean.width = width
        clean.height = height
        const bare = page.render({ canvas: clean, viewport, transform: [1, 0, 0, 1, -left, -top],
          annotationMode: AnnotationMode.DISABLE, background: '#ffffff' })
        const cancelBare = () => bare.cancel()
        signal?.addEventListener('abort', cancelBare, { once: true })
        try {
          await bare.promise
          signal?.throwIfAborted()
          for (const box of patchBoxes) {
            const x = Math.max(left, box[0]), y = Math.max(top, box[1])
            const right = Math.min(left + width, box[2]), bottom = Math.min(top + height, box[3])
            if (right <= x || bottom <= y) continue
            context.drawImage(clean, x - left, y - top, right - x, bottom - y,
              x - left, y - top, right - x, bottom - y)
          }
        } finally {
          signal?.removeEventListener('abort', cancelBare)
          bare.cancel()
          clean.width = 0
          clean.height = 0
        }
      }
      const pending = pendingMarkupAnnotations(options.annotations, options.sourceAnnotations)
      const overlapping = markupOverlappingPatches(options.annotations, pending, patchBoxes, viewport)
      if (overlapping.length) {
        context.save()
        context.beginPath()
        for (const box of patchBoxes) context.rect(box[0] - left, box[1] - top, box[2] - box[0], box[3] - box[1])
        context.clip()
        paintMarkupAnnotations(context, overlapping, viewport, left, top)
        context.restore()
      }
      paintMarkupAnnotations(context, pending, viewport, left, top)
      const sourceIds = new Set(options.sourceAnnotations.map(annotation => annotation.id))
      const repairedIds = new Set(stale.map(annotation => annotation.id))
      const newNotes = options.annotations.filter(annotation => annotation.subtype === 'Text'
        && (!sourceIds.has(annotation.id) || repairedIds.has(annotation.id)))
      const overlappingNotes = options.annotations.filter(annotation => annotation.subtype === 'Text'
        && sourceIds.has(annotation.id) && !repairedIds.has(annotation.id)
        && annotationPatchBoxes(annotation, viewport).some(box => patchBoxes.some(patch =>
          box[0] < patch[2] && box[2] > patch[0] && box[1] < patch[3] && box[3] > patch[1])))
      if (overlappingNotes.length) {
        context.save()
        context.beginPath()
        for (const box of patchBoxes) context.rect(box[0] - left, box[1] - top, box[2] - box[0], box[3] - box[1])
        context.clip()
        paintNoteMarkers(context, overlappingNotes, viewport, left, top)
        context.restore()
      }
      paintNoteMarkers(context, newNotes, viewport, left, top)
    }
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
