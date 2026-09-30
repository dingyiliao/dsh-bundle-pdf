interface SearchTextItem { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }

const summaryBytes = 1024

function gramHash(text: string, offset: number, length: number): number {
  let hash = Math.imul(length, 0x27d4eb2d) ^ Math.imul(text.charCodeAt(offset), 0x9e3779b1)
  if (length > 1) hash ^= Math.imul(text.charCodeAt(offset + 1), 0x85ebca6b)
  if (length > 2) hash ^= Math.imul(text.charCodeAt(offset + 2), 0xc2b2ae35)
  return hash
}

function setBit(bits: Uint8Array, index: number): void { bits[index >>> 3] |= 1 << (index & 7) }
function hasBit(bits: Uint8Array, index: number): boolean { return (bits[index >>> 3] & (1 << (index & 7))) !== 0 }

function summarize(text: string): Uint8Array {
  const bits = new Uint8Array(summaryBytes)
  for (let offset = 0; offset < text.length; offset++) {
    for (let length = 1; length <= 3 && offset + length <= text.length; length++) {
      const hash = gramHash(text, offset, length)
      const base = length === 1 ? 0 : length === 2 ? 2048 : 4096
      const mask = length === 3 ? 4095 : 2047
      setBit(bits, base + (hash & mask))
      setBit(bits, base + ((hash >>> 12) & mask))
    }
  }
  return bits
}

/** Cache extracted text after a search without retaining page objects or glyph geometry. */
export class SearchTextIndex {
  private readonly pages = new Map<number, string>()
  private readonly summaries = new Map<number, Uint8Array>()
  private units = 0

  constructor(private readonly maxUnits = 4_000_000, private readonly maxSummaries = 16_384) {}

  mayContain(page: number, needle: string): boolean {
    const text = this.pages.get(page)
    if (text !== undefined) {
      this.pages.delete(page)
      this.pages.set(page, text)
      return text.includes(needle)
    }
    const summary = this.summaries.get(page)
    if (!summary || !needle) return true
    const length = Math.min(3, needle.length)
    const base = length === 1 ? 0 : length === 2 ? 2048 : 4096
    const mask = length === 3 ? 4095 : 2047
    for (let offset = 0; offset + length <= needle.length; offset++) {
      const hash = gramHash(needle, offset, length)
      if (!hasBit(summary, base + (hash & mask)) || !hasBit(summary, base + ((hash >>> 12) & mask))) return false
    }
    return true
  }

  remember(page: number, text: string): string {
    const prior = this.pages.get(page)
    if (prior !== undefined) {
      this.pages.delete(page)
      this.units -= prior.length
    }
    const folded = text.toLocaleLowerCase()
    if (!this.summaries.has(page) && this.maxSummaries > 0) {
      if (this.summaries.size >= this.maxSummaries) this.summaries.delete(this.summaries.keys().next().value!)
      this.summaries.set(page, summarize(folded))
    }
    if (folded.length > this.maxUnits) return folded
    while (this.units + folded.length > this.maxUnits) {
      const oldest = this.pages.keys().next().value
      if (oldest === undefined) break
      this.units -= this.pages.get(oldest)!.length
      this.pages.delete(oldest)
    }
    this.pages.set(page, folded)
    this.units += folded.length
    return folded
  }
}

/** Translate an index in lowercased text back to its source UTF-16 offset. */
export function searchOffsetMap(original: string, foldedLength: number): Uint32Array {
  const offsets = new Uint32Array(foldedLength + 1)
  let source = 0, folded = 0
  for (const character of original) {
    const lowerLength = character.toLocaleLowerCase().length
    for (let unit = 0; unit < lowerLength && folded < foldedLength; unit++) offsets[folded++] = source
    source += character.length
  }
  if (folded !== foldedLength) {
    source = 0
    folded = 0
    for (const character of original) {
      const next = source + character.length
      const end = original.slice(0, next).toLocaleLowerCase().length
      while (folded < end && folded < foldedLength) offsets[folded++] = source
      source = next
    }
  }
  offsets[foldedLength] = original.length
  return offsets
}

export function searchItemAtOffset(starts: readonly number[], offset: number): number {
  let low = 0, high = starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (starts[middle] <= offset) low = middle + 1
    else high = middle
  }
  return Math.max(0, low - 1)
}

/** Preserve split words; insert a space only when adjacent positioned runs have a real gap. */
export function joinSearchText(items: readonly SearchTextItem[]): { text: string; starts: number[] } {
  let text = ''
  const starts: number[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index], previous = items[index - 1]
    if (previous) {
      if (previous.hasEOL) text += '\n'
      else if (!/\s$/.test(text) && !/^\s/.test(item.str)) {
        const [a, b, , , x, y] = previous.transform
        const norm = Math.hypot(a, b) || 1
        const dx = item.transform[4] - x, dy = item.transform[5] - y
        const gap = (dx * a + dy * b) / norm - previous.width
        const cross = Math.abs((dx * -b + dy * a) / norm)
        if (gap > Math.max(0.5, previous.height * 0.15) || cross > Math.max(2, previous.height * 0.5)) text += ' '
      }
    }
    starts.push(text.length)
    text += item.str
  }
  return { text, starts }
}

/** Build a display-only excerpt without splitting a supplementary character. */
export function searchResultExcerpt(text: string, matchStart: number, matchLength: number): string {
  let start = Math.max(0, matchStart - 30)
  let end = Math.min(text.length, matchStart + matchLength + 70)
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff
  const low = (code: number) => code >= 0xdc00 && code <= 0xdfff
  if (start > 0 && low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start--
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++

  let result = ''
  let damaged = false
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index)
    if (high(code) && index + 1 < end && low(text.charCodeAt(index + 1))) {
      result += text.slice(index, index + 2)
      index++
      damaged = false
    } else if (code === 0xfffd || high(code) || low(code)) {
      if (!damaged) result += '…'
      damaged = true
    } else {
      result += text[index]
      damaged = false
    }
  }
  return result
}
