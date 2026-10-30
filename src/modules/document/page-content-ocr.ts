import type { OcrOutput } from '../../ocr/types.js'
import type { PdfPageInfo } from '../../core/pdf-types.js'
import { NativeViewport } from '../../shared/geometry/native-viewport.js'
import type { PageRepresentation } from './page-content.js'

/** Preserve recognized source offsets and convert page pixels to unrotated PDF coordinates once. */
export function ocrPageContentSpans(output: OcrOutput, geometry: PdfPageInfo,
  width: number, height: number): NonNullable<PageRepresentation['spans']> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('OCR content image dimensions must be positive integers.')
  }
  const viewport = new NativeViewport(geometry, 1)
  const spans: NonNullable<PageRepresentation['spans']> = []
  let cursor = 0
  for (const word of output.words) {
    if (!word.text || !word.box) continue
    const start = output.text.indexOf(word.text, cursor)
    if (start < 0) continue
    const box = word.box
    const a = viewport.convertToPdfPoint(box.x0 / width * viewport.width, box.y0 / height * viewport.height)
    const b = viewport.convertToPdfPoint(box.x1 / width * viewport.width, box.y1 / height * viewport.height)
    const rectPdf: [number, number, number, number] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
    if (rectPdf[2] > rectPdf[0] && rectPdf[3] > rectPdf[1]) spans.push({ startUtf16: start, endUtf16: start + word.text.length, rectPdf })
    cursor = start + word.text.length
  }
  return spans
}
