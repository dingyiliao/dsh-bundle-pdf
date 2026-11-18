import { OcrError, type OcrBox, type OcrResult, type OcrTextPart } from './types.js'

export type PdfPoint = readonly [number, number]
export type PdfRect = [number, number, number, number]
/** PDF text markup order: top-left, top-right, bottom-left, bottom-right. */
export type PdfQuad = [number, number, number, number, number, number, number, number]
export type ImageToPdf = (x: number, y: number) => PdfPoint

export function mapImageBoxToPdf(box: OcrBox, transform: ImageToPdf): { rect: PdfRect; quad: PdfQuad } {
  const corners = [
    transform(box.x0, box.y0), transform(box.x1, box.y0),
    transform(box.x0, box.y1), transform(box.x1, box.y1),
  ]
  if (!corners.every((point) => point.length === 2 && point.every(Number.isFinite))) {
    throw new OcrError('invalid-request', 'OCR coordinate transform produced an invalid PDF point.')
  }
  const xs = corners.map(([x]) => x)
  const ys = corners.map(([, y]) => y)
  return {
    rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    quad: corners.flat() as PdfQuad,
  }
}

export interface PdfOcrTextPart extends OcrTextPart {
  pdf: { rect: PdfRect; quad: PdfQuad } | null
}

export function mapResultToPdf(result: OcrResult, transform: ImageToPdf):
  Omit<OcrResult, 'words' | 'lines' | 'blocks'> & { words: PdfOcrTextPart[]; lines: PdfOcrTextPart[]; blocks: PdfOcrTextPart[] } {
  const mapPart = (part: OcrTextPart): PdfOcrTextPart => ({
    ...part, pdf: part.box ? mapImageBoxToPdf(part.box, transform) : null,
  })
  return {
    ...result, words: result.words.map(mapPart), lines: result.lines.map(mapPart), blocks: result.blocks.map(mapPart),
  }
}
