import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fatalContentError } from '../document/index.js'
import { cacheDerived, digest, encodeCachedVector, pageCacheKey, readCachedPage, readCachedVector, retrievalCacheKey, validVector, validateRetrievalPage, RETRIEVAL_EXTRACTION_VERSION } from './cache.js'
import { chunkRetrievalPage, RETRIEVAL_TEXT_VERSION, tokenizeRetrievalText, type RetrievalChunk } from './text.js'
import { createBm25IndexCooperatively, hybridCandidates, rankVectorsCooperatively,
  searchBm25Cooperatively, type Bm25Index, type RankedChunk } from './ranking.js'
import { compactRetrievalVector } from './vector.js'
import { createSharedRetrievalSource, type RetrievalBinding, type SharedRetrievalSource } from './shared-source.js'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalInput, RetrievalPorts, RetrievalPrepareInput, RetrievalProgress, RetrievalResult, RetrievalService } from './types.js'

const inputSchema = z.object({
  documentId: z.string().min(1).max(512), query: z.string().trim().min(1).max(2000),
  terms: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  mode: z.enum(['auto', 'lexical', 'semantic', 'hybrid']).default('auto'),
  topK: z.number().int().min(1).max(20).default(6),
  fromPage: z.number().int().min(1).default(1), maxPages: z.number().int().min(1).max(100_000).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict()
const pageFailureSchema = z.object({ code: z.string().min(1).max(100) }).strict()
const prepareSchema = inputSchema.pick({ documentId: true, fromPage: true, maxPages: true }).extend({ rebuild: z.boolean().optional() })
const cursorSchema = z.object({
  version: z.literal(2), key: z.string().length(64), generation: z.string().uuid(),
  binding: z.string().length(64), query: z.string().length(64),
}).strict()
type Query = z.infer<typeof inputSchema>
interface Index {
  key: string; sourceDigest: string; pageCount: number; fromPage: number; toPage: number
  generation: string; provider?: Pick<RetrievalEmbedding, 'dimensions' | 'maxBatchSize' | 'maxInputCharacters'>; selectionIdentity: string; extractionIdentity: string
  chunks: RetrievalChunk[]; vectors: Map<string, Float32Array>; vectorPool: Map<string, Float32Array>; pages: Set<number>; nextPage: number
  noText: number[]; ocr: number[]; descriptions: number[]; warnings: { page: number; warnings: string[] }[]
  failures: Map<number, { page: number; attempts: number; code: string }>
  bytes: number; lastUsed: number; users: number; bm25?: Bm25Index
  phase: NonNullable<RetrievalProgress['phase']>; computedChunks: number
  progress: Set<() => void>
  refreshing: boolean
}
interface Job { controller: AbortController; promise: Promise<void>; subscribers: Set<RetrievalBinding> }
interface SessionLifetime { valid: boolean; id: string }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
const cancelled = () => fail('pdf/cancelled', 'PDF retrieval was cancelled')
const stale = (message = 'PDF search snapshot is no longer current; start a new search with documentId and query') =>
  fail('pdf/stale-reader', message)
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error
  && typeof error.code === 'string' ? error.code.slice(0, 100) : 'pdf/retrieval-extraction-failed'
const sameDocument = (a: RetrievalDocument, b: RetrievalDocument) => a.id === b.id && a.path === b.path
  && a.sourceDigest === b.sourceDigest && a.contentVersion === b.contentVersion && a.pageCount === b.pageCount
const providerIdentity = (provider: RetrievalEmbedding | undefined) => provider
  ? JSON.stringify([provider.fingerprint, provider.generation ?? '', provider.configurationIdentity ?? '',
    provider.dimensions, provider.maxBatchSize, provider.maxInputCharacters ?? null,
    ...(provider.documentFingerprint === undefined ? [] : [provider.documentFingerprint])]) : 'none'
const invalidDocumentIdentity = (provider: RetrievalEmbedding) => provider.documentFingerprint !== undefined
  && (typeof provider.documentFingerprint !== 'string' || !provider.documentFingerprint || provider.documentFingerprint.length > 512)

/** Alternative representations of one block compete as one result. Choose a
 * representation using its best rank in each branch, retaining that unit's
 * distinct subranges so long native paragraphs still produce separate hits. */
function collapseRepresentations(rankings: RankedChunk[][], chunks: readonly RetrievalChunk[]): RankedChunk[][] {
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]))
  const blocks = new Map<string, Map<string, { score: number; priority: number }>>()
  for (const ranking of rankings) {
    const seen = new Set<string>()
    for (const [rank, hit] of ranking.entries()) {
      const chunk = byId.get(hit.chunkId), representation = chunk?.representation
      if (!representation) continue
      const block = JSON.stringify([chunk.page, representation.blockId]), key = JSON.stringify([block, representation.id])
      if (seen.has(key)) continue
      seen.add(key)
      const units = blocks.get(block) ?? new Map<string, { score: number; priority: number }>()
      const value = units.get(representation.id) ?? { score: 0,
        priority: representation.kind === 'native-text' ? 0 : representation.kind === 'ocr-text' ? 1 : 2 }
      value.score += 1 / (60 + rank + 1)
      units.set(representation.id, value); blocks.set(block, units)
    }
  }
  const selected = new Map([...blocks].map(([block, units]) => [block, [...units].sort((a, b) =>
    b[1].score - a[1].score || a[1].priority - b[1].priority || a[0].localeCompare(b[0]))[0]![0]]))
  return rankings.map(ranking => ranking.filter(hit => {
    const chunk = byId.get(hit.chunkId), representation = chunk?.representation
    return !representation || selected.get(JSON.stringify([chunk.page, representation.blockId])) === representation.id
  }))
}

/** A bounded index owns derived text only; working-copy access and pinning belong to its caller. */
export function createRetrievalService(ports: RetrievalPorts): RetrievalService {
  const limits = { pagesPerStep: 20, embeddingBatchesPerStep: 4, maxChunks: 20000, maxIndexes: 8,
    maxMemoryBytes: 64 * 1024 * 1024, maxConcurrentJobs: 2, maxConcurrentQueries: 8, ...ports.limits }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid retrieval budget')
  const indexes = new Map<string, Index>()
  const jobs = new Map<string, Job>()
  const queries = new Map<AbortController, string>()
  const preparations = new Map<AbortController, string>()
  const pendingQueries = new Set<Promise<void>>()
  const sessions = new Map<string, SessionLifetime>()
  // Weak result fences retain identity only, not the heavy index. Adapters can
  // revalidate after minting refs even if an idle index has since been evicted.
  const results = new WeakMap<RetrievalResult, {
    sessionId: string; lifetime: SessionLifetime; document: RetrievalDocument; selectionIdentity: string; extractionIdentity: string
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
      contentVersion: value.contentVersion, pageCount: value.pageCount }
    const extractionIdentity = ports.pages.identity?.(sessionId) ?? ''
    if (typeof extractionIdentity !== 'string' || extractionIdentity.length > 16_384) {
      throw fail('pdf/retrieval-extraction-failed', 'PDF extraction identity is invalid')
    }
    const binding = { sessionId, document, provider, selectionIdentity, extractionIdentity, signal, lifetime }
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
      const complete = index.bm25 && !index.failures.size && index.pages.size === index.toPage - index.fromPage + 1
        && (!index.provider || index.vectors.size === index.chunks.length)
      const computedChunks = index.computedChunks - computedAtStart
      const progress: RetrievalProgress = { indexedPages: index.pages.size, totalPages: index.toPage - index.fromPage + 1,
        embeddedChunks: index.vectors.size, totalChunks: index.chunks.length,
        phase: complete ? 'ready' : index.phase, reusedChunks: index.vectors.size - computedChunks, computedChunks }
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

  async function readPage(index: Index, page: number, source: SharedRetrievalSource): Promise<void> {
    source.check()
    phase(index, 'restoring')
    const key = pageCacheKey(source.current().document.path, index.sourceDigest, page, index.extractionIdentity)
    if (index.refreshing && await readCachedPage(ports.cache, key)) {
      source.check()
      // Invalidate old completeness before starting a refresh, including reads
      // that throw before they can return an explicit partial representation.
      await cacheDerived(ports.cache, key, null)
      source.check()
    }
    let pageFailure: z.infer<typeof pageFailureSchema> | undefined
    let cached = index.refreshing ? undefined : await readCachedPage(ports.cache, key)
    source.check()
    if (!cached) {
      phase(index, 'extracting')
      const result = await source.read(page)
      source.check()
      if (result.text.length > 500_000 || (result.units ?? []).reduce((sum, unit) => sum + unit.text.length, 0) > 500_000) {
        throw fail('pdf/retrieval-budget', 'PDF page content exceeds the indexing budget')
      }
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
      // Partial content stays usable in this bounded index, but no incomplete
      // page snapshot may become a persistent success record.
      if (!pageFailure) await cacheDerived(ports.cache, key, cached)
      else if (await readCachedPage(ports.cache, key)) {
        source.check()
        // Refresh may replace an earlier successful extraction. A disposable
        // tombstone prevents its obsolete completeness claim surviving restart.
        await cacheDerived(ports.cache, key, null)
      }
      source.check()
    }
    const chunks = chunkRetrievalPage(page, cached,
      { maxCharacters: Math.min(1200, index.provider?.maxInputCharacters ?? 1200) })
    if (index.chunks.length + chunks.length > limits.maxChunks) {
      throw fail('pdf/retrieval-budget', 'PDF contains too many text chunks; search a smaller page range')
    }
    // Repeated words update one term/chunk posting, rather than allocating one
    // posting per token. The hard chunk cap supplements estimated JS overhead.
    reserve(index, 128 + (cached.paragraphBreaks?.length ?? 0) * 8
      + (cached.warnings ?? []).reduce((sum, warning) => sum + warning.length * 2 + 32, 0)
      + chunks.reduce((sum, chunk) => sum + chunk.text.length * 2 + 320
        + (chunk.representation ? JSON.stringify(chunk.representation).length * 2 + 128 : 0)
        + new Set(tokenizeRetrievalText(chunk.text)).size * 96, 0))
    index.chunks.push(...chunks)
    index.pages.add(page)
    if (pageFailure) index.failures.set(page, { page, attempts: 1, code: pageFailure.code })
    else index.failures.delete(page)
    if (!chunks.some(chunk => chunk.source !== 'image-description')) index.noText.push(page)
    if (cached.units ? chunks.some(chunk => chunk.source === 'ocr') : cached.source === 'ocr') index.ocr.push(page)
    if (chunks.some(chunk => chunk.source === 'image-description')) index.descriptions.push(page)
    if (cached.warnings?.length) index.warnings.push({ page, warnings: cached.warnings })
    notifyProgress(index)
  }

  async function embedStep(index: Index, source: SharedRetrievalSource): Promise<void> {
    if (!index.provider) return
    const provider = index.provider
    const pending = index.chunks.filter(chunk => !index.vectors.has(chunk.id))
    if (pending.length) phase(index, 'restoring')
    const batchSize = Math.min(16, provider.maxBatchSize)
    let batches = 0
    let scanned = 0
    const byText = new Map<string, RetrievalChunk[]>()
    const retainVector = (key: string, input: number[]) => {
      const previous = index.vectorPool.get(key)
      if (previous) return previous
      const vector = compactRetrievalVector(input)
      // Chunk maps only reference pooled storage. Repeated text is charged once,
      // whether its embedding came from this batch or the persistent JSON cache.
      // Include the retained cache key, pool entry and typed-array wrapper too.
      reserve(index, vector.byteLength + 320)
      index.vectorPool.set(key, vector)
      return vector
    }
    async function flush(): Promise<void> {
      if (!byText.size) return
      const rows = [...byText.entries()]
      phase(index, 'embedding')
      const vectors = await source.embed(rows.map(([, chunks]) => chunks[0].text))
      source.check()
      if (vectors.length !== rows.length || vectors.some(vector => !validVector(vector, provider.dimensions))) {
        throw fail('pdf/retrieval-invalid-vector', 'Embedding provider returned invalid vectors')
      }
      for (let i = 0; i < rows.length; i++) {
        const [key, chunks] = rows[i]
        const vector = retainVector(key, vectors[i])
        for (const chunk of chunks) { index.vectors.set(chunk.id, vector); index.computedChunks++ }
        await cacheDerived(ports.cache, key, encodeCachedVector(vectors[i]!))
        source.check()
      }
      batches++
      byText.clear()
      notifyProgress(index)
    }
    for (const chunk of pending) {
      source.check()
      if (batches >= limits.embeddingBatchesPerStep || scanned++ >= 512) break
      const provider = source.current().provider!
      const modelKey = provider.documentFingerprint ?? (provider.configurationIdentity === undefined ? provider.fingerprint
        : digest(JSON.stringify([provider.fingerprint, provider.configurationIdentity])))
      const key = retrievalCacheKey('vector', modelKey, 'document', digest(chunk.text))
      const pooled = index.vectorPool.get(key)
      if (pooled) {
        index.vectors.set(chunk.id, pooled)
        if (index.vectors.size % batchSize === 0) notifyProgress(index)
        continue
      }
      phase(index, 'restoring')
      const cached = index.refreshing ? undefined : await readCachedVector(ports.cache, key, provider.dimensions)
      source.check()
      if (cached) {
        index.vectors.set(chunk.id, retainVector(key, cached))
        if (index.vectors.size % batchSize === 0) notifyProgress(index)
      } else {
        const rows = byText.get(key) ?? []
        rows.push(chunk); byText.set(key, rows)
        if (byText.size >= batchSize) await flush()
      }
    }
    await flush()
    notifyProgress(index)
  }

  async function step(index: Index, source: SharedRetrievalSource): Promise<void> {
    phase(index, 'restoring')
    const todo = index.nextPage <= index.toPage
      ? Array.from({ length: Math.min(limits.pagesPerStep, index.toPage - index.nextPage + 1) }, (_, i) => index.nextPage + i)
      // A partial page is an immutable usable snapshot until explicit rebuild.
      // Retrying it in-place would mix representations and duplicate chunk IDs.
      : [...index.failures.keys()].filter(page => !index.pages.has(page)).slice(0, limits.pagesPerStep)
    for (const page of todo) {
      try { await readPage(index, page, source) } catch (error) {
        source.check()
        const critical = fatalContentError(error)
        if (critical !== undefined) throw critical
        const code = codeOf(error)
        if (code === 'pdf/retrieval-budget') throw error
        index.failures.set(page, { page, attempts: (index.failures.get(page)?.attempts ?? 0) + 1, code })
      }
      index.nextPage = Math.max(index.nextPage, page + 1)
      // Give interactive requests and cancellation a turn between native page reads.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      source.check()
    }
    await embedStep(index, source)
    source.check()
    if (!index.bm25 && index.pages.size === index.toPage - index.fromPage + 1) {
      // Keep the initial lexical build inside the shared job too: concurrent
      // searches must not allocate duplicate posting maps for the same index.
      index.bm25 = await createBm25IndexCooperatively(index.chunks, source.signal, source.check)
    }
    if (index.bm25 && index.pages.size === index.toPage - index.fromPage + 1
      && (!index.provider || index.vectors.size === index.chunks.length)) index.refreshing = false
    notifyProgress(index)
  }

  function joinStep(index: Index, binding: RetrievalBinding): Promise<void> {
    const signal = binding.signal
    let job = jobs.get(index.key)
    if (job?.controller.signal.aborted) throw fail('pdf/retrieval-busy', 'The previous indexing step is still cancelling; retry shortly')
    if (!job) {
      if (jobs.size >= limits.maxConcurrentJobs) throw fail('pdf/retrieval-busy', 'Other PDF indexes are being built; retry shortly')
      const controller = new AbortController()
      const created: Job = { controller, subscribers: new Set(), promise: Promise.resolve() }
      // Defer execution until the job is registered and subscribers are attached.
      created.promise = Promise.resolve().then(async () => {
        const source = createSharedRetrievalSource(ports, created.subscribers, controller.signal,
          () => checkIndex(index, controller.signal), checkBinding, checkOrigin)
        try { await step(index, source) } finally { source.dispose() }
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
        finish(fail(codeOf(error), 'The shared PDF indexing step could not complete.'))
      })
    })
  }

  function parseCursor(token: string): z.infer<typeof cursorSchema> {
    try {
      const decoded = Buffer.from(token, 'base64url')
      if (decoded.toString('base64url') !== token) throw new Error('Invalid encoding')
      return cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
    } catch { throw fail('pdf/invalid-window', 'Invalid retrieval cursor; restart the search') }
  }

  function getIndex(binding: RetrievalBinding, query: Pick<Query, 'documentId' | 'fromPage' | 'maxPages' | 'cursor'>): Index {
    const { document, provider, selectionIdentity, extractionIdentity } = binding
    if (!Number.isSafeInteger(document.pageCount) || document.pageCount < query.fromPage) throw fail('pdf/invalid-page', 'Requested page is outside the PDF')
    const toPage = Math.min(document.pageCount, query.fromPage + (query.maxPages ?? document.pageCount) - 1)
    // Working-copy IDs, paths and contentVersion UUIDs are caller-local. Only
    // immutable source/encoding identity belongs to the shared derived index.
    const key = digest(JSON.stringify([document.sourceDigest, document.pageCount, query.fromPage, toPage,
      selectionIdentity, provider ? 'vectors' : 'lexical', RETRIEVAL_EXTRACTION_VERSION, RETRIEVAL_TEXT_VERSION,
      ...(extractionIdentity ? [extractionIdentity] : [])]))
    let index = indexes.get(key)
    if (!index && query.cursor) throw stale('PDF search index expired or its document/engine changed; start a new search with documentId and query')
    if (!index) {
      index = { key, sourceDigest: document.sourceDigest, pageCount: document.pageCount, fromPage: query.fromPage, toPage, generation: randomUUID(),
        provider: provider && { dimensions: provider.dimensions, maxBatchSize: provider.maxBatchSize,
          maxInputCharacters: provider.maxInputCharacters }, selectionIdentity, extractionIdentity,
        chunks: [], vectors: new Map(), vectorPool: new Map(), pages: new Set(), nextPage: query.fromPage,
        noText: [], ocr: [], descriptions: [], warnings: [], failures: new Map(), bytes: 0, lastUsed: Date.now(), users: 0,
        phase: 'restoring', computedChunks: 0, progress: new Set(),
        refreshing: [...indexes.values()].some(other => other.refreshing && sameIndexSource(other, binding)) }
      indexes.set(key, index)
      try { reserve(index, 0) } catch (error) { indexes.delete(key); throw error }
    }
    index.lastUsed = Date.now()
    return index
  }

  function sameIndexSource(index: Index, binding: RetrievalBinding): boolean {
    return index.sourceDigest === binding.document.sourceDigest && index.pageCount === binding.document.pageCount
      && index.extractionIdentity === binding.extractionIdentity
  }

  async function rebuildIndex(binding: RetrievalBinding, scope: z.infer<typeof prepareSchema>): Promise<Index> {
    for (;;) {
      checkBinding(binding)
      const previous = [...indexes.values()].filter(index => sameIndexSource(index, binding))
      const active = previous.flatMap(index => { const job = jobs.get(index.key); return job ? [job.promise] : [] })
      if (active.length) { await waitForWork(active, binding.signal); continue }
      // No matching build can still publish old derived data. Other documents
      // and engines retain their ready indexes and running work.
      for (const index of previous) indexes.delete(index.key)
      const index = getIndex(binding, scope)
      index.refreshing = true
      return index
    }
  }

  return {
    state() { return disposed ? 'disposed' : rebuilding ? 'rebuilding' : rebuildFailed ? 'failed' : 'ready' },
    async prepare(sessionId, input: RetrievalPrepareInput, externalSignal, onProgress) {
      if (disposed) throw cancelled()
      if (rebuilding) throw fail('pdf/retrieval-busy', 'PDF search indexes are being reset; retry shortly')
      if (rebuildFailed) throw fail('pdf/retrieval-cache-unavailable', 'PDF index reset failed; retry rebuilding the index before searching')
      if (preparations.size >= limits.maxConcurrentQueries) throw fail('pdf/retrieval-busy', 'Too many background PDF preparations are waiting; retry shortly')
      const scope = prepareSchema.parse(input)
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
        const index = scope.rebuild ? await rebuildIndex(binding, scope) : getIndex(binding, scope)
        index.users++; activeIndex = index
        guard(index, binding)
        stopProgress = observeProgress(index, signal, onProgress)
        while (!index.bm25 || index.pages.size < index.toPage - index.fromPage + 1 || index.vectors.size < index.chunks.length) {
          let shared: Promise<void> | undefined
          while (!shared) {
            guard(index, binding)
            try { shared = joinStep(index, binding) } catch (error) {
              if (codeOf(error) !== 'pdf/retrieval-busy') throw error
              // Foreground searches keep their fast-busy admission. Background
              // work waits for an existing real step to free capacity instead
              // of turning temporary load into a permanently failed prebuild.
              await waitForWork([...jobs.values()].map(job => job.promise), signal)
            }
          }
          await shared
          guard(index, binding)
          if (index.nextPage > index.toPage && [...index.failures.values()].some(failure => failure.attempts >= 2)) {
            throw fail('pdf/retrieval-incomplete', 'Some PDF pages could not be indexed; retry with a smaller page range or inspect the source')
          }
          // Background preparation cooperates with interactive work between
          // bounded shared steps; it never generates a synthetic search query.
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          guard(index, binding)
        }
        guard(index, binding)
        if (index.failures.size) throw fail('pdf/retrieval-incomplete', 'Some optional PDF content could not be indexed; rebuild the document index to retry')
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
    },
    async search(sessionId, input: RetrievalInput, externalSignal) {
      if (disposed) throw cancelled()
      if (rebuilding) throw fail('pdf/retrieval-busy', 'PDF search indexes are being reset; retry shortly')
      if (rebuildFailed) throw fail('pdf/retrieval-cache-unavailable', 'PDF index reset failed; retry rebuilding the index before searching')
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
        const index = getIndex(binding, query)
        index.users++; activeIndex = index
        const bindingHash = digest(JSON.stringify([sessionId, lifetime.id, binding.document,
          ...(binding.extractionIdentity ? [binding.extractionIdentity] : [])]))
        const queryHash = digest(JSON.stringify([query.query, query.terms, query.topK, query.mode, query.fromPage, query.maxPages ?? null]))
        if (query.cursor) {
          const cursor = parseCursor(query.cursor)
          if (cursor.key !== index.key || cursor.generation !== index.generation) {
            throw stale('PDF search progress no longer matches the active index; start a new search with documentId and query')
          }
          if (cursor.binding !== bindingHash) throw stale('PDF search progress belongs to another Session or document binding; start a new search')
          if (cursor.query !== queryHash) throw fail('pdf/invalid-window', 'PDF search parameters do not match its saved progress; start a new search')
        }
        guard(index, binding)
        if (!index.bm25 || index.pages.size < index.toPage - index.fromPage + 1 || (provider && index.vectors.size < index.chunks.length)) {
          await joinStep(index, binding)
        }
        guard(index, binding)
        const ready = !!index.bm25 && index.pages.size === index.toPage - index.fromPage + 1 && (!provider || index.vectors.size === index.chunks.length)
        const complete = ready && !index.failures.size
        const result: RetrievalResult = {
          status: complete ? 'complete' : (ready || index.nextPage > index.toPage) && index.failures.size ? 'incomplete' : 'building',
          requestedMode: query.mode, effectiveMode, ...(query.mode === 'auto' && !provider ? { fallbackReason: 'embedding-engine-unavailable' } : {}),
          indexGeneration: index.generation, document: { ...binding.document }, scope: { fromPage: index.fromPage, toPage: index.toPage },
          coverage: { indexedPages: index.pages.size, totalPages: index.toPage - index.fromPage + 1,
            noTextPages: [...index.noText], ocrPages: [...index.ocr], imageDescriptionPages: [...index.descriptions], failedPages: [...index.failures.values()].map(value => ({ ...value })),
            qualityWarnings: index.warnings.map(value => ({ page: value.page, warnings: [...value.warnings] })),
            embeddedChunks: index.vectors.size, totalChunks: index.chunks.length, visual: index.descriptions.length ? 'image-descriptions' : 'not-indexed' },
          chunks: [],
        }
        results.set(result, { sessionId, lifetime, document: { ...binding.document }, selectionIdentity, extractionIdentity: binding.extractionIdentity })
        if (!ready) {
          result.nextCursor = Buffer.from(JSON.stringify({ version: 2, key: index.key, generation: index.generation,
            binding: bindingHash, query: queryHash })).toString('base64url')
          return result
        }
        // A page can have many alternative representations of one block. Rank
        // the bounded projected corpus before collapsing them so duplicates do
        // not consume the candidate window and hide another block entirely.
        const fetchCount = index.chunks.some(chunk => chunk.representation) ? index.chunks.length : Math.max(30, query.topK * 4)
        const check = () => guard(index, binding)
        let lexical: RankedChunk[] = []
        if (effectiveMode !== 'semantic') {
          lexical = await searchBm25Cooperatively(index.bm25!, [query.query, ...query.terms].join(' '), fetchCount, signal, check)
        }
        let vectors: RankedChunk[] = []
        if (provider) {
          if (query.query.length > (provider.maxInputCharacters ?? Infinity)) throw fail('pdf/retrieval-query-too-long', 'Query exceeds the embedding model input limit')
          const embedded = await provider.embed([query.query], 'query', signal)
          guard(index, binding)
          if (embedded.length !== 1 || !validVector(embedded[0], provider.dimensions)) throw fail('pdf/retrieval-invalid-vector', 'Embedding provider returned an invalid query vector')
          vectors = await rankVectorsCooperatively(embedded[0], [...index.vectors].map(([chunkId, vector]) => ({ chunkId, vector })), fetchCount, signal, check)
        }
        ;[lexical, vectors] = collapseRepresentations([lexical, vectors], index.chunks)
        const ranked = effectiveMode === 'hybrid' ? hybridCandidates(lexical, vectors, query.topK)
          : (effectiveMode === 'semantic' ? vectors : lexical).slice(0, query.topK)
        const chunksById = new Map(index.chunks.map(chunk => [chunk.id, chunk]))
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
      const task = Promise.resolve().then(async () => {
        await Promise.allSettled(active)
        if (disposed) throw cancelled()
        await ports.cache?.clear?.()
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
      active = [...jobs.values()].map(job => job.promise).concat([...pendingQueries])
      return task
    },
    async dispose() {
      disposed = true
      for (const controller of preparations.keys()) controller.abort(cancelled())
      for (const controller of queries.keys()) controller.abort(cancelled())
      for (const job of jobs.values()) job.controller.abort(cancelled())
      indexes.clear()
      for (const lifetime of sessions.values()) lifetime.valid = false
      sessions.clear()
      await Promise.allSettled([...jobs.values()].map(job => job.promise).concat([...pendingQueries]))
      await rebuilding?.catch(() => undefined)
    },
  }
}
