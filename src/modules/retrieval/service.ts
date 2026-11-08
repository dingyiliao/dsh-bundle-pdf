import { measureIndexOperation, recordIndexPerformance } from './performance.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fatalContentError, pageContentCacheIdentity } from '../document/index.js'
import { cacheDerived, digest, encodeCachedVector, pageCacheKey, pageCacheSourceKey, readCachedPage,
  readCachedVectorRecord, readPageCacheSource, retrievalCacheKey, validVector, validateRetrievalPage,
  MAX_PAGE_CACHE_SOURCE_PAGES, RETRIEVAL_EXTRACTION_VERSION, type PageCacheSource } from './cache.js'
import { chunkRetrievalPage, RETRIEVAL_TEXT_VERSION, tokenizeRetrievalText, type RetrievalChunk } from './text.js'
import { collapseRepresentations, hybridCandidates } from './ranking.js'
import { encodeRetrievalCursor, parseRetrievalCursor, retrievalPrepareSchema, retrievalQuerySchema,
  type RetrievalPrepareScope, type RetrievalQuery } from './request.js'
import { searchStoredIndex, type SearchPage } from './streaming-search.js'
import { openIndexHead, promoteIndexHead } from './index-head.js'
import { buildIndexPageEntries, createVolatileIndexStore, readIndexPage, readIndexSummary,
  summarizeIndexPage, type StoredIndexHead, type StoredIndexPage, type IndexPageSummary } from './stored-index.js'
import { createSharedRetrievalSource, type RetrievalBinding, type SharedRetrievalSource } from './shared-source.js'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalInput, RetrievalPorts, RetrievalPrepareInput, RetrievalProgress, RetrievalResult, RetrievalService } from './types.js'

const pageFailureSchema = z.object({ code: z.string().min(1).max(100) }).strict()
interface Index {
  key: string; contentDigest: string; sourcePath?: string; pageCount: number; fromPage: number; toPage: number
  generation: string; provider?: Pick<RetrievalEmbedding, 'dimensions' | 'maxBatchSize' | 'maxInputCharacters'>; selectionIdentity: string; extractionIdentity: string
  persistentKey: string; head: StoredIndexHead; pages: Map<number, IndexPageSummary>; nextPage: number
  chunkCount: number; embeddedCount: number; dataRevision: number
  failures: Map<number, { page: number; attempts: number; code: string }>
  bytes: number; lastUsed: number; users: number
  phase: NonNullable<RetrievalProgress['phase']>; computedChunks: number
  previousPageCacheSource?: PageCacheSource; pageCacheSourceRecorded?: boolean
  progress: Set<() => void>
  release(): void
}
interface PreparationPass {
  key: string; generation: string; sessionId: string; documentId: string
  nextPage: number; nextRetryPage: number
}
interface Job {
  controller: AbortController; promise: Promise<void>; subscribers: Set<RetrievalBinding>
  retrying: boolean; pass?: PreparationPass
}
interface SessionLifetime { valid: boolean; id: string }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
const cancelled = () => fail('pdf/cancelled', 'PDF retrieval was cancelled')
const stale = (message = 'PDF search snapshot is no longer current; start a new search with documentId and query') =>
  fail('pdf/stale-reader', message)
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error
  && typeof error.code === 'string' ? error.code.slice(0, 100) : 'pdf/retrieval-extraction-failed'
const isContentDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const samePageDigests = (a: RetrievalDocument['indexPageDigests'], b: RetrievalDocument['indexPageDigests']) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]))
const sameDocument = (a: RetrievalDocument, b: RetrievalDocument) => a.id === b.id && a.path === b.path
  && a.sourceDigest === b.sourceDigest && a.contentVersion === b.contentVersion && a.pageCount === b.pageCount
  && a.indexContentDigest === b.indexContentDigest && samePageDigests(a.indexPageDigests, b.indexPageDigests)
const indexContentDigest = (document: RetrievalDocument) => document.indexContentDigest ?? document.sourceDigest
const providerIdentity = (provider: RetrievalEmbedding | undefined) => provider
  ? JSON.stringify([provider.fingerprint, provider.generation ?? '', provider.configurationIdentity ?? '',
    provider.dimensions, provider.maxBatchSize, provider.maxInputCharacters ?? null,
    ...(provider.documentFingerprint === undefined ? [] : [provider.documentFingerprint])]) : 'none'
const invalidDocumentIdentity = (provider: RetrievalEmbedding) => provider.documentFingerprint !== undefined
  && (typeof provider.documentFingerprint !== 'string' || !provider.documentFingerprint || provider.documentFingerprint.length > 512)

/** A bounded index owns derived text only; working-copy access and pinning belong to its caller. */
export function createRetrievalService(ports: RetrievalPorts): RetrievalService {
  const limits = { pagesPerStep: 20, embeddingBatchesPerStep: 4, maxChunks: 20000, maxIndexes: 8,
    maxMemoryBytes: 64 * 1024 * 1024, maxConcurrentJobs: 2, maxConcurrentQueries: 8, ...ports.limits }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid retrieval budget')
  const storage = ports.cache ?? createVolatileIndexStore(limits.maxMemoryBytes)
  const indexes = new Map<string, Index>()
  const jobs = new Map<string, Job>()
  const queries = new Map<AbortController, string>()
  const preparations = new Map<AbortController, string>()
  const preparationPasses = new WeakMap<object, PreparationPass>()
  const pendingQueries = new Set<Promise<void>>()
  const sessions = new Map<string, SessionLifetime>()
  // Weak result fences retain identity only, not the heavy index. Adapters can
  // revalidate after minting refs even if an idle index has since been evicted.
  const results = new WeakMap<RetrievalResult, {
    sessionId: string; lifetime: SessionLifetime; document: RetrievalDocument; selectionIdentity: string; extractionIdentity: string
    indexExtractionIdentity?: string
  }>()
  let disposed = false
  let rebuilding: Promise<void> | undefined
  let rebuildFailed = false

  /** Capacity waits follow actual completion, without timers or rejected promises escaping. */
  function waitForWork(work: readonly Promise<void>[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!work.length) throw fail('pdf/retrieval-busy', 'PDF indexing capacity is unavailable; retry shortly')
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        signal.removeEventListener('abort', abort)
        if (error !== undefined) reject(error); else resolve()
      }
      const abort = () => finish(signal.reason ?? cancelled())
      signal.addEventListener('abort', abort, { once: true })
      void Promise.race(work.map(task => task.then(() => undefined, () => undefined))).then(() => finish())
      if (signal.aborted) abort()
    })
  }

  function sessionLifetime(sessionId: string): SessionLifetime {
    const lifetime = sessions.get(sessionId) ?? { valid: true, id: randomUUID() }
    sessions.delete(sessionId); sessions.set(sessionId, lifetime)
    // Completed results can outlive indexes while adapters issue references.
    // Bound dormant lifetime bookkeeping and conservatively expire old fences.
    const maximum = Math.max(64, limits.maxConcurrentQueries + limits.maxIndexes)
    if (sessions.size > maximum) {
      const active = new Set(queries.values())
      const oldest = [...sessions].find(([id]) => !active.has(id))
      if (oldest) { oldest[1].valid = false; sessions.delete(oldest[0]) }
    }
    return lifetime
  }

  function checkIndex(index: Index, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (disposed) throw cancelled()
    if (indexes.get(index.key) !== index) throw stale()
  }

  function checkOrigin(binding: RetrievalBinding): void {
    if (!sameDocument(binding.document, ports.documents.snapshot(binding.sessionId, binding.document.id))) throw stale()
    if ((ports.pages.identity?.(binding.sessionId) ?? '') !== binding.extractionIdentity) throw stale()
    if ((ports.pages.indexIdentity?.(binding.sessionId) ?? binding.extractionIdentity) !== binding.indexExtractionIdentity) throw stale()
    if (binding.selectionIdentity !== 'lexical' && providerIdentity(ports.embedding?.select(binding.sessionId)) !== binding.selectionIdentity) throw stale()
  }

  function checkBinding(binding: RetrievalBinding): void {
    binding.signal.throwIfAborted()
    if (!binding.lifetime.valid) throw cancelled()
    checkOrigin(binding)
  }

  function guard(index: Index, binding: RetrievalBinding): void {
    checkIndex(index, binding.signal); checkBinding(binding)
  }

  function bind(sessionId: string, documentId: string, provider: RetrievalEmbedding | undefined,
    selectionIdentity: string, signal: AbortSignal, lifetime: SessionLifetime): RetrievalBinding {
    const value = ports.documents.snapshot(sessionId, documentId)
    const document: RetrievalDocument = { id: value.id, path: value.path, sourceDigest: value.sourceDigest,
      contentVersion: value.contentVersion, pageCount: value.pageCount,
      ...(value.indexContentDigest === undefined ? {} : { indexContentDigest: value.indexContentDigest }),
      ...(value.indexPageDigests === undefined ? {} : { indexPageDigests: value.indexPageDigests }) }
    if (document.indexContentDigest !== undefined && !isContentDigest(document.indexContentDigest)) {
      throw fail('pdf/retrieval-extraction-failed', 'PDF content identity is invalid')
    }
    const pageDigests = document.indexPageDigests
    if (pageDigests !== undefined && (!Array.isArray(pageDigests) || pageDigests.length !== document.pageCount
      || Array.from(pageDigests).some(value => value === null ? document.indexContentDigest !== undefined : !isContentDigest(value)))) {
      throw fail('pdf/retrieval-extraction-failed', 'PDF page content identities are invalid')
    }
    const extractionIdentity = ports.pages.identity?.(sessionId) ?? ''
    const indexExtractionIdentity = ports.pages.indexIdentity?.(sessionId) ?? extractionIdentity
    if (typeof extractionIdentity !== 'string' || extractionIdentity.length > 16_384
      || typeof indexExtractionIdentity !== 'string' || indexExtractionIdentity.length > 16_384) {
      throw fail('pdf/retrieval-extraction-failed', 'PDF extraction identity is invalid')
    }
    const binding = { sessionId, document, provider, selectionIdentity, extractionIdentity, indexExtractionIdentity, signal, lifetime }
    checkBinding(binding)
    return binding
  }

  function notifyProgress(index: Index): void {
    for (const notify of [...index.progress]) notify()
  }

  function phase(index: Index, value: Index['phase']): void {
    if (index.phase === value) return
    index.phase = value
    notifyProgress(index)
  }

  function observeProgress(index: Index, signal: AbortSignal, observer: ((progress: RetrievalProgress) => void) | undefined): () => void {
    if (!observer) return () => {}
    let last = ''
    const computedAtStart = index.computedChunks
    const notify = () => {
      if (signal.aborted) return
      const complete = ready(index) && !index.failures.size
      const computedChunks = index.computedChunks - computedAtStart
      const progress: RetrievalProgress = { indexedPages: index.pages.size, totalPages: index.toPage - index.fromPage + 1,
        embeddedChunks: index.embeddedCount, totalChunks: index.chunkCount,
        phase: complete ? 'ready' : index.phase, reusedChunks: Math.max(0, index.embeddedCount - computedChunks), computedChunks,
        ...(index.failures.size ? { failedPages: index.failures.size } : {}) }
      const signature = JSON.stringify(progress)
      if (signature === last) return
      last = signature
      try { void Promise.resolve(observer(progress)).catch(() => undefined) }
      catch { /* Progress observers cannot fail or delay the index they describe. */ }
    }
    index.progress.add(notify)
    notify()
    return () => { index.progress.delete(notify) }
  }

  function ready(index: Index): boolean {
    return index.pages.size === index.toPage - index.fromPage + 1
      && (!index.provider || index.embeddedCount === index.chunkCount)
  }
  function reserve(index: Index, addedBytes: number): void {
    const totalBytes = () => Array.from(indexes.values()).reduce((sum, entry) => sum + entry.bytes, 0)
    const candidates = Array.from(indexes.values()).filter(entry => entry !== index && !entry.users && !jobs.has(entry.key))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    while ((indexes.size > limits.maxIndexes || totalBytes() + addedBytes > limits.maxMemoryBytes) && candidates.length) {
      const retired = candidates.shift()!
      indexes.delete(retired.key); retired.release()
    }
    if (indexes.size > limits.maxIndexes) {
      throw Object.assign(fail('pdf/retrieval-indexes-budget', 'Other PDF indexes are still in use. Retry after they finish.'),
        { budget: { kind: 'indexes', limit: limits.maxIndexes, used: indexes.size - 1, requested: 1 } })
    }
    if (totalBytes() + addedBytes > limits.maxMemoryBytes) {
      throw Object.assign(fail('pdf/retrieval-memory-budget', 'The current PDF index operation exceeds its working memory budget.'),
        { budget: { kind: 'memory', limit: limits.maxMemoryBytes, used: totalBytes(), requested: addedBytes } })
    }
  }
  function summarize(index: Index, record: StoredIndexPage, chunks: readonly RetrievalChunk[], embedded: number): void {
    applySummary(index, record.page, summarizeIndexPage(record, chunks, embedded))
  }
  function applySummary(index: Index, page: number, summary: IndexPageSummary): void {
    const previous = index.pages.get(page)
    if (previous?.dataVersion !== summary.dataVersion) index.dataRevision++
    index.chunkCount += summary.chunks - (previous?.chunks ?? 0)
    index.embeddedCount += summary.embedded - (previous?.embedded ?? 0)
    index.pages.set(page, summary)
    if (summary.failure) index.failures.set(page, summary.failure)
    else index.failures.delete(page)
    const size = (page: IndexPageSummary | undefined) => page ? 128
      + page.warnings.reduce((count, warning) => count + warning.length * 2 + 16, 0) : 0
    index.bytes += size(summary) - size(previous)
    reserve(index, 0)
  }
  const characters = (index: Index) => Math.min(1200, index.provider?.maxInputCharacters ?? 1200)
  async function loadPage(index: Index, page: number) {
    return readIndexPage(storage, index.persistentKey, index.generation, page, index.provider?.dimensions, characters(index))
  }

  async function readPage(index: Index, page: number, source: SharedRetrievalSource): Promise<void> {
    source.check(); phase(index, 'restoring')
    let stored: Awaited<ReturnType<typeof loadPage>>
    try { stored = await loadPage(index, page) }
    catch (error) { if (codeOf(error) !== 'pdf/index-storage-missing') throw error }
    source.check()
    if (!stored) for (const seed of index.head.seeds ?? (index.head.active ? [index.head.active] : [])) {
      if (seed.id === index.generation) continue
      let previous: Awaited<ReturnType<typeof readIndexPage>>
      try { previous = await readIndexPage(storage, index.persistentKey, seed.id, page, index.provider?.dimensions, characters(index)) }
      catch (error) { if (!['pdf/index-storage-corrupt', 'pdf/index-storage-missing'].includes(codeOf(error))) throw error; continue }
      source.check()
      if (!previous) continue
      stored = { ...previous, record: { ...previous.record, generation: index.generation } }
      await writeMany(buildIndexPageEntries(index.persistentKey, index.generation, stored.record, stored.chunks, stored.location).entries)
      source.check(); break
    }
    if (stored && !stored.record.failure) {
      recordIndexPerformance({ stage: 'page-cache', durationMs: 0, records: 1, cacheHit: true })
      summarize(index, stored.record, stored.chunks, stored.vectors.size)
      return
    }
    const document = source.current().document
    const pageDigest = document.indexPageDigests?.[page - 1]
    const cacheKey = (content: string) => pageCacheKey(document.path, content, page, index.extractionIdentity)
    const key = cacheKey(pageContentCacheIdentity({ ...document, indexPageDigest: pageDigest }))
    let cached = stored?.record.failure ? undefined : await readCachedPage(ports.cache, key)
    source.check()
    if (!cached && pageDigest && !stored?.record.failure) {
      // Older installations keyed pages by the exact whole source or its
      // verified complete body. Both attest this page of the current document.
      const keys = new Set([index.contentDigest, document.sourceDigest])
      const previous = index.previousPageCacheSource
      if (previous?.indexPageDigests[page - 1] === pageDigest) {
        if (previous.indexContentDigest) keys.add(previous.indexContentDigest)
        keys.add(previous.sourceDigest)
      }
      for (const legacy of keys) {
        try { cached = await readCachedPage(ports.cache, cacheKey(legacy)) }
        catch (error) {
          if (!['pdf/index-storage-corrupt', 'pdf/index-storage-missing'].includes(codeOf(error))) throw error
        }
        source.check()
        if (!cached) continue
        await cacheDerived(ports.cache, key, cached)
        source.check()
        break
      }
    }
    recordIndexPerformance({ stage: 'page-cache', durationMs: 0, records: 1, cacheHit: !!cached })
    let pageFailure: z.infer<typeof pageFailureSchema> | undefined
    if (!cached) {
      phase(index, 'extracting')
      const result = await measureIndexOperation('page-extraction', () => source.read(page), { records: 1 })
      source.check()
      const length = Math.max(result.text.length, (result.units ?? []).reduce((sum, unit) => sum + unit.text.length, 0))
      if (length > 500_000) throw Object.assign(fail('pdf/retrieval-page-budget', 'PDF page content exceeds its processing budget.'),
        { budget: { kind: 'page', limit: 500_000, used: 0, requested: length } })
      const { failure, ...content } = result
      if (failure !== undefined) {
        const parsed = pageFailureSchema.safeParse(failure)
        if (!parsed.success) throw fail('pdf/retrieval-extraction-failed', 'PDF extraction returned invalid partial failure metadata')
        if (fatalContentError(parsed.data) !== undefined) throw fail(parsed.data.code, 'PDF extraction lost its source authority or was cancelled')
        pageFailure = parsed.data
      }
      cached = validateRetrievalPage({ version: 1, ...content,
        ...(result.warnings?.length ? { warnings: result.warnings.slice(0, 20).map(value => value.slice(0, 500)) } : {}) })
      if (!cached) throw fail('pdf/retrieval-extraction-failed', 'PDF extraction returned invalid content representations or offsets')
      if (!pageFailure) await cacheDerived(ports.cache, key, cached)
      source.check()
    }
    const chunks = chunkRetrievalPage(page, cached, { maxCharacters: characters(index) })
    const previous = index.pages.get(page)
    if (index.chunkCount - (previous?.chunks ?? 0) + chunks.length > limits.maxChunks) {
      throw Object.assign(fail('pdf/retrieval-chunks-budget', 'PDF index exceeds its configured chunk count limit.'),
        { budget: { kind: 'chunks', limit: limits.maxChunks, used: index.chunkCount - (previous?.chunks ?? 0), requested: chunks.length } })
    }
    // Only this page is resident. Geometry is saved once with its representation,
    // and expanded into chunk-local evidence only while building or querying it.
    const workingBytes = Buffer.byteLength(JSON.stringify(cached)) * 2 + chunks.reduce((sum, chunk) => sum
      + chunk.text.length * 2 + 320 + (chunk.representation ? JSON.stringify(chunk.representation).length * 2 : 0)
      + new Set(tokenizeRetrievalText(chunk.text)).size * 16, 0)
    reserve(index, workingBytes)
    const vectors = Object.create(null) as StoredIndexPage['vectors']
    for (const chunk of chunks) if (stored?.record.vectors[chunk.id]) vectors[chunk.id] = stored.record.vectors[chunk.id]
    const record: StoredIndexPage = { version: 1, page, generation: index.generation, content: cached, vectors,
      ...(pageFailure ? { failure: { code: pageFailure.code, attempts: (stored?.record.failure?.attempts ?? 0) + 1 } } : {}) }
    await writeMany(buildIndexPageEntries(index.persistentKey, index.generation, record, chunks).entries)
    source.check()
    summarize(index, record, chunks, Object.keys(vectors).length)
    notifyProgress(index)
  }

  async function writeMany(entries: readonly (readonly [string, unknown])[]): Promise<void> {
    if (!entries.length) return
    await measureIndexOperation('checkpoint-write', async () => {
      if (storage.setMany) {
        // Large legacy pages may migrate more than one backend batch. Keep the
        // final header last so interrupted migration never publishes dangling refs.
        for (let offset = 0; offset < entries.length; offset += 256) await storage.setMany(entries.slice(offset, offset + 256))
      }
      else for (const [key, value] of entries) await storage.set(key, value)
    }, { records: entries.length })
  }

  async function embedStep(index: Index, source: SharedRetrievalSource, deadline = Infinity): Promise<void> {
    if (!index.provider) return
    const batchSize = Math.min(16, index.provider.maxBatchSize,
      Math.max(1, Math.floor(Math.max(0, limits.maxMemoryBytes - index.bytes) / (index.provider.dimensions * 16))))
    type Frame = NonNullable<Awaited<ReturnType<typeof loadPage>>> & { changed: boolean; computed: number; memoryBytes: number; vectorKeys: Record<string, string> }
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
      // At most 16 loaded pages. Headers publish only after all referenced
      // vectors are already durable; immutable geometry is not rewritten.
      await writeMany(publications.flatMap(publication => publication.entries))
      source.check()
      for (const { frame, location } of publications) {
        frame.location = location; frame.vectorKeys = Object.create(null)
        summarize(index, frame.record, frame.chunks, Object.keys(frame.record.vectors).length)
        index.computedChunks += frame.computed
        frame.changed = false; frame.computed = 0
        if (Object.keys(frame.record.vectors).length === frame.chunks.length) {
          frames.delete(frame.record.page); bytes -= frame.memoryBytes
        }
      }
      notifyProgress(index)
    }
    const flush = async () => {
      if (!rows.size) { await commit(); return }
      phase(index, 'embedding')
      const batch = [...rows]
      reserve(index, bytes + batch.length * index.provider!.dimensions * 8)
      const vectors = await measureIndexOperation('embedding-batch', () => source.embed(batch.map(([, row]) => row.text)), { records: batch.length })
      source.check()
      if (vectors.length !== batch.length || vectors.some(vector => !validVector(vector, index.provider!.dimensions))) {
        throw fail('pdf/retrieval-invalid-vector', 'Embedding provider returned invalid vectors')
      }
      const encoded = vectors.map(vector => encodeCachedVector(vector))
      // Commit reusable model/text vectors before publishing page progress. A
      // failed checkpoint can reuse this completed inference after restart.
      await writeMany(batch.map(([key], i) => [key, encoded[i]!] as const))
      source.check()
      for (const [i, [key, row]] of batch.entries()) for (const target of row.targets) assign(target.frame, target.chunk, encoded[i]!, key, true)
      await commit()
      batches++; rows.clear()
    }
    const exhausted = () => batches >= limits.embeddingBatchesPerStep || batches > 0 && performance.now() >= deadline
    for (const [page, summary] of index.pages) {
      if (summary.embedded === summary.chunks) continue
      const loaded = await loadPage(index, page)
      source.check()
      if (!loaded) {
        invalidatePage(index, page)
        throw fail('pdf/index-storage-missing', 'A PDF index checkpoint is missing. Resume indexing to repair it.')
      }
      const size = Buffer.byteLength(JSON.stringify(loaded.record)) * 2
        + loaded.chunks.reduce((sum, chunk) => sum + chunk.text.length * 2 + 320, 0)
      // Cross-page batches keep a small working window, never a whole corpus.
      const remaining = limits.maxMemoryBytes - [...indexes.values()].reduce((sum, entry) => sum + entry.bytes, 0)
      const windowBytes = Math.min(8 * 1024 * 1024, Math.max(0, remaining - batchSize * index.provider.dimensions * 8))
      if (frames.size && (frames.size >= 16 || bytes + size > windowBytes)) {
        await flush(); frames.clear(); bytes = 0
        if (exhausted()) return
      }
      reserve(index, bytes + size)
      const frame: Frame = { ...loaded, changed: false, computed: 0, memoryBytes: size, vectorKeys: Object.create(null) }
      frames.set(page, frame); bytes += size
      summarize(index, frame.record, frame.chunks, frame.vectors.size)
      phase(index, 'restoring')
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
        const cached = await readCachedVectorRecord(ports.cache ?? storage, key, provider.dimensions)
        source.check()
        recordIndexPerformance({ stage: 'vector-cache', durationMs: 0, records: 1, cacheHit: !!cached })
        if (cached) assign(frame, chunk, cached.record, cached.persisted ? key : undefined)
        else rows.set(key, { text: chunk.text, targets: [{ frame, chunk }] })
        if (rows.size === batchSize) await flush()
      }
    }
    await flush()
  }

  function nextIncompletePage(index: Index, fromPage: number, includePartial = true): number {
    for (let page = fromPage; page <= index.toPage; page++) {
      if (!index.pages.has(page) || includePartial && index.failures.has(page)) return page
    }
    return index.toPage + 1
  }

  async function step(index: Index, source: SharedRetrievalSource, deadline: number, retrying: boolean, pass?: PreparationPass): Promise<void> {
    phase(index, 'restoring')
    // Foreground continuations can repair missing pages. Optional enrichment
    // on already usable pages is only retried by an indexing occurrence.
    let page = retrying ? nextIncompletePage(index, pass?.nextRetryPage ?? index.fromPage, !!pass) : index.nextPage
    for (let processed = 0; processed < limits.pagesPerStep && page <= index.toPage; processed++) {
      if (retrying || !index.pages.has(page)) {
        try { await readPage(index, page, source) } catch (error) {
          source.check()
          const critical = fatalContentError(error)
          if (critical !== undefined) throw critical
          const code = codeOf(error)
          if (code.includes('budget') || code.startsWith('pdf/index-storage-')) throw error
          index.failures.set(page, { page, attempts: (index.failures.get(page)?.attempts ?? 0) + 1, code })
        }
      }
      if (retrying) {
        if (pass) pass.nextRetryPage = page + 1
      } else index.nextPage = Math.max(index.nextPage, page + 1)
      await new Promise<void>(resolve => setImmediate(resolve)); source.check()
      if (performance.now() >= deadline) break
      page = retrying ? nextIncompletePage(index, page + 1, !!pass) : index.nextPage
    }
    await embedStep(index, source, deadline)
    source.check(); notifyProgress(index)
  }

  function joinStep(index: Index, binding: RetrievalBinding, slice = false, pass?: PreparationPass): Promise<void> {
    const signal = binding.signal
    let job = jobs.get(index.key)
    if (job?.controller.signal.aborted) throw fail('pdf/retrieval-busy', 'The previous indexing step is still cancelling; retry shortly')
    // Other callers can observe durable results without lending their source
    // authority to a retry initiated by this occurrence.
    if (job?.retrying && job.pass !== pass) return waitForWork([job.promise], signal)
    if (!job) {
      if (jobs.size >= limits.maxConcurrentJobs) throw fail('pdf/retrieval-busy', 'Other PDF indexes are being built; retry shortly')
      const controller = new AbortController()
      const retrying = index.nextPage > index.toPage
      const created: Job = { controller, subscribers: new Set(), promise: Promise.resolve(), retrying, pass }
      // Defer execution until the job is registered and subscribers are attached.
      created.promise = Promise.resolve().then(async () => {
        const source = createSharedRetrievalSource(ports, created.subscribers, controller.signal,
          () => checkIndex(index, controller.signal), checkBinding, checkOrigin)
        try { await step(index, source, slice ? performance.now() + 750 : Infinity, retrying, pass) } finally { source.dispose() }
      }).finally(() => jobs.delete(index.key))
      void created.promise.catch(() => {})
      job = created; jobs.set(index.key, job)
    }
    job.subscribers.add(binding)
    const shared = job
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort); shared.subscribers.delete(binding)
        if (!shared.subscribers.size && signal.aborted) shared.controller.abort(cancelled())
        if (error !== undefined) reject(error); else resolve()
      }
      const abort = () => finish(signal.reason ?? cancelled())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      shared.promise.then(() => finish(), error => {
        // Bind authority failures to this caller. Shared I/O errors must not
        // reveal another Session's source path, credentials or provider message.
        try { checkBinding(binding) } catch (ownError) { finish(ownError); return }
        try {
          void Promise.resolve(ports.onFailure?.(binding.sessionId, binding.document.id, error)).catch(() => {})
        } catch { /* Diagnostic observers cannot change task results or expose raw errors to callers. */ }
        finish(fail(codeOf(error), 'The shared PDF indexing step could not complete.'))
      })
    })
  }

  let opening = Promise.resolve()
  function waitForOpening(task: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort)
      const abort = () => { cleanup(); reject(signal.reason ?? cancelled()) }
      signal.addEventListener('abort', abort, { once: true })
      task.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
      if (signal.aborted) abort()
    })
  }
  async function getIndex(binding: RetrievalBinding,
    query: Pick<RetrievalQuery, 'documentId' | 'fromPage' | 'maxPages' | 'cursor'>,
    preferReady = false, rebuildToken?: string, onProgress?: (progress: RetrievalProgress) => void): Promise<Index> {
    const { document, provider, selectionIdentity } = binding
    const extractionIdentity = binding.indexExtractionIdentity ?? binding.extractionIdentity
    if (!Number.isSafeInteger(document.pageCount) || document.pageCount < query.fromPage) throw fail('pdf/invalid-page', 'Requested page is outside the PDF')
    const toPage = Math.min(document.pageCount, query.fromPage + (query.maxPages ?? document.pageCount) - 1)
    const modelKey = provider ? provider.documentFingerprint ?? digest(JSON.stringify([provider.fingerprint,
      provider.configurationIdentity ?? '', provider.dimensions, provider.maxInputCharacters ?? 1200])) : 'lexical'
    const contentKey = document.indexContentDigest
      ? ['disk-index-v2-content', document.path, document.indexContentDigest] : ['disk-index-v1', document.sourceDigest]
    const persistentKey = digest(JSON.stringify([...contentKey, document.pageCount,
      query.fromPage, toPage, modelKey, RETRIEVAL_EXTRACTION_VERSION, RETRIEVAL_TEXT_VERSION, extractionIdentity]))
    let result!: Index
    let reservedPin: (() => void) | undefined
    const task = opening.then(async () => {
      checkBinding(binding)
      const opened = await openIndexHead(storage, {
        key: persistentKey, fromPage: query.fromPage, toPage, preferReady, rebuildToken,
        signal: binding.signal, check: () => checkBinding(binding),
        onFailure: error => ports.onFailure?.(binding.sessionId, binding.document.id, error),
      })
      reservedPin = opened.release
      checkBinding(binding)
      const { head, selected, created } = opened
      const key = digest(JSON.stringify([persistentKey, selected.id, selectionIdentity]))
      let index = indexes.get(key)
      if (!index) {
        const previousPageCacheSource = document.indexPageDigests && ports.cache
          ? await readPageCacheSource(ports.cache, pageCacheSourceKey(document.path, extractionIdentity)) : undefined
        checkBinding(binding)
        index = { key, persistentKey, head, contentDigest: indexContentDigest(document),
          ...(document.indexContentDigest ? { sourcePath: document.path } : {}), pageCount: document.pageCount,
          fromPage: query.fromPage, toPage, generation: selected.id,
          provider: provider && { dimensions: provider.dimensions, maxBatchSize: provider.maxBatchSize,
            maxInputCharacters: provider.maxInputCharacters }, selectionIdentity, extractionIdentity,
          pages: new Map(), nextPage: created ? query.fromPage : toPage + 1, chunkCount: 0, embeddedCount: 0, dataRevision: 0,
          failures: new Map(), bytes: 512 + (previousPageCacheSource?.indexPageDigests.length ?? 0) * 160,
          lastUsed: Date.now(), users: 0,
          phase: 'restoring', computedChunks: 0, progress: new Set(),
          ...(previousPageCacheSource ? { previousPageCacheSource } : {}),
          release: reservedPin }
        reservedPin = undefined
        indexes.set(key, index)
        const stop = observeProgress(index, binding.signal, onProgress)
        try {
          reserve(index, 0)
          for (let page = index.fromPage; !created && page <= index.toPage; page++) {
            let summary: IndexPageSummary | undefined
            try { summary = await readIndexSummary(storage, index.persistentKey, index.generation, page, index.provider?.dimensions, characters(index)) }
            catch (error) { if (codeOf(error) !== 'pdf/index-storage-missing') throw error }
            guard(index, binding)
            if (summary) applySummary(index, page, summary)
            notifyProgress(index)
            if (!summary && index.nextPage > page) index.nextPage = page
            if (page % 20 === 0) await new Promise<void>(resolve => setImmediate(resolve))
          }
        } catch (error) { if (indexes.get(key) === index) indexes.delete(key); index.release(); throw error }
        finally { stop() }
      }
      index.head = head
      reservedPin?.(); reservedPin = undefined
      index.lastUsed = Date.now(); result = index
    }).catch(error => { reservedPin?.(); throw error })
    opening = task.then(() => {}, () => {})
    await waitForOpening(task, binding.signal)
    guard(result, binding)
    return result
  }

  function sameIndexSource(index: Index, binding: RetrievalBinding): boolean {
    return index.contentDigest === indexContentDigest(binding.document)
      && (index.sourcePath === undefined || index.sourcePath === binding.document.path)
      && index.pageCount === binding.document.pageCount
      && index.extractionIdentity === (binding.indexExtractionIdentity ?? binding.extractionIdentity)
  }
  async function rebuildIndex(binding: RetrievalBinding, scope: RetrievalPrepareScope,
    onProgress?: (progress: RetrievalProgress) => void): Promise<Index> {
    for (;;) {
      checkBinding(binding)
      const previous = [...indexes.values()].filter(index => sameIndexSource(index, binding))
      const active = previous.flatMap(index => { const job = jobs.get(index.key); return job ? [job.promise] : [] })
      if (active.length) { await waitForWork(active, binding.signal); continue }
      return getIndex(binding, scope, false, scope.rebuildToken ?? randomUUID(), onProgress)
    }
  }
  async function promote(index: Index, binding: RetrievalBinding): Promise<void> {
    if (!ready(index) || index.failures.size) return
    index.head = await promoteIndexHead(storage, {
      key: index.persistentKey, generation: index.generation,
      range: { fromPage: index.fromPage, toPage: index.toPage },
      signal: binding.signal, check: () => guard(index, binding),
      onFailure: error => ports.onFailure?.(binding.sessionId, binding.document.id, error),
    })
    const { document } = binding, pages = document.indexPageDigests
    if (ports.cache && !index.pageCacheSourceRecorded && pages && pages.length <= MAX_PAGE_CACHE_SOURCE_PAGES
      && index.fromPage === 1 && index.toPage === document.pageCount) {
      // Remember the source that proved a ready index. An upgrade can thus
      // restore it without eagerly rewriting every legacy page cache record.
      guard(index, binding)
      await ports.cache.set(pageCacheSourceKey(document.path, index.extractionIdentity), { version: 1,
        sourceDigest: document.sourceDigest, indexPageDigests: pages,
        ...(document.indexContentDigest ? { indexContentDigest: document.indexContentDigest } : {}),
      }).catch(() => {})
      guard(index, binding)
      index.pageCacheSourceRecorded = true
    }
  }
  function invalidatePage(index: Index, page: number): void {
    const summary = index.pages.get(page)
    if (summary) {
      index.pages.delete(page); index.chunkCount -= summary.chunks; index.embeddedCount -= summary.embedded
      index.bytes -= 128 + summary.warnings.reduce((sum, warning) => sum + warning.length * 2 + 16, 0)
      index.dataRevision++
    }
    index.nextPage = Math.min(index.nextPage, page)
  }
  async function* storedPages(index: Index, binding: RetrievalBinding): AsyncIterable<SearchPage> {
    for (let page = index.fromPage; page <= index.toPage; page++) {
      const stored = await loadPage(index, page)
      guard(index, binding)
      const summary = index.pages.get(page)
      if (!stored) {
        invalidatePage(index, page)
        throw fail('pdf/index-storage-missing', 'A PDF index checkpoint is missing. Resume indexing to repair it.')
      }
      if (summary?.dataVersion !== summarizeIndexPage(stored.record, stored.chunks, stored.vectors.size).dataVersion) {
        summarize(index, stored.record, stored.chunks, stored.vectors.size)
        throw stale('PDF index data changed during this search. Retry the query.')
      }
      yield { page, chunks: stored.chunks, vectors: stored.vectors }
      guard(index, binding)
    }
  }

  async function prepare(sessionId: string, input: RetrievalPrepareInput, externalSignal: AbortSignal | undefined,
    onProgress: ((progress: RetrievalProgress) => void) | undefined, singleSlice: boolean, occurrence?: object): Promise<boolean> {
      if (disposed) throw cancelled()
      if (rebuilding) throw fail('pdf/retrieval-busy', 'PDF search indexes are being reset; retry shortly')
      if (rebuildFailed) throw fail('pdf/retrieval-cache-unavailable', 'PDF index reset failed; retry rebuilding the index before searching')
      if (preparations.size >= limits.maxConcurrentQueries) throw fail('pdf/retrieval-busy', 'Too many background PDF preparations are waiting; retry shortly')
      const scope = retrievalPrepareSchema.parse(input)
      const controller = new AbortController()
      const abort = () => controller.abort(externalSignal?.reason ?? cancelled())
      externalSignal?.addEventListener('abort', abort, { once: true })
      if (externalSignal?.aborted) abort()
      preparations.set(controller, sessionId)
      let completePreparation!: () => void
      const pendingPreparation = new Promise<void>(resolve => { completePreparation = resolve })
      pendingQueries.add(pendingPreparation)
      let activeIndex: Index | undefined
      let stopProgress = () => {}
      const signal = controller.signal
      try {
        signal.throwIfAborted()
        while (queries.size >= limits.maxConcurrentQueries) {
          await waitForWork([...pendingQueries].filter(task => task !== pendingPreparation), signal)
          signal.throwIfAborted()
        }
        queries.set(controller, sessionId)
        const selected = ports.embedding?.select(sessionId)
        const selectionIdentity = providerIdentity(selected)
        const provider = selected && (!selected.availability || await selected.availability(signal)) ? selected : undefined
        signal.throwIfAborted()
        if (!provider) throw fail('pdf/retrieval-engine-unavailable', 'No embedding engine is available for background indexing')
        if (invalidDocumentIdentity(provider) || !Number.isSafeInteger(provider.dimensions) || provider.dimensions < 1
            || !Number.isSafeInteger(provider.maxBatchSize) || provider.maxBatchSize < 1
            || provider.maxInputCharacters !== undefined && (!Number.isSafeInteger(provider.maxInputCharacters) || provider.maxInputCharacters < 64)) {
          throw fail('pdf/retrieval-invalid-provider', 'Embedding provider has invalid dimensions or input limits')
        }
        const binding = bind(sessionId, scope.documentId, provider, selectionIdentity, signal, sessionLifetime(sessionId))
        const index = scope.rebuild ? await rebuildIndex(binding, scope, onProgress)
          : await getIndex(binding, scope, false, undefined, onProgress)
        index.users++; activeIndex = index
        guard(index, binding)
        const previous = occurrence && preparationPasses.get(occurrence)
        const pass = previous?.key === index.key && previous.generation === index.generation
          && previous.sessionId === sessionId && previous.documentId === scope.documentId ? previous
          : { key: index.key, generation: index.generation, sessionId, documentId: scope.documentId,
              nextPage: index.nextPage, nextRetryPage: index.fromPage }
        if (occurrence) preparationPasses.set(occurrence, pass)
        // A live occurrence can outlast the hot index. Restore its scan
        // cursor even when a failed page had no checkpoint to reload.
        index.nextPage = Math.max(index.nextPage, pass.nextPage)
        stopProgress = observeProgress(index, signal, onProgress)
        let sliced = false
        while (!ready(index) || index.failures.size > 0) {
          if (index.nextPage > index.toPage && index.embeddedCount === index.chunkCount
            && nextIncompletePage(index, pass.nextRetryPage) > index.toPage) {
            throw fail('pdf/retrieval-incomplete', 'Some PDF content could not be indexed. Resume indexing to retry only incomplete pages.')
          }
          if (singleSlice && sliced) return false
          let shared: Promise<void> | undefined
          while (!shared) {
            guard(index, binding)
            try { shared = joinStep(index, binding, singleSlice, pass) } catch (error) {
              if (codeOf(error) !== 'pdf/retrieval-busy') throw error
              // Foreground searches keep their fast-busy admission. Background
              // work waits for an existing real step to free capacity instead
              // of turning temporary load into a permanently failed prebuild.
              await waitForWork([...jobs.values()].map(job => job.promise), signal)
            }
          }
          await shared
          guard(index, binding)
          pass.nextPage = Math.max(pass.nextPage, index.nextPage)
          sliced = true
          // Background preparation cooperates with interactive work between
          // bounded shared steps; it never generates a synthetic search query.
          if (!singleSlice) {
            await new Promise<void>(resolve => setTimeout(resolve, 0))
            guard(index, binding)
          }
        }
        guard(index, binding)
        await promote(index, binding)
        return true
      } finally {
        stopProgress()
        externalSignal?.removeEventListener('abort', abort)
        // A cancelled background subscriber is the scheduler's drain boundary.
        // Keep its promise pending while an abandoned, non-cooperative step is
        // still using a build slot. Shared foreground subscribers own their own
        // lifetime and must neither be cancelled nor delay this preparation.
        const abandoned = activeIndex && jobs.get(activeIndex.key)
        if (abandoned?.controller.signal.aborted && !abandoned.subscribers.size) {
          await abandoned.promise.catch(() => undefined)
        }
        if (activeIndex) activeIndex.users--
        queries.delete(controller)
        preparations.delete(controller)
        pendingQueries.delete(pendingPreparation); completePreparation()
      }
  }

  return {
    state() { return disposed ? 'disposed' : rebuilding ? 'rebuilding' : rebuildFailed ? 'failed' : 'ready' },
    async prepare(sessionId, input, signal, onProgress) { await prepare(sessionId, input, signal, onProgress, false) },
    prepareSlice(sessionId, input, signal, onProgress, occurrence) { return prepare(sessionId, input, signal, onProgress, true, occurrence) },
    async search(sessionId, input: RetrievalInput, externalSignal) {
      if (disposed) throw cancelled()
      if (rebuilding) throw fail('pdf/retrieval-busy', 'PDF search indexes are being reset; retry shortly')
      if (rebuildFailed) throw fail('pdf/retrieval-cache-unavailable', 'PDF index reset failed; retry rebuilding the index before searching')
      if (queries.size >= limits.maxConcurrentQueries) throw fail('pdf/retrieval-busy', 'Too many PDF retrieval queries are active; retry shortly')
      const query = retrievalQuerySchema.parse(input)
      let activeIndex: Index | undefined
      const controller = new AbortController()
      const abort = () => controller.abort(externalSignal?.reason ?? cancelled())
      externalSignal?.addEventListener('abort', abort, { once: true })
      if (externalSignal?.aborted) abort()
      queries.set(controller, sessionId)
      const lifetime = sessionLifetime(sessionId)
      let completeQuery!: () => void
      const pendingQuery = new Promise<void>(resolve => { completeQuery = resolve })
      pendingQueries.add(pendingQuery)
      const signal = controller.signal
      try {
        signal.throwIfAborted()
        const selected = query.mode === 'lexical' ? undefined : ports.embedding?.select(sessionId)
        const selectionIdentity = query.mode === 'lexical' ? 'lexical' : providerIdentity(selected)
        const provider = selected && (!selected.availability || await selected.availability(signal)) ? selected : undefined
        signal.throwIfAborted()
        if (provider && (invalidDocumentIdentity(provider) || !Number.isSafeInteger(provider.dimensions) || provider.dimensions < 1
          || !Number.isSafeInteger(provider.maxBatchSize) || provider.maxBatchSize < 1
          || (provider.maxInputCharacters !== undefined && (!Number.isSafeInteger(provider.maxInputCharacters) || provider.maxInputCharacters < 64)))) {
          throw fail('pdf/retrieval-invalid-provider', 'Embedding provider has invalid dimensions or input limits')
        }
        if (!provider && (query.mode === 'semantic' || query.mode === 'hybrid')) {
          throw fail('pdf/retrieval-engine-unavailable', 'No embedding engine is available for this retrieval mode')
        }
        const effectiveMode = query.mode === 'auto' ? (provider ? 'hybrid' : 'lexical') : query.mode
        const binding = bind(sessionId, query.documentId, provider, selectionIdentity, signal, lifetime)
        const index = await getIndex(binding, query, true)
        index.users++; activeIndex = index
        const bindingHash = digest(JSON.stringify([sessionId, lifetime.id, binding.document,
          ...(binding.extractionIdentity ? [binding.extractionIdentity] : [])]))
        const queryHash = digest(JSON.stringify([query.query, query.terms, query.topK, query.mode, query.fromPage, query.maxPages ?? null]))
        if (query.cursor) {
          const cursor = parseRetrievalCursor(query.cursor)
          if (cursor.key !== index.key || cursor.generation !== index.generation) {
            throw stale('PDF search progress no longer matches the active index; start a new search with documentId and query')
          }
          if (cursor.binding !== bindingHash) throw stale('PDF search progress belongs to another Session or document binding; start a new search')
          if (cursor.query !== queryHash) throw fail('pdf/invalid-window', 'PDF search parameters do not match its saved progress; start a new search')
        }
        guard(index, binding)
        if (!ready(index)) {
          await joinStep(index, binding)
        }
        guard(index, binding)
        const available = ready(index)
        const complete = available && !index.failures.size
        if (complete) await promote(index, binding)
        const result: RetrievalResult = {
          status: complete ? 'complete' : (available || index.nextPage > index.toPage) && index.failures.size ? 'incomplete' : 'building',
          requestedMode: query.mode, effectiveMode, ...(query.mode === 'auto' && !provider ? { fallbackReason: 'embedding-engine-unavailable' } : {}),
          indexGeneration: index.generation, document: { ...binding.document }, scope: { fromPage: index.fromPage, toPage: index.toPage },
          coverage: { indexedPages: index.pages.size, totalPages: index.toPage - index.fromPage + 1,
            noTextPages: [...index.pages].filter(([, page]) => page.noText).map(([page]) => page),
            ocrPages: [...index.pages].filter(([, page]) => page.ocr).map(([page]) => page),
            imageDescriptionPages: [...index.pages].filter(([, page]) => page.descriptions).map(([page]) => page), failedPages: [...index.failures.values()].map(value => ({ ...value })),
            qualityWarnings: [...index.pages].filter(([, page]) => page.warnings.length).map(([page, summary]) => ({ page, warnings: [...summary.warnings] })),
            embeddedChunks: index.embeddedCount, totalChunks: index.chunkCount,
            visual: [...index.pages.values()].some(page => page.descriptions) ? 'image-descriptions' : 'not-indexed' },
          chunks: [],
        }
        results.set(result, { sessionId, lifetime, document: { ...binding.document }, selectionIdentity,
          extractionIdentity: binding.extractionIdentity, indexExtractionIdentity: binding.indexExtractionIdentity })
        if (!available) {
          result.nextCursor = encodeRetrievalCursor({ version: 2, key: index.key, generation: index.generation,
            binding: bindingHash, query: queryHash })
          return result
        }
        const dataRevision = index.dataRevision
        const check = () => {
          guard(index, binding)
          if (index.dataRevision !== dataRevision) throw stale('PDF index data changed during this search. Retry the query.')
        }
        let queryVector: number[] | undefined
        if (provider) {
          if (query.query.length > (provider.maxInputCharacters ?? Infinity)) throw fail('pdf/retrieval-query-too-long', 'Query exceeds the embedding model input limit')
          const embedded = await provider.embed([query.query], 'query', signal)
          check()
          if (embedded.length !== 1 || !validVector(embedded[0], provider.dimensions)) throw fail('pdf/retrieval-invalid-vector', 'Embedding provider returned an invalid query vector')
          queryVector = embedded[0]
        }
        const candidates = await searchStoredIndex({ pages: () => storedPages(index, binding),
          query: query.query, terms: query.terms, mode: effectiveMode, queryVector,
          limit: Math.max(30, query.topK * 8), signal, check })
        const [lexical, vectors] = collapseRepresentations([candidates.lexical, candidates.semantic], candidates.chunks)
        const ranked = effectiveMode === 'hybrid' ? hybridCandidates(lexical, vectors, query.topK)
          : (effectiveMode === 'semantic' ? vectors : lexical).slice(0, query.topK)
        const chunksById = new Map(candidates.chunks.map(chunk => [chunk.id, chunk]))
        result.chunks = ranked.map(hit => ({ ...chunksById.get(hit.chunkId)!, score: hit.score }))
        guard(index, binding)
        return result
      } finally {
        externalSignal?.removeEventListener('abort', abort)
        if (activeIndex) activeIndex.users--
        queries.delete(controller)
        pendingQueries.delete(pendingQuery); completeQuery()
      }
    },
    validate(sessionId, result) {
      if (disposed) throw cancelled()
      const fence = results.get(result)
      if (!fence || !fence.lifetime.valid || fence.sessionId !== sessionId
        || !sameDocument(fence.document, ports.documents.snapshot(sessionId, fence.document.id))) throw stale()
      if ((ports.pages.identity?.(sessionId) ?? '') !== fence.extractionIdentity) throw stale()
      if ((ports.pages.indexIdentity?.(sessionId) ?? fence.extractionIdentity) !== fence.indexExtractionIdentity) throw stale()
      if (fence.selectionIdentity !== 'lexical'
        && providerIdentity(ports.embedding?.select(sessionId)) !== fence.selectionIdentity) throw stale()
    },
    cancelSession(sessionId) {
      const lifetime = sessions.get(sessionId)
      if (lifetime) lifetime.valid = false
      sessions.delete(sessionId)
      for (const [controller, session] of preparations) if (session === sessionId) controller.abort(cancelled())
      for (const [controller, session] of queries) if (session === sessionId) controller.abort(cancelled())
      // Shared data has no Session owner. Subscriber abort handlers detach only
      // this Session; the final departing subscriber cancels the build step.
    },
    rebuild() {
      if (disposed) return Promise.reject(cancelled())
      if (rebuilding) return rebuilding
      if (ports.cache && !ports.cache.clear) {
        return Promise.reject(fail('pdf/retrieval-cache-unavailable', 'This derived cache does not support index reset'))
      }
      let active: Promise<void>[] = []
      const retiredIndexes = [...indexes.values()]
      const task = Promise.resolve().then(async () => {
        await Promise.allSettled(active)
        for (const index of retiredIndexes) index.release()
        for (const index of indexes.values()) index.release()
        indexes.clear()
        if (disposed) throw cancelled()
        await storage.clear?.()
        if (disposed) throw cancelled()
        rebuildFailed = false
      }).catch(error => {
        // A partial storage failure must not silently reuse the remaining old
        // records. Keep admission closed until a successful retry clears them.
        rebuildFailed = true
        throw error
      }).finally(() => { if (rebuilding === task) rebuilding = undefined })
      rebuilding = task
      // Close admission and invalidate result fences synchronously. Drain actual
      // work, including non-cooperative I/O and cache writes, before clearing the
      // store so a late old-generation write cannot repopulate a fresh index.
      indexes.clear()
      for (const lifetime of sessions.values()) lifetime.valid = false
      sessions.clear()
      for (const controller of preparations.keys()) controller.abort(cancelled())
      for (const controller of queries.keys()) controller.abort(cancelled())
      for (const job of jobs.values()) job.controller.abort(cancelled())
      active = [opening, ...[...jobs.values()].map(job => job.promise), ...pendingQueries]
      return task
    },
    async dispose() {
      disposed = true
      const retiredIndexes = [...indexes.values()]
      for (const controller of preparations.keys()) controller.abort(cancelled())
      for (const controller of queries.keys()) controller.abort(cancelled())
      for (const job of jobs.values()) job.controller.abort(cancelled())
      indexes.clear()
      for (const lifetime of sessions.values()) lifetime.valid = false
      sessions.clear()
      await Promise.allSettled([opening, ...[...jobs.values()].map(job => job.promise), ...pendingQueries])
      await rebuilding?.catch(() => undefined)
      for (const index of retiredIndexes) index.release()
      for (const index of indexes.values()) index.release()
      indexes.clear()
    },
  }
}
