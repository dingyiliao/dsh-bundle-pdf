import { createHash } from 'node:crypto'

/** Changing boundaries or tokenization invalidates the derived lexical index. */
export const RETRIEVAL_TEXT_VERSION = 'page-text-v2-paragraphs'
export const MAX_RETRIEVAL_PARAGRAPH_BREAKS = 10_000

export interface RetrievalChunk {
  id: string
  page: number
  startUtf16: number
  endUtf16: number
  text: string
  pageTextDigest: string
  source: 'pdf-text' | 'ocr'
}

export interface ChunkPageOptions {
  maxCharacters?: number
  overlapCharacters?: number
  /** Exact joined-text offsets where a new positioned paragraph begins. */
  paragraphBreaks?: readonly number[]
}
const cjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u

/** Normalize only the scoring representation; never use its offsets as PDF evidence. */
export function tokenizeRetrievalText(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const runs = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Script=Latin}\p{N}\p{M}]+|[\p{L}\p{N}\p{M}]+/gu) ?? []
  return runs.flatMap(run => {
    if (!cjk.test(run)) return [run]
    const characters = [...run]
    // Unigrams support one-character queries; bigrams retain local word information
    // without requiring a language-specific segmentation dictionary.
    return [...characters, ...characters.slice(1).map((character, index) => characters[index]! + character)]
  })
}

function scalarBoundary(text: string, offset: number): number {
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? offset - 1 : offset
}

export function validParagraphBreaks(text: string, breaks: unknown): breaks is number[] | undefined {
  if (breaks === undefined) return true
  if (!Array.isArray(breaks) || breaks.length > MAX_RETRIEVAL_PARAGRAPH_BREAKS) return false
  let previous = 0
  for (const offset of breaks) {
    if (!Number.isSafeInteger(offset) || offset <= previous || offset >= text.length
      || scalarBoundary(text, offset) !== offset) return false
    previous = offset
  }
  return true
}

function chunkEnd(text: string, start: number, maximumLength: number, paragraphEnd: number): number {
  const maximum = scalarBoundary(text, Math.min(paragraphEnd, start + maximumLength))
  if (maximum === paragraphEnd) return maximum
  const minimum = start + Math.floor(maximumLength / 2)
  // Prefer a real paragraph, then a line, then a word/sentence boundary. This
  // preserves extraction order; text alone cannot safely reconstruct columns.
  for (const boundary of [/\r?\n[\t ]*\r?\n/gu, /\r?\n/gu, /[\s。！？.!?]/gu]) {
    let end = 0
    for (const match of text.slice(minimum, maximum).matchAll(boundary)) end = minimum + match.index + match[0].length
    if (end) return end
  }
  return maximum
}

/** Page-local exact substrings. UTF-16 offsets refer to the unmodified joined page text. */
export function chunkPage(page: number, text: string, source: RetrievalChunk['source'] = 'pdf-text', options: ChunkPageOptions = {}): RetrievalChunk[] {
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('Retrieval pages must be positive integers.')
  if (source !== 'pdf-text' && source !== 'ocr') throw new TypeError('Invalid retrieval text source.')
  const maximumLength = options.maxCharacters ?? 1200
  const overlapLength = options.overlapCharacters ?? Math.min(120, Math.floor(maximumLength / 10))
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 64 || maximumLength > 1200) {
    throw new RangeError('Retrieval chunk length must be between 64 and 1200 characters.')
  }
  if (!Number.isSafeInteger(overlapLength) || overlapLength < 0 || overlapLength >= Math.floor(maximumLength / 2)) {
    throw new RangeError('Retrieval overlap must be smaller than half the chunk length.')
  }
  if (!validParagraphBreaks(text, options.paragraphBreaks)) {
    throw new RangeError('Retrieval paragraph breaks must be bounded, ordered Unicode scalar offsets inside the page text.')
  }
  const pageTextDigest = createHash('sha256').update(text).digest('hex')
  const chunks: RetrievalChunk[] = []
  if (!text.trim()) return chunks
  // A short paragraph remains its own retrieval/evidence unit. The size limit
  // only subdivides oversized paragraphs; it must not merge a short whole page.
  const breaks = new Set(options.paragraphBreaks)
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n/gu)) {
    const offset = match.index + match[0].length
    if (offset < text.length) breaks.add(offset)
  }
  if (breaks.size > MAX_RETRIEVAL_PARAGRAPH_BREAKS) {
    throw Object.assign(new RangeError('PDF contains too many retrieval paragraphs.'), { code: 'pdf/retrieval-budget' })
  }
  const ends = [...breaks].sort((a, b) => a - b).concat(text.length)
  let paragraphStart = 0
  for (const paragraphEnd of ends) {
    for (let start = paragraphStart; start < paragraphEnd;) {
      const end = chunkEnd(text, start, maximumLength, paragraphEnd)
      const raw = text.slice(start, end)
      const content = raw.trim()
      if (content) {
        const startUtf16 = start + raw.length - raw.trimStart().length
        const endUtf16 = end - (raw.length - raw.trimEnd().length)
        const id = createHash('sha256').update(JSON.stringify([
          RETRIEVAL_TEXT_VERSION, page, source, pageTextDigest, startUtf16, endUtf16,
        ])).digest('hex')
        chunks.push({ id, page, startUtf16, endUtf16, text: content, pageTextDigest, source })
      }
      if (end === paragraphEnd) break
      const overlapStart = scalarBoundary(text, end - overlapLength)
      // Overlap belongs to this paragraph only; evidence never absorbs an
      // adjacent heading, paragraph or footer for scoring context.
      const boundary = /\s/u.exec(text.slice(overlapStart, overlapStart + overlapLength / 2))
      start = Math.max(paragraphStart, boundary ? overlapStart + boundary.index + boundary[0].length : overlapStart)
    }
    paragraphStart = paragraphEnd
  }
  return chunks
}
