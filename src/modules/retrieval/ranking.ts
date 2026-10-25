import { tokenizeRetrievalText, type RetrievalChunk } from './text.js'

export interface RankedChunk {
  chunkId: string
  /** A ranking signal, not a calibrated probability or relevance verdict. */
  score: number
}

export interface Bm25Index {
  readonly lengths: ReadonlyMap<string, number>
  readonly postings: ReadonlyMap<string, ReadonlyMap<string, number>>
  readonly averageLength: number
}

function* buildBm25(chunks: readonly Pick<RetrievalChunk, 'id' | 'text'>[]): Generator<void, Bm25Index> {
  const lengths = new Map<string, number>()
  const postings = new Map<string, Map<string, number>>()
  let totalLength = 0
  for (const chunk of chunks) {
    if (lengths.has(chunk.id)) throw new Error('Duplicate retrieval chunk ID.')
    const tokens = tokenizeRetrievalText(chunk.text)
    lengths.set(chunk.id, tokens.length)
    totalLength += tokens.length
    for (const token of tokens) {
      let posting = postings.get(token)
      if (!posting) postings.set(token, posting = new Map())
      posting.set(chunk.id, (posting.get(chunk.id) ?? 0) + 1)
    }
    yield
  }
  return { lengths, postings, averageLength: totalLength / Math.max(1, chunks.length) }
}

function finish<T>(work: Generator<void, T>): T {
  for (;;) { const next = work.next(); if (next.done) return next.value }
}

async function cooperate<T>(work: Generator<void, T>, batchSize: number, signal?: AbortSignal,
  check?: () => void): Promise<T> {
  signal?.throwIfAborted(); check?.()
  let processed = 0
  for (;;) {
    const next = work.next()
    if (next.done) { signal?.throwIfAborted(); check?.(); return next.value }
    if (++processed % batchSize === 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
      signal?.throwIfAborted(); check?.()
    }
  }
}

/** Synchronous entry points share the exact same scoring steps as Host cooperative execution. */
export function createBm25Index(chunks: readonly Pick<RetrievalChunk, 'id' | 'text'>[]): Bm25Index {
  return finish(buildBm25(chunks))
}

export function createBm25IndexCooperatively(chunks: readonly Pick<RetrievalChunk, 'id' | 'text'>[],
  signal?: AbortSignal, check?: () => void): Promise<Bm25Index> {
  return cooperate(buildBm25(chunks), 64, signal, check)
}

function topRanked(scores: ReadonlyMap<string, number>, limit: number): RankedChunk[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Retrieval limit must be a non-negative integer.')
  return [...scores].map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0))
    .slice(0, limit)
}

/** Okapi BM25 with corpus-wide document frequency and document length normalization. */
function* scoreBm25(index: Bm25Index, query: string, limit: number): Generator<void, RankedChunk[]> {
  const scores = new Map<string, number>()
  const k1 = 1.2
  const b = 0.75
  for (const term of new Set(tokenizeRetrievalText(query))) {
    const posting = index.postings.get(term)
    if (!posting) continue
    const idf = Math.log(1 + (index.lengths.size - posting.size + 0.5) / (posting.size + 0.5))
    for (const [id, frequency] of posting) {
      const length = index.lengths.get(id)!
      const score = idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * length / index.averageLength))
      scores.set(id, (scores.get(id) ?? 0) + score)
      yield
    }
  }
  return topRanked(scores, limit)
}

export function searchBm25(index: Bm25Index, query: string, limit = 30): RankedChunk[] {
  return finish(scoreBm25(index, query, limit))
}

export function searchBm25Cooperatively(index: Bm25Index, query: string, limit = 30,
  signal?: AbortSignal, check?: () => void): Promise<RankedChunk[]> {
  return cooperate(scoreBm25(index, query, limit), 1024, signal, check)
}

export function validateEmbeddingVector(vector: ArrayLike<number>, expectedDimensions?: number): number {
  if (!Number.isSafeInteger(vector.length) || vector.length < 1
    || (expectedDimensions !== undefined && vector.length !== expectedDimensions)) {
    throw new RangeError('Embedding vector dimensions do not match.')
  }
  let nonzero = false
  for (let index = 0; index < vector.length; index++) {
    if (!Number.isFinite(vector[index])) throw new TypeError('Embedding vector contains a non-finite value.')
    nonzero ||= vector[index] !== 0
  }
  if (!nonzero) throw new RangeError('Embedding vector must have a nonzero norm.')
  return vector.length
}

/** Scaling first avoids overflow/underflow for valid finite but unnormalized vectors. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  validateEmbeddingVector(a)
  validateEmbeddingVector(b, a.length)
  let scaleA = 0
  let scaleB = 0
  for (let index = 0; index < a.length; index++) {
    scaleA = Math.max(scaleA, Math.abs(a[index]!))
    scaleB = Math.max(scaleB, Math.abs(b[index]!))
  }
  let product = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index++) {
    const valueA = a[index]! / scaleA
    const valueB = b[index]! / scaleB
    product += valueA * valueB
    normA += valueA * valueA
    normB += valueB * valueB
  }
  return Math.max(-1, Math.min(1, product / Math.sqrt(normA * normB)))
}

function* scoreVectors(query: ArrayLike<number>, vectors: readonly { chunkId: string, vector: ArrayLike<number> }[], limit: number): Generator<void, RankedChunk[]> {
  validateEmbeddingVector(query)
  const scores = new Map<string, number>()
  for (const { chunkId, vector } of vectors) {
    if (scores.has(chunkId)) throw new Error('Duplicate retrieval chunk ID.')
    scores.set(chunkId, cosineSimilarity(query, vector))
    yield
  }
  return topRanked(scores, limit)
}

export function rankVectors(query: ArrayLike<number>, vectors: readonly { chunkId: string, vector: ArrayLike<number> }[], limit = 30): RankedChunk[] {
  return finish(scoreVectors(query, vectors, limit))
}

export function rankVectorsCooperatively(query: ArrayLike<number>, vectors: readonly { chunkId: string, vector: ArrayLike<number> }[],
  limit = 30, signal?: AbortSignal, check?: () => void): Promise<RankedChunk[]> {
  return cooperate(scoreVectors(query, vectors, limit), 32, signal, check)
}

/** Fuse ordinal ranks; lexical and vector score scales must never be added together. */
export function reciprocalRankFusion(rankings: readonly (readonly RankedChunk[])[], limit = 30): RankedChunk[] {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    const seen = new Set<string>()
    for (const { chunkId } of ranking) {
      if (seen.has(chunkId)) continue
      seen.add(chunkId)
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (60 + seen.size))
    }
  }
  return topRanked(scores, limit)
}

/**
 * Preserve branch coverage before truncating RRF: common incidental words must
 * not crowd out cross-language semantic-only hits. Reserve the first semantic
 * hit and first lexical hit, then a second semantic hit if space allows. The
 * rest follows RRF order, as does presentation of the selected candidates.
 * This is a recall safeguard, not a confidence judgment. At limit=1 only the
 * semantic leader can be protected; both branches cannot fit in one slot.
 */
export function hybridCandidates(lexical: readonly RankedChunk[], semantic: readonly RankedChunk[], limit = 30): RankedChunk[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Retrieval limit must be a non-negative integer.')
  if (!limit) return []
  const fused = reciprocalRankFusion([lexical, semantic], lexical.length + semantic.length)
  const semanticIds = [...new Set(semantic.map(hit => hit.chunkId))]
  const selected = new Set<string>()
  for (const id of [semanticIds[0], lexical[0]?.chunkId, semanticIds[1]]) {
    if (selected.size < limit && id !== undefined) selected.add(id)
  }
  for (const hit of fused) {
    if (selected.size >= limit) break
    selected.add(hit.chunkId)
  }
  return fused.filter(hit => selected.has(hit.chunkId))
}
