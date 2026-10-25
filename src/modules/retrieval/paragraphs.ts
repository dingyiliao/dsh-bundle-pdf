import type { NativeTextContent } from '../../shared/native.js'
import { joinPositionedText } from '../../shared/page-text.js'

type TextItem = NativeTextContent['items'][number]
interface LineStep { offset: number; advance: number; height: number; sizeRatio: number }
type Position = NonNullable<ReturnType<typeof positioned>>
interface PositionedLine { offset: number; position?: Position }

function positioned(item: TextItem) {
  const [a, b, , , x, y] = item.transform
  const scale = Math.hypot(a, b)
  const height = Math.max(scale, item.height)
  if (![a, b, x, y, height].every(Number.isFinite) || scale <= 0 || height <= 0) return
  return { ux: a / scale, uy: b / scale, x, y, height }
}

function linePosition(items: readonly TextItem[], start: number, end: number): Position | undefined {
  const sizes = new Map<number, { weight: number; position: Position; representativeWeight: number }>()
  let totalWeight = 0
  for (let index = start; index < end; index++) {
    const item = items[index]
    // An item containing multiple lines has no known final baseline.
    if (/[\r\n]/u.test(item.str)) return
    const weight = item.str.trim().length
    if (!weight) continue
    const position = positioned(item)
    if (!position) return
    const size = sizes.get(position.height)
    if (size) {
      size.weight += weight
      if (weight > size.representativeWeight) {
        size.position = position; size.representativeWeight = weight
      }
    } else sizes.set(position.height, { weight, position, representativeWeight: weight })
    totalWeight += weight
  }
  // A character-weighted median keeps a short superscript/prefix from becoming
  // the typography or baseline of an otherwise ordinary wrapped body line.
  let cumulative = 0
  for (const [, size] of [...sizes].sort(([a], [b]) => a - b)) {
    cumulative += size.weight
    if (cumulative >= totalWeight / 2) return size.position
  }
}

/**
 * Preserve native extraction order and exact joined-text offsets. Only obvious
 * layout gaps/font changes add boundaries; ordinary wrapped lines remain one
 * paragraph. These are retrieval units, never certified reading-order geometry.
 */
export function retrievalPageText(items: readonly TextItem[]): { text: string; paragraphBreaks: number[] } {
  const starts: number[] = []
  const text = joinPositionedText(items, starts)
  const lines: PositionedLine[] = []
  let lineStart = 0
  for (let index = 0; index < items.length; index++) {
    if (!items[index].hasEOL && index < items.length - 1) continue
    lines.push({ offset: starts[lineStart], position: linePosition(items, lineStart, index + 1) })
    lineStart = index + 1
  }
  const steps: LineStep[] = []
  for (let index = 1; index < lines.length; index++) {
    const before = lines[index - 1].position, after = lines[index].position
    if (!before || !after || before.ux * after.ux + before.uy * after.uy < 0.99) continue
    const dx = after.x - before.x, dy = after.y - before.y
    const advance = dx * before.uy - dy * before.ux
    const along = dx * before.ux + dy * before.uy
    const height = Math.max(before.height, after.height)
    // Same-baseline EOLs with a lateral jump can represent interleaved columns.
    // Keep their original broad range for the existing geometry ambiguity guard.
    if (Math.abs(advance) < height * 0.5 && Math.abs(along) > height * 2) {
      return { text, paragraphBreaks: [] }
    }
    // Never reinterpret upward column jumps, same-line runs or orientation changes.
    if (advance < height * 0.5) continue
    steps.push({ offset: lines[index].offset, advance, height,
      sizeRatio: Math.max(before.height, after.height) / Math.min(before.height, after.height) })
  }
  // Estimate ordinary leading from the page, so double-spaced wrapped text does
  // not become one embedding per visual line. Cap the estimate: uniformly huge
  // gaps (e.g. one-line paragraphs) are not evidence of huge normal line leading.
  const leading = steps.filter(step => step.sizeRatio < 1.25)
    .map(step => step.advance / step.height).sort((a, b) => a - b)
  const typicalLeading = Math.min(2, leading[Math.floor((leading.length - 1) / 2)] ?? 1.2)
  const paragraphBreaks = steps.filter(step => step.sizeRatio >= 1.25
    || step.advance > step.height * Math.max(2, typicalLeading * 1.5)).map(step => step.offset)
  return { text, paragraphBreaks }
}
