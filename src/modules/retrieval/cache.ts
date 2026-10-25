import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RETRIEVAL_TEXT_VERSION } from './text.js'
import type { RetrievalCache } from './types.js'

export const RETRIEVAL_EXTRACTION_VERSION = 'joined-page-text-v1'
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const retrievalCacheKey = (...values: unknown[]): string => `retrieval:${digest(JSON.stringify(values))}`

const pageSchema = z.object({
  version: z.literal(1), text: z.string().max(500_000),
  source: z.enum(['pdf-text', 'ocr']), warnings: z.array(z.string().max(500)).max(20).optional(),
}).strict()
export type CachedRetrievalPage = z.infer<typeof pageSchema>

export function pageCacheKey(path: string, sourceDigest: string, page: number): string {
  return retrievalCacheKey('page', RETRIEVAL_EXTRACTION_VERSION, RETRIEVAL_TEXT_VERSION, path, sourceDigest, page)
}

export async function readCachedPage(cache: RetrievalCache | undefined, key: string): Promise<CachedRetrievalPage | undefined> {
  if (!cache) return undefined
  try {
    const result = pageSchema.safeParse(await cache.get(key))
    return result.success ? result.data : undefined
  } catch { return undefined }
}

/** Derived caches are disposable; an unavailable cache must not break reading. */
export async function cacheDerived(cache: RetrievalCache | undefined, key: string, value: unknown): Promise<void> {
  try { await cache?.set(key, value) } catch { /* The next request can rebuild it. */ }
}

export function validVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && value.some(item => item !== 0)
}

export async function readCachedVector(cache: RetrievalCache | undefined, key: string, dimensions: number): Promise<number[] | undefined> {
  try {
    const value = await cache?.get(key)
    return validVector(value, dimensions) ? [...value] : undefined
  } catch { return undefined }
}
