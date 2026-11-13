import { fatalContentError, pageContentCacheIdentity } from '../document/index.js'
import { cacheDerived, pageCacheKey, readCachedPage,
  validateRetrievalPage, type PageCacheSource } from './cache.js'
import { chunkRetrievalPage, tokenizeRetrievalText, type RetrievalChunk } from './text.js'
import { buildIndexPageEntries, readIndexPage, type StoredIndexHead, type StoredIndexPage, type IndexPageSummary } from './stored-index.js'
import { measureIndexOperation, recordIndexPerformance } from './performance.js'
import { pageFailureSchema, type PageFailure } from './validation.js'
import type { RetrievalPorts } from './types.js'

export interface PagePipelineIndex {
  persistentKey: string
  generation: string
  contentDigest: string
  extractionIdentity: string
  provider?: { dimensions: number; maxInputCharacters?: number }
  head: StoredIndexHead
  previousPageCacheSource?: PageCacheSource
  pages: Map<number, IndexPageSummary>
  chunkCount: number
}

export interface PagePipelineSource {
  check(): void
  current(): { document: { path: string; sourceDigest: string; pageCount: number; indexPageDigests?: readonly (string | null)[]; indexContentDigest?: string } }
  read(page: number): Promise<{ text: string; units?: readonly { text: string }[]; failure?: unknown; warnings?: readonly string[] }>
}

export interface PagePipelineContext {
  storage: NonNullable<RetrievalPorts['cache']>
  cache?: RetrievalPorts['cache']
  limits: { maxChunks: number }
  fail(code: string, message: string): Error
  codeOf(error: unknown): string
  isContentDigest(value: unknown): value is string
  characters(index: PagePipelineIndex): number
  phase(index: PagePipelineIndex, phase: 'restoring' | 'extracting'): void
  reserve(index: PagePipelineIndex, bytes: number): void
  summarize(index: PagePipelineIndex, record: StoredIndexPage, chunks: readonly RetrievalChunk[], embedded: number): void
  notifyProgress(index: PagePipelineIndex): void
  loadPage(index: PagePipelineIndex, page: number): Promise<Awaited<ReturnType<typeof readIndexPage>>>
  writeMany(entries: readonly (readonly [string, unknown])[]): Promise<void>
}

/** Restore or extract one page, then persist its content and geometry checkpoint. */
export async function readIndexPagePipeline(
  index: PagePipelineIndex,
  page: number,
  source: PagePipelineSource,
  context: PagePipelineContext,
): Promise<void> {
  source.check(); context.phase(index, 'restoring')
  let stored: Awaited<ReturnType<typeof readIndexPage>>
  try { stored = await context.loadPage(index, page) }
  catch (error) { if (context.codeOf(error) !== 'pdf/index-storage-missing') throw error }
  source.check()
  if (!stored) for (const seed of index.head.seeds ?? (index.head.active ? [index.head.active] : [])) {
    if (seed.id === index.generation) continue
    let previous: Awaited<ReturnType<typeof readIndexPage>>
    try { previous = await readIndexPage(context.storage, index.persistentKey, seed.id, page, index.provider?.dimensions, context.characters(index)) }
    catch (error) {
      if (!['pdf/index-storage-corrupt', 'pdf/index-storage-missing'].includes(context.codeOf(error))) throw error
      continue
    }
    source.check()
    if (!previous) continue
    stored = { ...previous, record: { ...previous.record, generation: index.generation } }
    await context.writeMany(buildIndexPageEntries(index.persistentKey, index.generation, stored.record, stored.chunks, stored.location).entries)
    source.check(); break
  }
  if (stored && !stored.record.failure) {
    recordIndexPerformance({ stage: 'page-cache', durationMs: 0, records: 1, cacheHit: true })
    context.summarize(index, stored.record, stored.chunks, stored.vectors.size)
    return
  }
  const document = source.current().document
  const pageDigest = document.indexPageDigests?.[page - 1]
  const cacheKey = (content: string) => pageCacheKey(document.path, content, page, index.extractionIdentity)
  const key = cacheKey(pageContentCacheIdentity({ ...document, indexPageDigest: pageDigest }))
  let cached = stored?.record.failure ? undefined : await readCachedPage(context.cache, key)
  source.check()
  const previousCacheSource = index.previousPageCacheSource
  const sameSource = previousCacheSource && context.isContentDigest(document.sourceDigest)
    && previousCacheSource.sourceDigest === document.sourceDigest && previousCacheSource.indexPageDigests.length === document.pageCount
  if (!cached && (pageDigest || sameSource) && !stored?.record.failure) {
    const keys = new Set([index.contentDigest, document.sourceDigest])
    if (pageDigest && previousCacheSource?.indexPageDigests[page - 1] === pageDigest) {
      if (previousCacheSource.indexContentDigest) keys.add(previousCacheSource.indexContentDigest)
      keys.add(previousCacheSource.sourceDigest)
    }
    if (sameSource) keys.add(pageContentCacheIdentity({ ...previousCacheSource, indexPageDigest: previousCacheSource.indexPageDigests[page - 1] }))
    for (const legacy of keys) {
      const legacyKey = cacheKey(legacy)
      if (legacyKey === key) continue
      try { cached = await readCachedPage(context.cache, legacyKey) }
      catch (error) {
        if (!['pdf/index-storage-corrupt', 'pdf/index-storage-missing'].includes(context.codeOf(error))) throw error
      }
      source.check()
      if (!cached) continue
      await cacheDerived(context.cache, key, cached)
      source.check(); break
    }
  }
  recordIndexPerformance({ stage: 'page-cache', durationMs: 0, records: 1, cacheHit: !!cached })
  let pageFailure: PageFailure | undefined
  if (!cached) {
    context.phase(index, 'extracting')
    const result = await measureIndexOperation('page-extraction', () => source.read(page), { records: 1 })
    source.check()
    const length = Math.max(result.text.length, (result.units ?? []).reduce((sum, unit) => sum + unit.text.length, 0))
    if (length > 500_000) throw Object.assign(context.fail('pdf/retrieval-page-budget', 'PDF page content exceeds its processing budget.'),
      { budget: { kind: 'page', limit: 500_000, used: 0, requested: length } })
    const { failure, ...content } = result
    if (failure !== undefined) {
      const parsed = pageFailureSchema.safeParse(failure)
      if (!parsed.success) throw context.fail('pdf/retrieval-extraction-failed', 'PDF extraction returned invalid partial failure metadata')
      if (fatalContentError(parsed.data) !== undefined) throw context.fail(parsed.data.code, 'PDF extraction lost its source authority or was cancelled')
      pageFailure = parsed.data
    }
    cached = validateRetrievalPage({ version: 1, ...content,
      ...(result.warnings?.length ? { warnings: result.warnings.slice(0, 20).map(value => value.slice(0, 500)) } : {}) })
    if (!cached) throw context.fail('pdf/retrieval-extraction-failed', 'PDF extraction returned invalid content representations or offsets')
    if (!pageFailure) await cacheDerived(context.cache, key, cached)
    source.check()
  }
  const chunks = chunkRetrievalPage(page, cached, { maxCharacters: context.characters(index) })
  const previous = index.pages.get(page)
  if (index.chunkCount - (previous?.chunks ?? 0) + chunks.length > context.limits.maxChunks) {
    throw Object.assign(context.fail('pdf/retrieval-chunks-budget', 'PDF index exceeds its configured chunk count limit.'),
      { budget: { kind: 'chunks', limit: context.limits.maxChunks, used: index.chunkCount - (previous?.chunks ?? 0), requested: chunks.length } })
  }
  const workingBytes = Buffer.byteLength(JSON.stringify(cached)) * 2 + chunks.reduce((sum, chunk) => sum
    + chunk.text.length * 2 + 320 + (chunk.representation ? JSON.stringify(chunk.representation).length * 2 : 0)
    + new Set(tokenizeRetrievalText(chunk.text)).size * 16, 0)
  context.reserve(index, workingBytes)
  const vectors = Object.create(null) as StoredIndexPage['vectors']
  for (const chunk of chunks) if (stored?.record.vectors[chunk.id]) vectors[chunk.id] = stored.record.vectors[chunk.id]
  const record: StoredIndexPage = { version: 1, page, generation: index.generation, content: cached, vectors,
    ...(pageFailure ? { failure: { code: pageFailure.code, attempts: (stored?.record.failure?.attempts ?? 0) + 1 } } : {}) }
  await context.writeMany(buildIndexPageEntries(index.persistentKey, index.generation, record, chunks).entries)
  source.check()
  context.summarize(index, record, chunks, Object.keys(vectors).length)
  context.notifyProgress(index)
}

