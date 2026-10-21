import type { PdfRect } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../../shared/native.js'
import { joinPositionedText } from '../../shared/page-text.js'

export interface TextTargetGeometry { rect: PdfRect; quadPoints: number[] }
export interface TextTargetRange extends TextTargetGeometry {
  startUtf16: number
  endUtf16: number
  text: string
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function uniqueOffset(text: string, quote: string): number {
  const start = text.indexOf(quote)
  if (start < 0) fail('pdf/text-not-found', 'The exact quoted text is not on this page; read the page and copy its wording')
  if (text.indexOf(quote, start + 1) >= 0) {
    fail('pdf/ambiguous-text-target', 'The quote occurs more than once on this page; provide a longer unique quote')
  }
  return start
}

/** Resolve bounded start/end anchors against the same joined text exposed by pdf_read_page. */
export function locateTextRange(content: NativeTextContent, startQuote?: string,
  endQuote?: string, requireReadingOrder = false): TextTargetRange {
  const starts: number[] = []
  const text = joinPositionedText(content.items, starts)
  const start = startQuote === undefined ? text.search(/\S/u) : uniqueOffset(text, startQuote)
  const lastText = text.search(/\s*$/u)
  const endOffset = endQuote === undefined ? lastText : uniqueOffset(text, endQuote) + endQuote.length
  const end = endOffset
  if (start < 0 || end <= start || (endQuote !== undefined && uniqueOffset(text, endQuote) < start)) {
    fail('pdf/invalid-text-range', 'The text range is empty or its end anchor precedes its start anchor')
  }
  if (end - start > 8000) fail('pdf/text-range-too-large', 'Text range exceeds 8000 UTF-16 characters; mark it in smaller ranges')
  if (requireReadingOrder) {
    // A large return to the top at a different x position is characteristic of
    // column or layout reordering. Do not silently mark unrelated intervening text.
    let previous: NativeTextContent['items'][number] | undefined
    for (let index = 0; index < content.items.length; index++) {
      const item = content.items[index]!
      const runStart = starts[index]!, runEnd = runStart + item.str.length
      if (runStart >= end || runEnd <= start || !item.str.trim()) continue
      if (previous) {
        const rise = item.transform[5] - previous.transform[5]
        const shift = Math.abs(item.transform[4] - previous.transform[4])
        const lineHeight = Math.max(8, previous.height, item.height)
        if (rise > lineHeight * 3 && shift > lineHeight * 3) {
          fail('pdf/ambiguous-reading-order', 'The selected page text jumps to another column or layout region; use separate precise marks')
        }
      }
      previous = item
    }
  }
  const quads: number[] = []
  const xs: number[] = [], ys: number[] = []
  for (let index = 0; index < content.items.length; index++) {
    const item = content.items[index]!
    const runStart = starts[index]!, runEnd = runStart + item.str.length
    if (runStart >= end || runEnd <= start) continue
    const chars = Array.from(item.str)
    const glyphs = item.glyphs?.length === chars.length ? item.glyphs
      : chars.length === 1 ? [[item.transform[4], item.transform[5], item.width]] : undefined
    if (!glyphs) fail('pdf/text-geometry-unavailable', 'This PDF page did not provide character positions; no annotation was created')
    const [a, b, c, d] = item.transform
    const axisLength = Math.hypot(a, b), verticalLength = Math.hypot(c, d)
    if (!axisLength || !verticalLength || ![a, b, c, d].every(Number.isFinite)) {
      fail('pdf/text-geometry-unavailable', 'This PDF text has no usable position; no annotation was created')
    }
    const ux = a / axisLength, uy = b / axisLength
    const vx = c / verticalLength, vy = d / verticalLength
    const style = content.styles[item.fontName]
    const ascent = Number.isFinite(style?.ascent) ? style!.ascent : 0.8
    const descent = Number.isFinite(style?.descent) ? style!.descent : -0.2
    // PDFium's `height` field is not necessarily the font's page-space size
    // (the ARM manual reports 1 while its text matrix carries 9.96 pt).
    const height = verticalLength
    let offset = 0
    let first = -1, last = -1
    for (let character = 0; character < chars.length; character++) {
      const next = offset + chars[character]!.length
      if (runStart + offset < end && runStart + next > start) {
        if (first < 0) first = character
        last = character
      }
      offset = next
    }
    if (first < 0) continue
    const initial = glyphs[first]!, final = glyphs[last]!
    if (![...initial, ...final].every(Number.isFinite) || initial[2] <= 0 || final[2] <= 0) {
      fail('pdf/text-geometry-unavailable', 'This PDF text has invalid character positions; no annotation was created')
    }
    const x0 = initial[0], y0 = initial[1]
    const x1 = final[0] + ux * final[2], y1 = final[1] + uy * final[2]
    const top = [x0 + vx * ascent * height, y0 + vy * ascent * height,
      x1 + vx * ascent * height, y1 + vy * ascent * height]
    const bottom = [x0 + vx * descent * height, y0 + vy * descent * height,
      x1 + vx * descent * height, y1 + vy * descent * height]
    const quad = [top[0]!, top[1]!, top[2]!, top[3]!, bottom[0]!, bottom[1]!, bottom[2]!, bottom[3]!]
    quads.push(...quad)
    if (quads.length > 32000) fail('pdf/text-range-too-large', 'Text range has too many positioned glyph runs; mark it in smaller ranges')
    xs.push(quad[0], quad[2], quad[4], quad[6])
    ys.push(quad[1], quad[3], quad[5], quad[7])
  }
  if (!quads.length) fail('pdf/text-geometry-unavailable', 'No positioned glyphs matched the quote; no annotation was created')
  return { rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], quadPoints: quads,
    startUtf16: start, endUtf16: end, text: text.slice(start, end) }
}

/** Resolve an exact, unique quote to PDF-space glyph geometry, never to a guessed page rectangle. */
export function locateTextTarget(content: NativeTextContent, quote: string): TextTargetGeometry {
  const { rect, quadPoints } = locateTextRange(content, quote, quote)
  return { rect, quadPoints }
}
