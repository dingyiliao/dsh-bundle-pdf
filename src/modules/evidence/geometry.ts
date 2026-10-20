import type { PdfPageInfo, PdfRect } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../../shared/native.js'
import { joinPositionedText } from '../../shared/page-text.js'

/**
 * Best-effort PDF-space boxes for a joined-text range. PDFium provides glyph
 * origins and advances, but not the exact painted outline in this contract.
 * Missing positions, synthetic non-whitespace, or uncalibrated page rotation
 * produce no geometry rather than a plausible-looking wrong highlight.
 */
export function approximateTextRects(content: NativeTextContent, page: PdfPageInfo | undefined,
  startUtf16: number, endUtf16: number): PdfRect[] | null {
  if (!page || page.rotation % 360 !== 0 || !Number.isFinite(page.userUnit) || page.userUnit <= 0
    || !Number.isSafeInteger(startUtf16) || !Number.isSafeInteger(endUtf16)
    || endUtf16 <= startUtf16 || endUtf16 - startUtf16 > 512) return null
  const crop = page.cropBox
  if (crop.length !== 4 || crop.some(value => !Number.isFinite(value))
    || crop[2] <= crop[0] || crop[3] <= crop[1]) return null
  const starts: number[] = []
  const text = joinPositionedText(content.items, starts)
  if (startUtf16 < 0 || endUtf16 > text.length) return null
  const selected = text.slice(startUtf16, endUtf16)
  if (!selected.trim()) return null
  const covered = new Uint8Array(selected.length)
  const rects: PdfRect[] = []
  let selectedGlyphs = 0
  for (const [index, item] of content.items.entries()) {
    const runStart = starts[index]!, runEnd = runStart + item.str.length
    if (runEnd <= startUtf16 || runStart >= endUtf16) continue
    const scalars = Array.from(item.str)
    if (item.glyphs?.length !== scalars.length || !Number.isFinite(item.height) || item.height <= 0
      || item.transform.length < 4) return null
    const [a, b, c, d] = item.transform
    const baselineLength = Math.hypot(a!, b!), heightAxisLength = Math.hypot(c!, d!)
    if (!Number.isFinite(baselineLength) || baselineLength <= 0
      || !Number.isFinite(heightAxisLength) || heightAxisLength <= 0) return null
    const ux = a! / baselineLength, uy = b! / baselineLength
    const vx = c! / heightAxisLength, vy = d! / heightAxisLength
    let position = runStart
    let runRect: PdfRect | null = null
    for (const [glyphIndex, scalar] of scalars.entries()) {
      const glyphEnd = position + scalar.length
      if (glyphEnd > startUtf16 && position < endUtf16) {
        // A half surrogate cannot be associated with one PDF glyph.
        if (position < startUtf16 || glyphEnd > endUtf16) return null
        const glyph = item.glyphs[glyphIndex]!
        const [x, y, advance] = glyph
        if (![x, y, advance].every(Number.isFinite) || advance <= 0) return null
        const points = [
          [x - vx * item.height * 0.2, y - vy * item.height * 0.2],
          [x + ux * advance - vx * item.height * 0.2, y + uy * advance - vy * item.height * 0.2],
          [x + vx * item.height * 0.8, y + vy * item.height * 0.8],
          [x + ux * advance + vx * item.height * 0.8, y + uy * advance + vy * item.height * 0.8],
        ]
        const box: PdfRect = [Math.min(...points.map(point => point[0]!)), Math.min(...points.map(point => point[1]!)),
          Math.max(...points.map(point => point[0]!)), Math.max(...points.map(point => point[1]!))]
        if (box.some(value => !Number.isFinite(value)) || box[0] < crop[0] - 1 || box[1] < crop[1] - 1
          || box[2] > crop[2] + 1 || box[3] > crop[3] + 1) return null
        if (runRect) {
          runRect = [Math.min(runRect[0], box[0]), Math.min(runRect[1], box[1]),
            Math.max(runRect[2], box[2]), Math.max(runRect[3], box[3])]
        } else runRect = box
        selectedGlyphs++
        covered.fill(1, position - startUtf16, glyphEnd - startUtf16)
      }
      position = glyphEnd
    }
    if (runRect) rects.push(runRect)
    if (rects.length > 32) return null
  }
  if (!selectedGlyphs) return null
  for (let index = 0; index < selected.length; index++) {
    if (!covered[index] && !/\s/u.test(selected[index]!)) return null
  }
  return rects
}
