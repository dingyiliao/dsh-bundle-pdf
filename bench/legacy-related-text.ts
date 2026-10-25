// Frozen pre-index lexical baseline for retrieval-component-v1 comparisons only.
/** Cheap, deterministic candidate generation. The agent judges meaning after reading context. */
const stopWords = new Set(['about', 'after', 'also', 'been', 'does', 'from', 'have', 'into', 'that',
  'their', 'there', 'these', 'this', 'those', 'what', 'when', 'where', 'which', 'with', 'would',
  '关于', '什么', '是否', '有没有', '相关', '内容', '说明', '这里', '这个', '那个'])

function searchTerms(value: string): string[] {
  // Keep Han and Latin runs separate: “PDF里的说明” must not become one
  // impossible-to-match token if the document writes “PDF 中的说明”.
  const words = value.toLocaleLowerCase().match(/[\p{Script=Latin}\p{N}]+|[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []
  return words.flatMap(word => {
    if (stopWords.has(word)) return []
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      if (word.length === 1) return []
      return word.length <= 4 ? [word] : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))
    }
    if (word.length < 3) return []
    return [word.replace(/(?:ing|ed|es|s)$/u, suffix => word.length - suffix.length >= 4 ? '' : suffix)]
  })
}

export interface RelatedTextCandidate {
  startUtf16: number
  endUtf16: number
  quote: string
  matchedTerms: string[]
  /** Uncalibrated lexical ranking signal, never a probability or a relevance verdict. */
  score: number
}

/** Rank short, exact page-text windows; do not paraphrase or infer relevance. */
export function rankRelatedText(text: string, query: string, expansions: readonly string[] = [], limit = 2): RelatedTextCandidate[] {
  const terms = [...new Set([query, ...expansions].flatMap(searchTerms))].slice(0, 24)
  if (!terms.length || !text.trim() || limit <= 0) return []
  const lower = text.toLocaleLowerCase()
  const candidates: RelatedTextCandidate[] = []
  const windowSize = 320
  const stride = 160
  for (let base = 0; base < text.length; base += stride) {
    const end = Math.min(text.length, base + windowSize)
    const window = lower.slice(base, end)
    const matchedTerms = terms.filter(term => window.includes(term))
    if (!matchedTerms.length) continue
    const first = Math.min(...matchedTerms.map(term => window.indexOf(term)))
    const start = Math.max(base, base + first - 32)
    const boundedEnd = Math.min(text.length, start + 240)
    // A returned quote is always an exact substring of the joined page text.
    const raw = text.slice(start, boundedEnd)
    const leading = raw.length - raw.trimStart().length
    const trailing = raw.length - raw.trimEnd().length
    const excerpt = raw.trim()
    if (excerpt.length < 8) continue
    const excerptLower = excerpt.toLocaleLowerCase()
    const actualMatches = terms.filter(term => excerptLower.includes(term))
    if (!actualMatches.length) continue
    const offset = start + leading
    const density = actualMatches.length / Math.max(1, terms.length)
    const spread = Math.max(...actualMatches.map(term => excerptLower.lastIndexOf(term) + term.length))
      - Math.min(...actualMatches.map(term => excerptLower.indexOf(term)))
    const score = actualMatches.length * 100 + Math.round(density * 30) - Math.floor(spread / 30)
    candidates.push({ startUtf16: offset, endUtf16: boundedEnd - trailing, quote: excerpt,
      matchedTerms: actualMatches, score })
    if (end === text.length) break
  }
  return candidates.sort((a, b) => b.score - a.score || a.startUtf16 - b.startUtf16)
    .filter((candidate, index, sorted) => !sorted.slice(0, index).some(prior =>
      Math.max(0, Math.min(prior.endUtf16, candidate.endUtf16) - Math.max(prior.startUtf16, candidate.startUtf16))
        > Math.min(prior.quote.length, candidate.quote.length) / 2))
    .slice(0, limit)
}
