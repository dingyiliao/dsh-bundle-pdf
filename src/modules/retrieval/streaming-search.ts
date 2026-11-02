import { cosineSimilarity, validateEmbeddingVector, type RankedChunk } from './ranking.js'
import { tokenizeRetrievalText, type RetrievalChunk } from './text.js'

/** A page is released after each scan; the producer owns disk and cache policy. */
export interface SearchPage {
  page: number
  chunks: readonly RetrievalChunk[]
  vectors?: ReadonlyMap<string, Float32Array>
}
export interface StoredIndexSearchOptions {
  /** Each call scans the same immutable generation, in ascending page order. */
  pages(): AsyncIterable<SearchPage>
  query: string
  terms: readonly string[]
  mode: 'lexical' | 'semantic' | 'hybrid'
  queryVector?: ArrayLike<number>
  limit: number
  signal: AbortSignal
  check(): void
}
interface Candidate { chunk: RetrievalChunk; score: number; block?: string }

const compare = (a: Candidate, b: Candidate) => b.score - a.score
  || (a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0)

/** Keep a bounded window with room for other logical blocks before alternative
 * representations collapse. Callers oversample the final result count; ordinary
 * ungrouped chunks retain the established global Top-K ordering. */
function candidates(limit: number) {
  const rows: Candidate[] = []
  const blockLimit = Math.max(4, Math.ceil(limit / 4))
  return {
    add(chunk: RetrievalChunk, score: number) {
      const block = chunk.representation ? JSON.stringify([chunk.page, chunk.representation.blockId]) : undefined
      const value = { chunk, score, block }
      if (block !== undefined) {
        let count = 0, worst = -1
        for (let index = 0; index < rows.length; index++) if (rows[index]!.block === block) { count++; worst = index }
        if (count >= blockLimit) {
          if (compare(value, rows[worst]!) >= 0) return
          rows.splice(worst, 1)
        }
      }
      if (rows.length === limit && compare(value, rows[rows.length - 1]!) >= 0) return
      let low = 0, high = rows.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (compare(value, rows[middle]!) < 0) high = middle
        else low = middle + 1
      }
      rows.splice(low, 0, value)
      if (rows.length > limit) rows.pop()
    },
    rows,
  }
}

/** Global BM25 statistics need two bounded scans, never corpus-wide postings.
 * The first scan also ranks available vectors; only winning chunks survive it.
 * The second reuses the exact global statistics to score lexical candidates. */
export async function searchStoredIndex(options: StoredIndexSearchOptions): Promise<{
  lexical: RankedChunk[]; semantic: RankedChunk[]; chunks: RetrievalChunk[]
}> {
  const { signal, limit } = options
  const check = () => { signal.throwIfAborted(); options.check() }
  check()
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 256) throw new RangeError('Stored retrieval candidate limit must be between 0 and 256.')
  if (options.mode !== 'lexical') {
    if (!options.queryVector) throw new RangeError('Semantic retrieval requires a query vector.')
    validateEmbeddingVector(options.queryVector)
  }
  if (!limit) return { lexical: [], semantic: [], chunks: [] }
  const lexical = candidates(limit), semantic = candidates(limit)
  const queryTerms = new Set(options.mode === 'semantic' ? [] : tokenizeRetrievalText([options.query, ...options.terms].join(' ')))
  const documentFrequency = new Map<string, number>()
  let corpusChunks = 0, corpusLength = 0, work = 0
  async function cooperate(): Promise<void> {
    if (++work % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    check()
  }
  function frequencies(tokens: readonly string[]): Map<string, number> {
    const found = new Map<string, number>()
    for (const token of tokens) if (queryTerms.has(token)) found.set(token, (found.get(token) ?? 0) + 1)
    return found
  }
  async function* pages(): AsyncGenerator<SearchPage> {
    let previousPage = 0
    for await (const page of options.pages()) {
      check()
      if (!Number.isSafeInteger(page.page) || page.page <= previousPage) throw new Error('Stored retrieval pages must be in ascending order.')
      previousPage = page.page
      const ids = new Set<string>()
      for (const chunk of page.chunks) {
        if (chunk.page !== page.page || ids.has(chunk.id)) throw new Error('Stored retrieval chunks have invalid page or duplicate identity.')
        ids.add(chunk.id)
      }
      yield page
      check()
    }
    check()
  }
  for await (const page of pages()) {
    for (const chunk of page.chunks) {
      if (options.mode !== 'semantic') {
        const tokens = tokenizeRetrievalText(chunk.text)
        corpusChunks++; corpusLength += tokens.length
        for (const term of frequencies(tokens).keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
      if (options.mode !== 'lexical') {
        const vector = page.vectors?.get(chunk.id)
        if (vector) semantic.add(chunk, cosineSimilarity(options.queryVector!, vector))
      }
      await cooperate()
    }
  }
  if (options.mode !== 'semantic' && queryTerms.size && corpusLength) {
    const averageLength = corpusLength / corpusChunks
    for await (const page of pages()) {
      for (const chunk of page.chunks) {
        const tokens = tokenizeRetrievalText(chunk.text), found = frequencies(tokens)
        let score = 0
        // Preserve query-token order, including floating-point accumulation, so
        // scores and deterministic ties match the established BM25 path.
        for (const term of queryTerms) {
          const frequency = found.get(term)
          if (!frequency) continue
          const df = documentFrequency.get(term)!
          const idf = Math.log(1 + (corpusChunks - df + 0.5) / (df + 0.5))
          score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * tokens.length / averageLength))
        }
        if (found.size) lexical.add(chunk, score)
        await cooperate()
      }
    }
  }
  check()
  const chunks = new Map([...lexical.rows, ...semantic.rows].map(value => [value.chunk.id, value.chunk]))
  const ranks = (rows: readonly Candidate[]) => rows.map(({ chunk, score }) => ({ chunkId: chunk.id, score }))
  return { lexical: ranks(lexical.rows), semantic: ranks(semantic.rows), chunks: [...chunks.values()] }
}
