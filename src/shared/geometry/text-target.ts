import type { PdfRect } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../native.js'
import { joinPositionedText } from '../page-text.js'

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
  endQuote?: string, requireReadingOrder = true): TextTargetRange {
  const text = joinPositionedText(content.items)
  const start = startQuote === undefined ? text.search(/\S/u) : uniqueOffset(text, startQuote)
  const lastText = text.search(/\s*$/u)
  const endOffset = endQuote === undefined ? lastText : uniqueOffset(text, endQuote) + endQuote.length
  const end = endOffset
  if (start < 0 || end <= start || (endQuote !== undefined && uniqueOffset(text, endQuote) < start)) {
    fail('pdf/invalid-text-range', 'The text range is empty or its end anchor precedes its start anchor')
  }
  return locateTextOffsetRange(content, start, end, requireReadingOrder)
}

function splitsScalar(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset)
  return offset > 0 && offset < text.length && before >= 0xd800 && before <= 0xdbff
    && after >= 0xdc00 && after <= 0xdfff
}

/** Reject obvious column-order ambiguity, without treating ordinary run/word spacing as a column. */
function assertReadingOrder(content: NativeTextContent, starts: readonly number[], start: number, end: number): void {
  let previous: NativeTextContent['items'][number] | undefined
  let gap: { x: number; y: number; ux: number; uy: number; leftEnd: number; rightStart: number; height: number } | undefined
  const ambiguous = () => fail('pdf/ambiguous-reading-order',
    'The selected page text crosses columns or layout regions; use separate precise marks')
  for (const [index, item] of content.items.entries()) {
    if (starts[index]! >= end || starts[index]! + item.str.length <= start || !item.str.trim()) continue
    const [a, b, c, d, x, y] = item.transform
    if (gap) {
      const forward = (x! - gap.x) * gap.ux + (y! - gap.y) * gap.uy
      const cross = Math.abs((x! - gap.x) * -gap.uy + (y! - gap.y) * gap.ux)
      // Line-interleaved two-column extraction can move left→right on one row,
      // then return to the left column below: it never has a large upward jump.
      if (cross > gap.height * 0.5 && forward < gap.rightStart - gap.height * 3
        && forward < gap.leftEnd + gap.height * 2) ambiguous()
    }
    if (previous) {
      const [pa, pb, pc, pd, px, py] = previous.transform
      const lineHeight = Math.max(8, Math.hypot(pc!, pd!), Math.hypot(c!, d!))
      if (y! - py! > lineHeight * 3 && Math.abs(x! - px!) > lineHeight * 3) ambiguous()
      const norm = Math.hypot(pa!, pb!), currentNorm = Math.hypot(a!, b!)
      if (norm > 0 && currentNorm > 0 && Number.isFinite(previous.width) && previous.width > 0) {
        const ux = pa! / norm, uy = pb! / norm
        const forward = (x! - px!) * ux + (y! - py!) * uy
        const cross = Math.abs((x! - px!) * -uy + (y! - py!) * ux)
        const aligned = (a! * ux + b! * uy) / currentNorm > 0.95
        // Compare with the previous run's *end*, not its origin: a normal long
        // line split into several text objects must not look like a wide gap.
        if (aligned && cross < lineHeight * 0.5 && forward - previous.width > lineHeight * 4) {
          gap = { x: px!, y: py!, ux, uy, leftEnd: previous.width, rightStart: forward, height: lineHeight }
        }
      }
    }
    previous = item
  }
}

/** Resolve an attested UTF-16 range, including repeated quotes, against native glyphs only. */
export function locateTextOffsetRange(content: NativeTextContent, start: number,
  end: number, requireReadingOrder = true): TextTargetRange {
  if (content.extraction) fail('pdf/text-geometry-unavailable', 'Derived OCR text cannot certify native PDF glyph geometry')
  const starts: number[] = []
  const text = joinPositionedText(content.items, starts)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0
    || end <= start || end > text.length || splitsScalar(text, start) || splitsScalar(text, end)) {
    fail('pdf/invalid-text-range', 'The text range must span whole Unicode characters inside the extracted page text')
  }
  if (end - start > 8000) fail('pdf/text-range-too-large', 'Text range exceeds 8000 UTF-16 characters; mark it in smaller ranges')
  if (requireReadingOrder) assertReadingOrder(content, starts, start, end)
  const quads: number[] = []
  const xs: number[] = [], ys: number[] = []
  for (let index = 0; index < content.items.length; index++) {
    const item = content.items[index]!
    const runStart = starts[index]!, runEnd = runStart + item.str.length
    if (runStart >= end || runEnd <= start) continue
    const chars = Array.from(item.str)
    // PDFium omits its per-character array for a one-scalar text object. Its
    // native origin and positive width already describe exactly that glyph;
    // never apply this fallback to a multi-character run or malformed array.
    const singleGlyph = item.glyphs === undefined && chars.length === 1
      && item.transform.length >= 6 && [item.transform[4], item.transform[5], item.width].every(Number.isFinite)
      && item.width > 0 ? [[item.transform[4]!, item.transform[5]!, item.width]] : undefined
    const glyphs = item.glyphs?.length === chars.length ? item.glyphs : singleGlyph
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
    if (glyphs.slice(first, last + 1).some(glyph => !glyph.every(Number.isFinite) || glyph[2] <= 0)) {
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
  const { rect, quadPoints } = locateTextRange(content, quote, quote, true)
  return { rect, quadPoints }
}
