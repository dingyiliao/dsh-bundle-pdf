import { z } from 'zod'
import { digest, decodeCachedVector, encodeCachedVector, validVector, validateRetrievalPage, type CachedRetrievalPage,
  type CachedRetrievalVector } from './cache.js'
import { chunkRetrievalPage, type RetrievalChunk } from './text.js'
import type { RetrievalCache } from './types.js'

const generation = z.object({ id: z.string().uuid(), rebuildToken: z.string().min(1).max(2048).optional() }).strict()
const headSchema = z.object({ version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/),
  active: generation.optional(), pending: generation.optional(), seeds: z.array(generation).max(8).optional(),
  retired: z.array(generation).max(1024).optional() }).strict()
const shardSchema = z.object({ version: z.literal(1), page: z.number().int().positive(), generation: z.string().uuid(),
  content: z.unknown(), vectors: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.unknown()),
  failure: z.object({ code: z.string().min(1).max(128), attempts: z.number().int().positive() }).strict().optional(),
}).strict()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const recordKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const vectorRefSchema = z.object({ key: recordKeySchema, sha256: hashSchema }).strict()
const summarySchema = z.object({ dataVersion: hashSchema, chunks: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(), noText: z.boolean(), ocr: z.boolean(), descriptions: z.boolean(),
  warnings: z.array(z.string().max(500)).max(20),
  failure: z.object({ page: z.number().int().positive(), code: z.string().min(1).max(128),
    attempts: z.number().int().positive() }).strict().optional() }).strict()
const splitShardSchema = z.object({ version: z.literal(2), page: z.number().int().positive(), generation: z.string().uuid(),
  contentKey: z.string().regex(/^index_content_[a-f0-9]{64}$/),
  chunkIds: z.array(hashSchema), vectorRefs: z.record(hashSchema, vectorRefSchema), summary: summarySchema,
}).strict()
export type StoredIndexHead = z.infer<typeof headSchema>
export type StoredIndexGeneration = z.infer<typeof generation>
export interface StoredIndexPage {
  version: 1
  page: number
  generation: string
  content: CachedRetrievalPage
  vectors: Record<string, CachedRetrievalVector>
  failure?: { code: string; attempts: number }
}
export interface StoredIndexPageLocation {
  contentKey: string
  vectorRefs: Record<string, { key: string; sha256: string }>
}
// A loaded immutable page may be committed after several embedding batches.
// Its geometry is serialized once; replacing content invalidates this shortcut.
const contentKeys = new WeakMap<CachedRetrievalPage, string>()
export interface IndexPageSummary {
  dataVersion: string
  chunks: number
  embedded: number
  noText: boolean
  ocr: boolean
  descriptions: boolean
  warnings: string[]
  failure?: { page: number; code: string; attempts: number }
}
export const storedIndexHeadKey = (key: string) => `index_head_${key}`
export const storedIndexPageKey = (key: string, generation: string, page: number) =>
  `index_page_${digest(JSON.stringify([key, generation, page]))}`
const corrupt = () => Object.assign(new Error('The saved PDF index is damaged. Rebuild its index structure.'), { code: 'pdf/index-storage-corrupt' })
const missingContent = () => Object.assign(new Error('The saved PDF index content is missing. Resume indexing to repair it.'),
  { code: 'pdf/index-storage-missing' })
function splitHeader(value: unknown, generation: string, page: number) {
  const parsed = splitShardSchema.safeParse(value)
  if (!parsed.success || parsed.data.page !== page || parsed.data.generation !== generation) throw corrupt()
  const header = parsed.data, ids = new Set(header.chunkIds)
  if (ids.size !== header.chunkIds.length || ids.size !== header.summary.chunks
    || Object.keys(header.vectorRefs).some(id => !ids.has(id))
    || header.summary.embedded !== Object.keys(header.vectorRefs).length
    || header.summary.failure && header.summary.failure.page !== page
    || header.summary.dataVersion !== indexDataVersion(header.chunkIds, header.vectorRefs,
      header.summary.failure ? { code: header.summary.failure.code, attempts: header.summary.failure.attempts } : undefined,
      header.summary.warnings)) throw corrupt()
  return header
}
function cachedVector(value: unknown, dimensions: number) {
  // Historical standalone caches could persist JSON arrays. Migrate those
  // once to the normalized wire record; modern records retain their exact bytes.
  const encoded = validVector(value, dimensions) ? encodeCachedVector(value) : value as CachedRetrievalVector
  const decoded = decodeCachedVector(encoded, dimensions)
  return decoded ? { encoded: { ...encoded }, decoded } : undefined
}

export async function readIndexHead(cache: RetrievalCache, key: string): Promise<StoredIndexHead | undefined> {
  const value = await cache.get(storedIndexHeadKey(key))
  if (value === undefined || value === null) return undefined
  const parsed = headSchema.safeParse(value)
  if (!parsed.success || parsed.data.key !== key || !parsed.data.active && !parsed.data.pending) throw corrupt()
  return parsed.data
}
export async function readIndexPage(cache: RetrievalCache, key: string, generation: string, page: number,
  dimensions: number | undefined, maxCharacters: number): Promise<{ record: StoredIndexPage; chunks: RetrievalChunk[];
    vectors: Map<string, Float32Array>; location?: StoredIndexPageLocation } | undefined> {
  const value = await cache.get(storedIndexPageKey(key, generation, page))
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && 'version' in value && value.version === 2) {
    const header = splitHeader(value, generation, page), rawContent = await cache.get(header.contentKey)
    if (rawContent === undefined || rawContent === null) throw missingContent()
    const content = validateRetrievalPage(rawContent)
    if (!content || header.contentKey !== `index_content_${digest(JSON.stringify(rawContent))}`) throw corrupt()
    contentKeys.set(content, header.contentKey)
    const chunks = chunkRetrievalPage(page, content, { maxCharacters })
    if (JSON.stringify(header.chunkIds) !== JSON.stringify(chunks.map(chunk => chunk.id))) throw corrupt()
    const vectors = new Map<string, Float32Array>(), encoded: Record<string, CachedRetrievalVector> = Object.create(null)
    const refs: StoredIndexPageLocation['vectorRefs'] = Object.create(null)
    if (dimensions !== undefined) for (const [id, reference] of Object.entries(header.vectorRefs)) {
      const vector = cachedVector(await cache.get(reference.key), dimensions)
      if (!vector || vector.encoded.sha256 !== reference.sha256) continue
      vectors.set(id, Float32Array.from(vector.decoded)); encoded[id] = vector.encoded; refs[id] = reference
    }
    const record: StoredIndexPage = { version: 1, page, generation, content, vectors: encoded,
      ...(header.summary.failure ? { failure: { code: header.summary.failure.code, attempts: header.summary.failure.attempts } } : {}) }
    // The header describes what was committed, not what damaged/missing vector
    // records still provide. Recompute counts from the independently verified data.
    const summary = summarizeIndexPage(record, chunks, vectors.size)
    if (header.summary.chunks !== chunks.length || header.summary.noText !== summary.noText || header.summary.ocr !== summary.ocr
      || header.summary.descriptions !== summary.descriptions || header.summary.failure?.page !== (record.failure ? page : undefined)
      || JSON.stringify(header.summary.warnings) !== JSON.stringify(summary.warnings)) throw corrupt()
    return { record, chunks, vectors, location: { contentKey: header.contentKey, vectorRefs: refs } }
  }
  const parsed = shardSchema.safeParse(value)
  if (!parsed.success || parsed.data.page !== page || parsed.data.generation !== generation) throw corrupt()
  const content = validateRetrievalPage(parsed.data.content)
  if (!content) throw corrupt()
  const chunks = chunkRetrievalPage(page, content, { maxCharacters })
  const ids = new Set(chunks.map(chunk => chunk.id)), vectors = new Map<string, Float32Array>()
  const encoded: Record<string, CachedRetrievalVector> = Object.create(null)
  for (const [id, value] of Object.entries(parsed.data.vectors)) {
    if (!ids.has(id) || dimensions === undefined) continue
    const vector = cachedVector(value, dimensions)
    // A damaged vector can be repaired from its independent cache, or computed
    // again. A checkpoint must never claim this chunk is already embedded.
    if (!vector) continue
    vectors.set(id, Float32Array.from(vector.decoded)); encoded[id] = vector.encoded
  }
  return { record: { version: 1, page, generation, content, vectors: encoded,
    ...(parsed.data.failure ? { failure: parsed.data.failure } : {}) }, chunks, vectors }
}
/** Restore coverage without materializing page text or glyph geometry. Stores
 * lacking a cheap existence probe retain the full-read validation path. */
export async function readIndexSummary(cache: RetrievalCache, key: string, generation: string, page: number,
  dimensions: number | undefined, maxCharacters: number): Promise<IndexPageSummary | undefined> {
  const full = async () => {
    const loaded = await readIndexPage(cache, key, generation, page, dimensions, maxCharacters)
    return loaded ? summarizeIndexPage(loaded.record, loaded.chunks, loaded.vectors.size) : undefined
  }
  if (!cache.has) return full()
  const value = await cache.get(storedIndexPageKey(key, generation, page))
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || !('version' in value) || value.version !== 2) return full()
  const header = splitHeader(value, generation, page)
  if (!await cache.has(header.contentKey)) throw missingContent()
  const valid: StoredIndexPageLocation['vectorRefs'] = Object.create(null)
  if (dimensions !== undefined) for (const [id, reference] of Object.entries(header.vectorRefs)) {
    const vector = cachedVector(await cache.get(reference.key), dimensions)
    if (vector?.encoded.sha256 === reference.sha256) valid[id] = reference
  }
  return { ...header.summary, embedded: Object.keys(valid).length,
    dataVersion: indexDataVersion(header.chunkIds, valid,
      header.summary.failure ? { code: header.summary.failure.code, attempts: header.summary.failure.attempts } : undefined,
      header.summary.warnings) }
}
/** Content and vectors are immutable records. The final small header is the
 * checkpoint; callers commit entries in this order (or in one transaction). */
export function buildIndexPageEntries(key: string, generation: string, record: StoredIndexPage, chunks: readonly RetrievalChunk[],
  previous?: StoredIndexPageLocation, newVectorKeys: Record<string, string> = {}) {
  const entries: Array<readonly [string, unknown]> = []
  let contentKey = previous?.contentKey
  if (!contentKey || contentKeys.get(record.content) !== contentKey) {
    contentKey = `index_content_${digest(JSON.stringify(record.content))}`
    entries.push([contentKey, record.content]); contentKeys.set(record.content, contentKey)
  }
  const refs: StoredIndexPageLocation['vectorRefs'] = Object.create(null), ids = new Set(chunks.map(chunk => chunk.id))
  const fallbackKeys = new Set<string>()
  for (const [id, vector] of Object.entries(record.vectors)) {
    if (!ids.has(id) || !hashSchema.safeParse(vector.sha256).success) throw corrupt()
    const existing = previous?.vectorRefs[id]
    const vectorKey = newVectorKeys[id] ?? (existing?.sha256 === vector.sha256 ? existing.key : undefined)
    if (vectorKey) {
      if (!recordKeySchema.safeParse(vectorKey).success) throw corrupt()
      refs[id] = { key: vectorKey, sha256: vector.sha256 }
    } else {
      const fallback = `index_vector_${vector.sha256}`
      refs[id] = { key: fallback, sha256: vector.sha256 }
      if (!fallbackKeys.has(fallback)) { entries.push([fallback, vector]); fallbackKeys.add(fallback) }
    }
  }
  const location: StoredIndexPageLocation = { contentKey, vectorRefs: refs }
  entries.push([storedIndexPageKey(key, generation, record.page), { version: 2, page: record.page, generation, ...location,
    chunkIds: chunks.map(chunk => chunk.id), summary: summarizeIndexPage(record, chunks, Object.keys(refs).length) }])
  return { entries, location }
}
export function summarizeIndexPage(record: StoredIndexPage, chunks: readonly RetrievalChunk[], embedded: number): IndexPageSummary {
  return { dataVersion: pageDataVersion(record, chunks, record.vectors),
    chunks: chunks.length, embedded, noText: !chunks.some(chunk => chunk.source !== 'image-description'),
    ocr: chunks.some(chunk => chunk.source === 'ocr'), descriptions: chunks.some(chunk => chunk.source === 'image-description'),
    warnings: record.content.warnings ?? [], ...(record.failure ? { failure: { page: record.page, ...record.failure } } : {}) }
}
function pageDataVersion(record: StoredIndexPage, chunks: readonly RetrievalChunk[],
  vectors: Record<string, { sha256: string }>): string {
  return indexDataVersion(chunks.map(chunk => chunk.id), vectors, record.failure, record.content.warnings ?? [])
}
function indexDataVersion(chunkIds: readonly string[], vectors: Record<string, { sha256: string }>,
  failure: StoredIndexPage['failure'], warnings: readonly string[]): string {
  return digest(JSON.stringify([chunkIds, Object.entries(vectors).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, vector]) => [id, vector.sha256]), failure ?? null, warnings]))
}

/** Standalone callers may supply an ephemeral store. Host always supplies the
 * filesystem store; this fallback has a hard storage bound and never evicts a
 * successful checkpoint behind the service's back. */
export function createVolatileIndexStore(maxBytes: number): RetrievalCache {
  const records = new Map<string, { value: unknown; bytes: number }>()
  let bytes = 0
  return {
    async get(key) { return structuredClone(records.get(key)?.value) },
    async set(key, value) {
      const size = Buffer.byteLength(JSON.stringify(value)), next = bytes - (records.get(key)?.bytes ?? 0) + size
      if (next > maxBytes) throw Object.assign(new Error('Supply a persistent store for this PDF index.'),
        { code: 'pdf/index-storage-limit', budget: { kind: 'record', limit: maxBytes, used: bytes, requested: size } })
      records.set(key, { value: structuredClone(value), bytes: size }); bytes = next
    },
    async clear() { records.clear(); bytes = 0 },
    async delete(key) { bytes -= records.get(key)?.bytes ?? 0; records.delete(key) },
  }
}
