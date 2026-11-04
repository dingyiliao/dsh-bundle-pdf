export type QuoteMatchMode = 'exact' | 'whitespace-normalized'

function fail(code: string, message: string, details?: object): never {
  throw Object.assign(new Error(message), { code, ...details })
}

function splitsScalar(text: string, offset: number): boolean {
  return text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
}

/** Collapse whitespace runs only; every normalized UTF-16 unit retains its original bounds.
 * No case, punctuation, hyphenation, Unicode composition or semantic folding is performed.
 */
function normalize(text: string) {
  let value = ''
  const starts: number[] = [], ends: number[] = []
  for (let offset = 0; offset < text.length;) {
    const start = offset
    if (/\s/u.test(text[offset]!)) {
      while (offset < text.length && /\s/u.test(text[offset]!)) offset++
      value += ' '
    } else value += text[offset++]!
    starts.push(start)
    ends.push(offset)
  }
  return { value, starts, ends }
}

function unique(text: string, quote: string): number {
  const offset = text.indexOf(quote)
  if (offset >= 0 && text.indexOf(quote, offset + 1) >= 0) {
    fail('pdf/ambiguous-text-target', 'The quote occurs more than once inside this reference; provide a longer unique quote')
  }
  return offset
}

/** Match inside an already attested parent snapshot, never against a wider page/document. */
export function matchEvidenceQuote(text: string, quote: string, mode: QuoteMatchMode = 'exact', refId?: string): {
  startUtf16: number; endUtf16: number
} {
  if (mode !== 'exact' && mode !== 'whitespace-normalized') {
    fail('pdf/invalid-text-range', 'quoteMatch must be exact or whitespace-normalized')
  }
  if (!quote.trim() || quote.length > 8000) fail('pdf/invalid-text-range', 'A reference subquote must contain at most 8000 UTF-16 characters of text')
  let start: number, end: number
  if (mode === 'exact') {
    start = unique(text, quote)
    if (start >= 0) end = start + quote.length
    else {
      const normalized = normalize(text), normalizedQuote = normalize(quote).value
      if (unique(normalized.value, normalizedQuote) >= 0) {
        fail('pdf/quote-whitespace-mismatch', 'The quote differs only in whitespace inside this reference; retry explicitly with quoteMatch="whitespace-normalized"',
          { retryHint: { quoteMatch: 'whitespace-normalized', ...(refId ? { refId } : {}),
            instruction: 'Retry the same quote and parent refId with whitespace-normalized matching; only whitespace runs are collapsed.' } })
      }
      fail('pdf/text-not-found', 'The quote is outside this reference; copy a passage from its snapshot or locate another reference')
    }
  } else {
    const normalized = normalize(text), normalizedQuote = normalize(quote).value
    const offset = unique(normalized.value, normalizedQuote)
    if (offset < 0) fail('pdf/text-not-found', 'The whitespace-normalized quote is outside this reference; wording, case, punctuation and hyphenation must match')
    start = normalized.starts[offset]!
    end = normalized.ends[offset + normalizedQuote.length - 1]!
  }
  if (splitsScalar(text, start) || splitsScalar(text, end)) {
    fail('pdf/invalid-text-range', 'A subquote must span whole Unicode characters')
  }
  return { startUtf16: start, endUtf16: end }
}
