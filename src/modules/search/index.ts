/** A result in the plugin's joined, UTF-16-indexed page text. */
export interface TextMatch { offset: number; endOffset: number; excerpt: string }

/** Preserve complete surrogate pairs at both edges of a short search excerpt. */
export function excerptAround(text: string, offset: number, length: number): string {
  let start = Math.max(0, offset - 70)
  let end = Math.min(text.length, offset + length + 90)
  const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff
  const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
  if (start > 0 && low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start--
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++
  return text.slice(start, end)
}

/** Exact, case-sensitive matching shared by bounded model-read strategies. */
export function findExactInPage(text: string, query: string, offset: number, limit: number): {
  matches: TextMatch[]; nextOffset: number | null
} {
  if (!query || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(limit) || limit < 1) {
    throw Object.assign(new Error('Invalid PDF search window'), { code: 'pdf/invalid-window' })
  }
  const matches: TextMatch[] = []
  let start = offset
  while (matches.length < limit) {
    const found = text.indexOf(query, start)
    if (found < 0) return { matches, nextOffset: null }
    matches.push({ offset: found, endOffset: found + query.length, excerpt: excerptAround(text, found, query.length) })
    start = found + 1
  }
  return { matches, nextOffset: start < text.length ? start : null }
}

/** Normalize whitespace and case while retaining offsets into the original text. */
function normalizeWithOffsets(text: string): { value: string; starts: number[]; ends: number[] } {
  let value = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text) {
    const end = offset + character.length
    const folded = /\s/u.test(character) ? ' ' : character.toLowerCase()
    if (folded === ' ' && value.endsWith(' ')) {
      ends[ends.length - 1] = end
    } else {
      for (const unit of folded) {
        value += unit
        for (let index = 0; index < unit.length; index++) { starts.push(offset); ends.push(end) }
      }
    }
    offset = end
  }
  return { value, starts, ends }
}

/** Case/whitespace-normalized matching with offsets still measured in original UTF-16 units. */
export function findNormalizedInPage(text: string, query: string, offset: number, limit: number): {
  matches: TextMatch[]; nextOffset: number | null
} {
  if (!query || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(limit) || limit < 1) {
    throw Object.assign(new Error('Invalid PDF search window'), { code: 'pdf/invalid-window' })
  }
  const haystack = normalizeWithOffsets(text)
  const needle = normalizeWithOffsets(query).value.trim()
  if (!needle) throw Object.assign(new Error('A normalized query must contain text'), { code: 'pdf/invalid-window' })
  const matches: TextMatch[] = []
  let start = haystack.starts.findIndex(value => value >= offset)
  if (start < 0) return { matches, nextOffset: null }
  while (matches.length < limit) {
    const found = haystack.value.indexOf(needle, start)
    if (found < 0) return { matches, nextOffset: null }
    const sourceStart = haystack.starts[found]!
    const sourceEnd = haystack.ends[found + needle.length - 1]!
    matches.push({ offset: sourceStart, endOffset: sourceEnd,
      excerpt: excerptAround(text, sourceStart, sourceEnd - sourceStart) })
    start = found + 1
    while (start < haystack.starts.length && haystack.starts[start] === sourceStart) start++
  }
  return { matches, nextOffset: start < haystack.value.length ? haystack.starts[start]! : null }
}
