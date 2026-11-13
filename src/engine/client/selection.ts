import type { PdfRect } from '../../core/pdf-types.js'
import { createRectHitIndex } from '../../shared/geometry/rect-hit-index.js'
import type { ReaderSelection } from '../../client/viewer/index.js'
import { translationContextLimit } from '../../translation/types.js'
import type { SelectionGeometryChunk } from '../protocol/selection.js'
import { clipQuad, mergeLineQuads, positionedQuad, quadBounds, quadFrame, type SelectionQuad } from './selection-geometry.js'

/** Native indices identify PDFium characters, not JavaScript string offsets. */
export type SelectionGlyph = Readonly<Omit<SelectionGeometryChunk['glyphs'][number], 'quad'>> & { readonly quad: SelectionQuad | null }

export interface SelectionEndpoint { page: number; offset: number }
export interface SelectionHit extends SelectionEndpoint {
  /** Offset inside the glyph under the pointer, for double click. */
  glyphOffset: number
}
type Fragment = ReaderSelection['fragments'][number]

export interface SelectionPage {
  readonly page: number
  readonly text: string
  readonly hasUnpositionedText: boolean
  hit(x: number, y: number, tolerance?: number): SelectionHit | null
  word(offset: number): readonly [SelectionEndpoint, SelectionEndpoint] | null
  step(offset: number, direction: -1 | 1): SelectionEndpoint
  lineEdge(offset: number, direction: -1 | 1): SelectionEndpoint
  adjacentLine(offset: number, direction: -1 | 1): SelectionEndpoint | null
  fragment(start: number, end: number): Fragment | null
}

type PositionedGlyph = { start: number; end: number; line: number; quad: SelectionQuad | null }
const grapheme = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const visibleText = /[^\s\p{Cf}]/u
const rtlLetter = /(?=\p{Letter})[\p{Script=Arabic}\p{Script=Hebrew}]/u

/** Lower bound in either the grapheme offsets or ordered glyph spans. */
function lowerBound(length: number, before: (index: number) => boolean): number {
  let first = 0, last = length
  while (first < last) {
    const middle = (first + last) >>> 1
    if (before(middle)) first = middle + 1
    else last = middle
  }
  return first
}

function textBoundaries(text: string) {
  // The common Latin case does not need an ICU lookup for each glyph or key.
  if (/^[\x20-\x7e\n]*$/.test(text)) return {
    before: (offset: number) => Math.max(0, Math.min(text.length, Math.floor(offset))),
    after: (offset: number) => Math.max(0, Math.min(text.length, Math.ceil(offset))),
  }
  const offsets = Array.from(grapheme.segment(text), segment => segment.index)
  offsets.push(text.length)
  const indexAt = (offset: number) => Math.min(offsets.length - 1, lowerBound(offsets.length, i => offsets[i] < offset))
  return {
    before(offset: number) {
      const index = indexAt(offset)
      return offsets[index] === offset || index === 0 ? offsets[index] : offsets[index - 1]
    },
    after: (offset: number) => offsets[indexAt(offset)],
  }
}

/** Build once in PDF user coordinates; changing viewport scale keeps this page valid. */
export function createSelectionPage(page: number, glyphs: readonly SelectionGlyph[], cropBox?: readonly number[]): SelectionPage {
  const parts: string[] = []
  const positions: PositionedGlyph[] = []
  const records: { rect: PdfRect; value: PositionedGlyph }[] = []
  let offset = 0
  for (const glyph of glyphs) {
    if (!glyph.text.length) continue
    parts.push(glyph.text)
    const position: PositionedGlyph = { start: offset, end: offset + glyph.text.length, line: glyph.line, quad: positionedQuad(glyph.quad) }
    offset = position.end
    if (position.quad) {
      const rect = quadBounds(position.quad)
      if (cropBox && (rect[0] >= cropBox[2] || rect[2] <= cropBox[0] || rect[1] >= cropBox[3] || rect[3] <= cropBox[1])) {
        position.quad = null
      } else records.push({ rect, value: position })
    }
    positions.push(position)
  }
  const text = parts.join('')
  const boundaries = textBoundaries(text)
  let coveredUntil = 0
  let hasUnpositionedText = false
  for (const { value: glyph } of records) {
    const from = boundaries.before(glyph.start)
    if (from > coveredUntil && visibleText.test(text.slice(coveredUntil, from))) hasUnpositionedText = true
    coveredUntil = Math.max(coveredUntil, boundaries.after(glyph.end))
  }
  hasUnpositionedText ||= visibleText.test(text.slice(coveredUntil))
  // The spatial index avoids walking every glyph on pointer movement.
  const index = createRectHitIndex(records, 32)
  const endpoint = (at: number): SelectionEndpoint => ({ page, offset: at })
  function lineAt(at: number): readonly [number, number] {
    const start = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
    const end = text.indexOf('\n', at)
    return [start, end === -1 ? text.length : end]
  }
  let entirePage: Fragment | null | undefined
  let lastRange: { start: number; end: number; value: Fragment | null } | undefined
  const fragment = (start: number, end: number): Fragment | null => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > text.length
      || boundaries.before(start) !== start || boundaries.after(end) !== end) return null
    const first = lowerBound(positions.length, i => positions[i].end <= start)
    const selected: { line: number; quad: SelectionQuad }[] = []
    let coveredUntil = start
    for (let i = first; i < positions.length; i++) {
      const glyph = positions[i]
      if (glyph.start >= end) break
      if (!glyph.quad) continue
      const from = Math.max(start, boundaries.before(glyph.start))
      if (from > coveredUntil && visibleText.test(text.slice(coveredUntil, from))) return null
      coveredUntil = Math.max(coveredUntil, boundaries.after(glyph.end))
      if (visibleText.test(text.slice(glyph.start, glyph.end))) selected.push({ line: glyph.line, quad: glyph.quad })
    }
    if (coveredUntil < end && visibleText.test(text.slice(coveredUntil, end))) return null
    const quads = mergeLineQuads(selected)
    const rect: PdfRect = [Infinity, Infinity, -Infinity, -Infinity]
    const quadPoints: number[] = []
    for (const original of quads) {
      const quad = cropBox ? clipQuad(original, cropBox) : original
      if (!quad) return null
      const bounds = quadBounds(quad)
      rect[0] = Math.min(rect[0], bounds[0]); rect[1] = Math.min(rect[1], bounds[1])
      rect[2] = Math.max(rect[2], bounds[2]); rect[3] = Math.max(rect[3], bounds[3])
      quadPoints.push(...quad)
    }
    return quadPoints.length ? { page, rect, quadPoints } : null
  }
  return {
    page, text, hasUnpositionedText,
    hit(x, y, tolerance = 0) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(tolerance) || tolerance < 0) return null
      if (cropBox && (x < cropBox[0] || x > cropBox[2] || y < cropBox[1] || y > cropBox[3])) return null
      const candidates = tolerance ? index.intersect([x - tolerance, y - tolerance, x + tolerance, y + tolerance]) : index.at(x, y)
      let result: SelectionHit | null = null, bestOutside = Infinity, bestCenter = Infinity
      for (const glyph of candidates) {
        const frame = quadFrame(glyph.quad!)!
        const [along, across] = frame.project(x, y)
        const outside = Math.hypot(Math.max(0, -along, along - frame.width), Math.max(0, -across, across - frame.height))
        const center = Math.abs(along / frame.width - 0.5) + Math.abs(across / frame.height - 0.5)
        if (outside > tolerance || outside > bestOutside || outside === bestOutside && center >= bestCenter) continue
        const rtl = rtlLetter.test(text.slice(glyph.start, glyph.end))
        const before = (along < frame.width / 2) !== rtl
        result = { ...endpoint(before ? boundaries.before(glyph.start) : boundaries.after(glyph.end)), glyphOffset: glyph.start }
        bestOutside = outside
        bestCenter = center
      }
      return result
    },
    word(at) {
      if (!Number.isInteger(at) || at < 0 || at >= text.length) return null
      const word = words.segment(text).containing(at)
      if (!word?.isWordLike) return null
      return [endpoint(boundaries.before(word.index)), endpoint(boundaries.after(word.index + word.segment.length))]
    },
    step(at, direction) {
      if (!Number.isInteger(at)) return endpoint(0)
      return endpoint(direction < 0 ? boundaries.before(at - 1) : boundaries.after(at + 1))
    },
    lineEdge(at, direction) {
      return endpoint(lineAt(at)[direction < 0 ? 0 : 1])
    },
    adjacentLine(at, direction) {
      const [start, end] = lineAt(at)
      if (direction < 0 ? start === 0 : end === text.length) return null
      const [nextStart, nextEnd] = lineAt(direction < 0 ? start - 1 : end + 1)
      return endpoint(boundaries.before(Math.min(nextEnd, nextStart + at - start)))
    },
    fragment(start, end) {
      // Intermediate pages stay fully selected even when the moving endpoint
      // updates each frame. Reuse the complete shape with the page geometry.
      if (start === 0 && end === text.length) {
        if (entirePage === undefined) entirePage = fragment(start, end)
        return entirePage
      }
      if (lastRange?.start === start && lastRange.end === end) return lastRange.value
      const value = fragment(start, end)
      lastRange = { start, end, value }
      return value
    },
  }
}

function order(anchor: SelectionEndpoint, focus: SelectionEndpoint): readonly [SelectionEndpoint, SelectionEndpoint] {
  return anchor.page < focus.page || anchor.page === focus.page && anchor.offset <= focus.offset ? [anchor, focus] : [focus, anchor]
}

function offsets(start: SelectionEndpoint, end: SelectionEndpoint, page: SelectionPage): readonly [number, number] {
  return [page.page === start.page ? start.offset : 0, page.page === end.page ? end.offset : page.text.length]
}

/** Only visible pages need this geometry while the gesture is moving. */
export function selectionOnPage(anchor: SelectionEndpoint, focus: SelectionEndpoint, page: SelectionPage): Fragment | null {
  const [start, end] = order(anchor, focus)
  return page.page < start.page || page.page > end.page ? null : page.fragment(...offsets(start, end, page))
}

/** Resolve the entire range independently of which pages are mounted. */
export function resolveSelection(anchor: SelectionEndpoint, focus: SelectionEndpoint,
  pageLookup: (page: number) => SelectionPage | undefined, revision: number): ReaderSelection | null {
  const [start, end] = order(anchor, focus)
  if (!Number.isSafeInteger(start.page) || !Number.isSafeInteger(end.page) || start.page < 1) return null
  const fragments: Fragment[] = [], text: string[] = []
  let selectionBefore = '', selectionAfter = ''
  for (let number = start.page; number <= end.page; number++) {
    const page = pageLookup(number)
    // Missing pages must never produce a partial mark or a partial copy.
    if (!page || page.page !== number) return null
    const [from, to] = offsets(start, end, page)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > page.text.length || to < from) return null
    if (number === start.page) selectionBefore = page.text.slice(Math.max(0, from - translationContextLimit), from)
    if (number === end.page) selectionAfter = page.text.slice(to, to + translationContextLimit)
    const selected = page.text.slice(from, to)
    if (!visibleText.test(selected)) continue
    const fragment = page.fragment(from, to)
    if (!fragment) return null
    fragments.push(fragment)
    text.push(selected)
  }
  return fragments.length ? { kind: 'text', revision, fragments, text: text.join('\n'), selectionBefore, selectionAfter } : null
}
