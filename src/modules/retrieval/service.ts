import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cacheDerived, digest, pageCacheKey, readCachedPage, readCachedVector, retrievalCacheKey, validVector } from './cache.js'
import { chunkPage, RETRIEVAL_TEXT_VERSION, tokenizeRetrievalText, validParagraphBreaks, type RetrievalChunk } from './text.js'
import { createBm25IndexCooperatively, hybridCandidates, rankVectorsCooperatively,
  searchBm25Cooperatively, type Bm25Index, type RankedChunk } from './ranking.js'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalInput, RetrievalPorts, RetrievalResult, RetrievalService } from './types.js'

const inputSchema = z.object({
  documentId: z.string().min(1).max(512), query: z.string().trim().min(1).max(2000),
  terms: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  mode: z.enum(['auto', 'lexical', 'semantic', 'hybrid']).default('auto'),
  topK: z.number().int().min(1).max(20).default(6),
  fromPage: z.number().int().min(1).default(1), maxPages: z.number().int().min(1).max(100_000).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict()
const cursorSchema = z.object({
  version: z.literal(1), key: z.string().length(64), generation: z.string().uuid(), query: z.string().length(64),
}).strict()
type Query = z.infer<typeof inputSchema>
interface Index {
  key: string; sessionId: string; document: RetrievalDocument; fromPage: number; toPage: number
  generation: string; provider?: RetrievalEmbedding; selectionIdentity: string
  chunks: RetrievalChunk[]; vectors: Map<string, number[]>; pages: Set<number>; nextPage: number
  noText: number[]; ocr: number[]; warnings: { page: number; warnings: string[] }[]
  failures: Map<number, { page: number; attempts: number; code: string }>
  bytes: number; lastUsed: number; users: number; bm25?: Bm25Index
}
interface Job { controller: AbortController; promise: Promise<void>; subscribers: number }
interface SessionLifetime { valid: boolean }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
const cancelled = () => fail('pdf/cancelled', 'PDF retrieval was cancelled')
const stale = (message = 'PDF search snapshot is no longer current; start a new search with documentId and query') =>
  fail('pdf/stale-reader', message)
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error
  && typeof error.code === 'string' ? error.code.slice(0, 100) : 'pdf/retrieval-extraction-failed'
const sameDocument = (a: RetrievalDocument, b: RetrievalDocument) => a.id === b.id && a.path === b.path
  && a.sourceDigest === b.sourceDigest && a.contentVersion === b.contentVersion && a.pageCount === b.pageCount
const providerIdentity = (provider: RetrievalEmbedding | undefined) => provider ? `${provider.fingerprint}:${provider.generation ?? ''}` : 'none'

/** A bounded index owns derived text only; working-copy access and pinning belong to its caller. */
export function createRetrievalService(ports: RetrievalPorts): RetrievalService {
  const limits = { pagesPerStep: 20, embeddingBatchesPerStep: 4, maxChunks: 5000, maxIndexes: 8,
    maxMemoryBytes: 64 * 1024 * 1024, maxConcurrentJobs: 2, maxConcurrentQueries: 8, ...ports.limits }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid retrieval budget')
  const indexes = new Map<string, Index>()
  const jobs = new Map<string, Job>()
  const queries = new Map<AbortController, string>()
  const pendingQueries = new Set<Promise<void>>()
  const sessions = new Map<string, SessionLifetime>()
  // Weak result fences retain identity only, not the heavy index. Adapters can
  // revalidate after minting refs even if an idle index has since been evicted.
  const results = new WeakMap<RetrievalResult, {
    sessionId: string; lifetime: SessionLifetime; document: RetrievalDocument; selectionIdentity: string
  }>()
  let disposed = false

  function sessionLifetime(sessionId: string): SessionLifetime {
    const lifetime = sessions.get(sessionId) ?? { valid: true }
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

  function guard(index: Index, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (disposed) throw cancelled()
    if (indexes.get(index.key) !== index || !sameDocument(index.document, ports.documents.snapshot(index.sessionId, index.document.id))) throw stale()
    if (index.selectionIdentity !== 'lexical' && providerIdentity(ports.embedding?.select(index.sessionId)) !== index.selectionIdentity) throw stale()
  }

  function reserve(index: Index, addedBytes: number): void {
    const totalBytes = () => Array.from(indexes.values()).reduce((sum, entry) => sum + entry.bytes, 0)
    const candidates = Array.from(indexes.values()).filter(entry => entry !== index && !entry.users && !jobs.has(entry.key))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    while ((indexes.size > limits.maxIndexes || totalBytes() + addedBytes > limits.maxMemoryBytes) && candidates.length) {
      indexes.delete(candidates.shift()!.key)
    }
    if (indexes.size > limits.maxIndexes || totalBytes() + addedBytes > limits.maxMemoryBytes) {
      throw fail('pdf/retrieval-budget', 'Retrieval index exceeds its memory budget; search a smaller page range')
    }
    index.bytes += addedBytes
  }

  async function readPage(index: Index, page: number, signal: AbortSignal): Promise<void> {
    guard(index, signal)
    const key = pageCacheKey(index.document.path, index.document.sourceDigest, page)
    let cached = await readCachedPage(ports.cache, key)
    guard(index, signal)
    if (!cached) {
      const result = await ports.pages.read(index.sessionId, index.document.id, page, signal)
      guard(index, signal)
      if (result.text.length > 500_000) throw fail('pdf/retrieval-budget', 'PDF page text exceeds the indexing budget')
      if (!validParagraphBreaks(result.text, result.paragraphBreaks)) {
        throw fail('pdf/retrieval-extraction-failed', 'PDF extraction returned invalid paragraph offsets')
      }
      cached = { version: 1, text: result.text, source: result.source,
        ...(result.paragraphBreaks ? { paragraphBreaks: [...result.paragraphBreaks] } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings.slice(0, 20).map(value => value.slice(0, 500)) } : {}) }
      await cacheDerived(ports.cache, key, cached)
      guard(index, signal)
    }
    const chunks = chunkPage(page, cached.text, cached.source,
      { maxCharacters: Math.min(1200, index.provider?.maxInputCharacters ?? 1200), paragraphBreaks: cached.paragraphBreaks })
    if (index.chunks.length + chunks.length > limits.maxChunks) {
      throw fail('pdf/retrieval-budget', 'PDF contains too many text chunks; search a smaller page range')
    }
    // Account for estimated lexical postings too, not only retained strings. The
    // hard chunk limit supplements this estimate because JS object sizes vary.
    reserve(index, 128 + (cached.paragraphBreaks?.length ?? 0) * 8
      + (cached.warnings ?? []).reduce((sum, warning) => sum + warning.length * 2 + 32, 0)
      + chunks.reduce((sum, chunk) => sum + chunk.text.length * 2 + 320
        + tokenizeRetrievalText(chunk.text).length * 96, 0))
    index.chunks.push(...chunks)
    index.pages.add(page)
    index.failures.delete(page)
    if (!chunks.length) index.noText.push(page)
    if (cached.source === 'ocr') index.ocr.push(page)
    if (cached.warnings?.length) index.warnings.push({ page, warnings: cached.warnings })
  }

  async function embedStep(index: Index, signal: AbortSignal): Promise<void> {
    if (!index.provider) return
    const provider = index.provider
    const pending = index.chunks.filter(chunk => !index.vectors.has(chunk.id))
    const batchSize = Math.min(16, provider.maxBatchSize)
    let batches = 0
    let scanned = 0
    const byText = new Map<string, RetrievalChunk[]>()
    async function flush(): Promise<void> {
      if (!byText.size) return
      const rows = [...byText.entries()]
      const vectors = await provider.embed(rows.map(([, chunks]) => chunks[0].text), 'document', signal)
      guard(index, signal)
      if (vectors.length !== rows.length || vectors.some(vector => !validVector(vector, provider.dimensions))) {
        throw fail('pdf/retrieval-invalid-vector', 'Embedding provider returned invalid vectors')
      }
      for (let i = 0; i < rows.length; i++) {
        const [key, chunks] = rows[i]
        const vector = [...vectors[i]]
        reserve(index, vector.length * 8 * chunks.length)
        for (const chunk of chunks) index.vectors.set(chunk.id, vector)
        await cacheDerived(ports.cache, key, [...vector])
        guard(index, signal)
      }
      batches++
      byText.clear()
    }
    for (const chunk of pending) {
      guard(index, signal)
      if (batches >= limits.embeddingBatchesPerStep || scanned++ >= 512) break
      const key = retrievalCacheKey('vector', provider.fingerprint, 'document', digest(chunk.text))
      const cached = await readCachedVector(ports.cache, key, provider.dimensions)
      guard(index, signal)
      if (cached) {
        reserve(index, cached.length * 8)
        index.vectors.set(chunk.id, cached)
      } else {
        const rows = byText.get(key) ?? []
        rows.push(chunk); byText.set(key, rows)
        if (byText.size >= batchSize) await flush()
      }
    }
    await flush()
  }

  async function step(index: Index, signal: AbortSignal): Promise<void> {
    const todo = index.nextPage <= index.toPage
      ? Array.from({ length: Math.min(limits.pagesPerStep, index.toPage - index.nextPage + 1) }, (_, i) => index.nextPage + i)
      : [...index.failures.keys()].slice(0, limits.pagesPerStep)
    for (const page of todo) {
      try { await readPage(index, page, signal) } catch (error) {
        guard(index, signal)
        const code = codeOf(error)
        if (['pdf/retrieval-budget', 'pdf/stale-reader', 'pdf/cancelled', 'pdf/access-denied', 'pdf/not-found'].includes(code)) throw error
        index.failures.set(page, { page, attempts: (index.failures.get(page)?.attempts ?? 0) + 1, code })
      }
      index.nextPage = Math.max(index.nextPage, page + 1)
      // Give interactive requests and cancellation a turn between native page reads.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      guard(index, signal)
    }
    await embedStep(index, signal)
    guard(index, signal)
    if (!index.bm25 && index.pages.size === index.toPage - index.fromPage + 1) {
      // Keep the initial lexical build inside the shared job too: concurrent
      // searches must not allocate duplicate posting maps for the same index.
      index.bm25 = await createBm25IndexCooperatively(index.chunks, signal, () => guard(index, signal))
    }
  }

  function joinStep(index: Index, signal: AbortSignal): Promise<void> {
    let job = jobs.get(index.key)
    if (job?.controller.signal.aborted) throw fail('pdf/retrieval-busy', 'The previous indexing step is still cancelling; retry shortly')
    if (!job) {
      if (jobs.size >= limits.maxConcurrentJobs) throw fail('pdf/retrieval-busy', 'Other PDF indexes are being built; retry shortly')
      const controller = new AbortController()
      const created: Job = { controller, subscribers: 0, promise: Promise.resolve() }
      // Defer execution until the job is registered and subscribers are attached.
      created.promise = Promise.resolve().then(async () => {
        const release = await ports.documents.retain?.(index.sessionId, index.document.id, controller.signal)
        try { await step(index, controller.signal) } finally { release?.() }
      }).finally(() => jobs.delete(index.key))
      void created.promise.catch(() => {})
      job = created; jobs.set(index.key, job)
    }
    job.subscribers++
    const shared = job
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort); shared.subscribers--
        if (!shared.subscribers && signal.aborted) shared.controller.abort(cancelled())
        if (error !== undefined) reject(error); else resolve()
      }
      const abort = () => finish(signal.reason ?? cancelled())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      shared.promise.then(() => finish(), finish)
    })
  }

  function parseCursor(token: string): z.infer<typeof cursorSchema> {
    try {
      const decoded = Buffer.from(token, 'base64url')
      if (decoded.toString('base64url') !== token) throw new Error('Invalid encoding')
      return cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
    } catch { throw fail('pdf/invalid-window', 'Invalid retrieval cursor; restart the search') }
  }

  function getIndex(sessionId: string, query: Query, provider: RetrievalEmbedding | undefined, selectionIdentity: string): Index {
    const snapshot = ports.documents.snapshot(sessionId, query.documentId)
    // Extra working-copy fields (especially annotation revision) do not define
    // the searchable source and must not invalidate an otherwise reusable index.
    const document: RetrievalDocument = { id: snapshot.id, path: snapshot.path, sourceDigest: snapshot.sourceDigest,
      contentVersion: snapshot.contentVersion, pageCount: snapshot.pageCount }
    if (!Number.isSafeInteger(document.pageCount) || document.pageCount < query.fromPage) throw fail('pdf/invalid-page', 'Requested page is outside the PDF')
    const toPage = Math.min(document.pageCount, query.fromPage + (query.maxPages ?? document.pageCount) - 1)
    const key = digest(JSON.stringify([sessionId, document, query.fromPage, toPage, selectionIdentity, provider ? 'vectors' : 'lexical', RETRIEVAL_TEXT_VERSION]))
    let index = indexes.get(key)
    if (!index && query.cursor) throw stale('PDF search index expired or its document/engine changed; start a new search with documentId and query')
    if (!index) {
      index = { key, sessionId, document: { ...document }, fromPage: query.fromPage, toPage, generation: randomUUID(),
        provider, selectionIdentity, chunks: [], vectors: new Map(), pages: new Set(), nextPage: query.fromPage,
        noText: [], ocr: [], warnings: [], failures: new Map(), bytes: 0, lastUsed: Date.now(), users: 0 }
      indexes.set(key, index)
      try { reserve(index, 0) } catch (error) { indexes.delete(key); throw error }
    }
    index.lastUsed = Date.now()
    return index
  }

  return {
    async search(sessionId, input: RetrievalInput, externalSignal) {
      if (disposed) throw cancelled()
      if (queries.size >= limits.maxConcurrentQueries) throw fail('pdf/retrieval-busy', 'Too many PDF retrieval queries are active; retry shortly')
      const query = inputSchema.parse(input)
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
        if (provider && (!Number.isSafeInteger(provider.dimensions) || provider.dimensions < 1
          || !Number.isSafeInteger(provider.maxBatchSize) || provider.maxBatchSize < 1
          || (provider.maxInputCharacters !== undefined && (!Number.isSafeInteger(provider.maxInputCharacters) || provider.maxInputCharacters < 64)))) {
          throw fail('pdf/retrieval-invalid-provider', 'Embedding provider has invalid dimensions or input limits')
        }
        if (!provider && (query.mode === 'semantic' || query.mode === 'hybrid')) {
          throw fail('pdf/retrieval-engine-unavailable', 'No embedding engine is available for this retrieval mode')
        }
        const effectiveMode = query.mode === 'auto' ? (provider ? 'hybrid' : 'lexical') : query.mode
        const index = getIndex(sessionId, query, provider, selectionIdentity)
        index.users++; activeIndex = index
        const queryHash = digest(JSON.stringify([query.query, query.terms, query.topK, query.mode, query.fromPage, query.maxPages ?? null]))
        if (query.cursor) {
          const cursor = parseCursor(query.cursor)
          if (cursor.key !== index.key || cursor.generation !== index.generation) {
            throw stale('PDF search progress no longer matches the active index; start a new search with documentId and query')
          }
          if (cursor.query !== queryHash) throw fail('pdf/invalid-window', 'PDF search parameters do not match its saved progress; start a new search')
        }
        guard(index, signal)
        if (!index.bm25 || index.pages.size < index.toPage - index.fromPage + 1 || (provider && index.vectors.size < index.chunks.length)) {
          await joinStep(index, signal)
        }
        guard(index, signal)
        const complete = index.pages.size === index.toPage - index.fromPage + 1 && (!provider || index.vectors.size === index.chunks.length)
        const result: RetrievalResult = {
          status: complete ? 'complete' : index.nextPage > index.toPage && index.failures.size ? 'incomplete' : 'building',
          requestedMode: query.mode, effectiveMode, ...(query.mode === 'auto' && !provider ? { fallbackReason: 'embedding-engine-unavailable' } : {}),
          indexGeneration: index.generation, document: { ...index.document }, scope: { fromPage: index.fromPage, toPage: index.toPage },
          coverage: { indexedPages: index.pages.size, totalPages: index.toPage - index.fromPage + 1,
            noTextPages: [...index.noText], ocrPages: [...index.ocr], failedPages: [...index.failures.values()].map(value => ({ ...value })),
            qualityWarnings: index.warnings.map(value => ({ page: value.page, warnings: [...value.warnings] })),
            embeddedChunks: index.vectors.size, totalChunks: index.chunks.length, visual: 'not-indexed' },
          chunks: [],
        }
        results.set(result, { sessionId, lifetime, document: { ...index.document }, selectionIdentity })
        if (!complete) {
          result.nextCursor = Buffer.from(JSON.stringify({ version: 1, key: index.key, generation: index.generation, query: queryHash })).toString('base64url')
          return result
        }
        const fetchCount = Math.max(30, query.topK * 4)
        const check = () => guard(index, signal)
        let lexical: RankedChunk[] = []
        if (effectiveMode !== 'semantic') {
          lexical = await searchBm25Cooperatively(index.bm25!, [query.query, ...query.terms].join(' '), fetchCount, signal, check)
        }
        let vectors: RankedChunk[] = []
        if (provider) {
          if (query.query.length > (provider.maxInputCharacters ?? Infinity)) throw fail('pdf/retrieval-query-too-long', 'Query exceeds the embedding model input limit')
          const embedded = await provider.embed([query.query], 'query', signal)
          guard(index, signal)
          if (embedded.length !== 1 || !validVector(embedded[0], provider.dimensions)) throw fail('pdf/retrieval-invalid-vector', 'Embedding provider returned an invalid query vector')
          vectors = await rankVectorsCooperatively(embedded[0], [...index.vectors].map(([chunkId, vector]) => ({ chunkId, vector })), fetchCount, signal, check)
        }
        const ranked = effectiveMode === 'hybrid' ? hybridCandidates(lexical, vectors, query.topK)
          : (effectiveMode === 'semantic' ? vectors : lexical).slice(0, query.topK)
        const chunksById = new Map(index.chunks.map(chunk => [chunk.id, chunk]))
        result.chunks = ranked.map(hit => ({ ...chunksById.get(hit.chunkId)!, score: hit.score }))
        guard(index, signal)
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
      if (fence.selectionIdentity !== 'lexical'
        && providerIdentity(ports.embedding?.select(sessionId)) !== fence.selectionIdentity) throw stale()
    },
    cancelSession(sessionId) {
      const lifetime = sessions.get(sessionId)
      if (lifetime) lifetime.valid = false
      sessions.delete(sessionId)
      for (const [controller, session] of queries) if (session === sessionId) controller.abort(cancelled())
      for (const [key, index] of indexes) if (index.sessionId === sessionId) {
        jobs.get(key)?.controller.abort(cancelled()); indexes.delete(key)
      }
    },
    async dispose() {
      disposed = true
      for (const controller of queries.keys()) controller.abort(cancelled())
      for (const job of jobs.values()) job.controller.abort(cancelled())
      indexes.clear()
      for (const lifetime of sessions.values()) lifetime.valid = false
      sessions.clear()
      await Promise.allSettled([...jobs.values()].map(job => job.promise).concat([...pendingQueries]))
    },
  }
}
