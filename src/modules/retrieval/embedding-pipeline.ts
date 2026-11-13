import { digest, encodeCachedVector, readCachedVectorRecord, retrievalCacheKey, validVector } from './cache.js'
import { measureIndexOperation, recordIndexPerformance } from './performance.js'
import { buildIndexPageEntries, readIndexPage, type StoredIndexPage, type IndexPageSummary } from './stored-index.js'
import type { RetrievalCache, RetrievalEmbedding } from './types.js'
import type { RetrievalChunk } from './text.js'
import type { SharedRetrievalSource } from './shared-source.js'

type LoadedPage = NonNullable<Awaited<ReturnType<typeof readIndexPage>>>

export interface EmbeddingPipelineIndex {
  persistentKey: string
  generation: string
  provider?: Pick<RetrievalEmbedding, 'dimensions' | 'maxBatchSize' | 'maxInputCharacters'>
  pages: Map<number, IndexPageSummary>
  bytes: number
  computedChunks: number
}

export interface EmbeddingPipelineContext {
  storage: RetrievalCache
  cache?: RetrievalCache
  indexes: Iterable<{ bytes: number }>
  limits: { maxMemoryBytes: number; embeddingBatchesPerStep: number }
  loadPage(index: EmbeddingPipelineIndex, page: number): Promise<LoadedPage | undefined>
  invalidatePage(index: EmbeddingPipelineIndex, page: number): void
  reserve(index: EmbeddingPipelineIndex, bytes: number): void
  summarize(index: EmbeddingPipelineIndex, record: StoredIndexPage, chunks: readonly RetrievalChunk[], embedded: number): void
  phase(index: EmbeddingPipelineIndex, phase: 'restoring' | 'embedding'): void
  notifyProgress(index: EmbeddingPipelineIndex): void
  writeMany(entries: readonly (readonly [string, unknown])[]): Promise<void>
  fail(code: string, message: string): Error
}

/** Compute missing document vectors in bounded cross-page batches. */
export async function embedIndexStep(
  index: EmbeddingPipelineIndex,
  source: SharedRetrievalSource,
  context: EmbeddingPipelineContext,
  deadline = Infinity,
): Promise<void> {
  if (!index.provider) return
  // A live Map iterator is single-use. Snapshot it once so repeated budget
  // checks do not consume it and undercount resident indexes after page one.
  const residentIndexes = [...context.indexes]
  const batchSize = Math.min(16, index.provider.maxBatchSize,
    Math.max(1, Math.floor(Math.max(0, context.limits.maxMemoryBytes - index.bytes) / (index.provider.dimensions * 16))))
  type Frame = LoadedPage & { changed: boolean; computed: number; memoryBytes: number; vectorKeys: Record<string, string> }
  const frames = new Map<number, Frame>()
  const rows = new Map<string, { text: string; targets: Array<{ frame: Frame; chunk: RetrievalChunk }> }>()
  let batches = 0, bytes = 0
  const assign = (frame: Frame, chunk: RetrievalChunk, encoded: StoredIndexPage['vectors'][string], key?: string, computed = false) => {
    frame.record.vectors[chunk.id] = encoded
    if (key) frame.vectorKeys[chunk.id] = key
    else delete frame.vectorKeys[chunk.id]
    frame.changed = true
    if (computed) frame.computed++
  }
  const commit = async () => {
    const changed = [...frames.values()].filter(frame => frame.changed)
    const publications = changed.map(frame => ({ frame,
      ...buildIndexPageEntries(index.persistentKey, index.generation, frame.record, frame.chunks, frame.location, frame.vectorKeys) }))
    await context.writeMany(publications.flatMap(publication => publication.entries))
    source.check()
    for (const { frame, location } of publications) {
      frame.location = location; frame.vectorKeys = Object.create(null)
      context.summarize(index, frame.record, frame.chunks, Object.keys(frame.record.vectors).length)
      index.computedChunks += frame.computed
      frame.changed = false; frame.computed = 0
      if (Object.keys(frame.record.vectors).length === frame.chunks.length) {
        frames.delete(frame.record.page); bytes -= frame.memoryBytes
      }
    }
    context.notifyProgress(index)
  }
  const flush = async () => {
    if (!rows.size) { await commit(); return }
    context.phase(index, 'embedding')
    const batch = [...rows]
    context.reserve(index, bytes + batch.length * index.provider!.dimensions * 8)
    const vectors = await measureIndexOperation('embedding-batch', () => source.embed(batch.map(([, row]) => row.text)), { records: batch.length })
    source.check()
    if (vectors.length !== batch.length || vectors.some(vector => !validVector(vector, index.provider!.dimensions))) {
      throw context.fail('pdf/retrieval-invalid-vector', 'Embedding provider returned invalid vectors')
    }
    const encoded = vectors.map(vector => encodeCachedVector(vector))
    await context.writeMany(batch.map(([key], i) => [key, encoded[i]!] as const))
    source.check()
    for (const [i, [key, row]] of batch.entries()) for (const target of row.targets) assign(target.frame, target.chunk, encoded[i]!, key, true)
    await commit()
    batches++; rows.clear()
  }
  const exhausted = () => batches >= context.limits.embeddingBatchesPerStep || batches > 0 && performance.now() >= deadline
  for (const [page, summary] of index.pages) {
    if (summary.embedded === summary.chunks) continue
    const loaded = await context.loadPage(index, page)
    source.check()
    if (!loaded) {
      context.invalidatePage(index, page)
      throw context.fail('pdf/index-storage-missing', 'A PDF index checkpoint is missing. Resume indexing to repair it.')
    }
    const size = Buffer.byteLength(JSON.stringify(loaded.record)) * 2
      + loaded.chunks.reduce((sum, chunk) => sum + chunk.text.length * 2 + 320, 0)
    const remaining = context.limits.maxMemoryBytes - residentIndexes.reduce((sum, entry) => sum + entry.bytes, 0)
    const windowBytes = Math.min(8 * 1024 * 1024, Math.max(0, remaining - batchSize * index.provider.dimensions * 8))
    if (frames.size && (frames.size >= 16 || bytes + size > windowBytes)) {
      await flush(); frames.clear(); bytes = 0
      if (exhausted()) return
    }
    context.reserve(index, bytes + size)
    const frame: Frame = { ...loaded, changed: false, computed: 0, memoryBytes: size, vectorKeys: Object.create(null) }
    frames.set(page, frame); bytes += size
    context.summarize(index, frame.record, frame.chunks, frame.vectors.size)
    context.phase(index, 'restoring')
    for (const chunk of frame.chunks) {
      if (frame.vectors.has(chunk.id)) continue
      if (exhausted()) { await commit(); return }
      source.check()
      const provider = source.current().provider!
      const modelKey = provider.documentFingerprint ?? (provider.configurationIdentity === undefined ? provider.fingerprint
        : digest(JSON.stringify([provider.fingerprint, provider.configurationIdentity])))
      const key = retrievalCacheKey('vector', modelKey, 'document', digest(chunk.text))
      const equivalent = rows.get(key)
      if (equivalent) { equivalent.targets.push({ frame, chunk }); continue }
      const cached = await readCachedVectorRecord(context.cache ?? context.storage, key, provider.dimensions)
      source.check()
      recordIndexPerformance({ stage: 'vector-cache', durationMs: 0, records: 1, cacheHit: !!cached })
      if (cached) assign(frame, chunk, cached.record, cached.persisted ? key : undefined)
      else rows.set(key, { text: chunk.text, targets: [{ frame, chunk }] })
      if (rows.size === batchSize) await flush()
    }
  }
  await flush()
}

