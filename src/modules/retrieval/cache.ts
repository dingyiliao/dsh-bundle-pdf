import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MAX_RETRIEVAL_PARAGRAPH_BREAKS, RETRIEVAL_TEXT_VERSION, validParagraphBreaks } from './text.js'
import { compactRetrievalVector } from './vector.js'
import type { RetrievalCache } from './types.js'

export const RETRIEVAL_EXTRACTION_VERSION = 'page-content-v3-representations'
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
// DSH's per-record JSON backend requires filename-safe keys. A colon makes
// writes fail even though an in-memory RetrievalCache accepts the same key.
export const retrievalCacheKey = (...values: unknown[]): string => `retrieval_${digest(JSON.stringify(values))}`

const offsetSchema = z.number().int().nonnegative().max(500_000)
const rangeSchema = z.object({ startUtf16: offsetSchema, endUtf16: offsetSchema }).strict()
const rectSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(rect => rect[0] < rect[2] && rect[1] < rect[3], 'Invalid rectangle')
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const breaksSchema = z.array(z.number().int().positive()).max(MAX_RETRIEVAL_PARAGRAPH_BREAKS).optional()
const unitSchema = z.object({
  id: z.string().min(1).max(512), blockId: z.string().min(1).max(512),
  kind: z.enum(['native-text', 'ocr-text', 'image-description']), text: z.string().max(500_000), digest: digestSchema,
  paragraphBreaks: breaksSchema, nativeRange: rangeSchema.optional(), rectPdf: rectSchema.optional(),
  spans: z.array(z.object({ startUtf16: offsetSchema, endUtf16: offsetSchema, rectPdf: rectSchema }).strict()).max(50_000).optional(),
  producer: z.object({ id: z.string().min(1).max(512), version: z.string().max(512).optional(),
    model: z.string().max(512).optional(), configurationIdentity: z.string().max(4096).optional() }).strict().optional(),
  inputDigest: digestSchema.optional(),
}).strict()
function scalarOffset(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset)
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
}
const pageSchema = z.object({
  version: z.literal(1), text: z.string().max(500_000),
  source: z.enum(['pdf-text', 'ocr']), warnings: z.array(z.string().max(500)).max(20).optional(),
  paragraphBreaks: breaksSchema, units: z.array(unitSchema).max(10_000).optional(),
  contentIdentity: z.string().min(1).max(4096).optional(),
}).strict().superRefine((page, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message })
  if (!validParagraphBreaks(page.text, page.paragraphBreaks)) invalid('Invalid paragraph offsets')
  let characters = 0, spans = 0
  const ids = new Set<string>()
  for (const unit of page.units ?? []) {
    characters += unit.text.length; spans += unit.spans?.length ?? 0
    if (ids.has(unit.id)) invalid('Duplicate representation ID')
    ids.add(unit.id)
    if (unit.digest !== `sha256:${digest(unit.text)}`) invalid('Invalid representation digest')
    if (!validParagraphBreaks(unit.text, unit.paragraphBreaks)) invalid('Invalid representation paragraph offsets')
    if (unit.kind === 'native-text') {
      const range = unit.nativeRange
      if (!range || range.startUtf16 > range.endUtf16 || range.endUtf16 > page.text.length
        || !scalarOffset(page.text, range.startUtf16) || !scalarOffset(page.text, range.endUtf16)
        || page.text.slice(range.startUtf16, range.endUtf16) !== unit.text) invalid('Invalid native representation range')
    } else if (unit.nativeRange !== undefined) invalid('Generated representations cannot claim native text ranges')
    let previousSpanEnd = 0
    for (const span of unit.spans ?? []) {
      if (span.startUtf16 < previousSpanEnd) invalid('Representation spans must be ordered and nonoverlapping')
      previousSpanEnd = span.endUtf16
      if (span.startUtf16 >= span.endUtf16 || span.endUtf16 > unit.text.length
        || !scalarOffset(unit.text, span.startUtf16) || !scalarOffset(unit.text, span.endUtf16)) invalid('Invalid representation span')
    }
  }
  if (characters > 500_000 || spans > 50_000) invalid('Representation payload exceeds the page budget')
})
export type CachedRetrievalPage = z.infer<typeof pageSchema>

/** The empty legacy identity intentionally preserves the unextended key shape. */
export function pageCacheKey(path: string, sourceDigest: string, page: number, extractionIdentity = ''): string {
  const parts = ['page', RETRIEVAL_EXTRACTION_VERSION, RETRIEVAL_TEXT_VERSION, path, sourceDigest, page]
  return retrievalCacheKey(...parts, ...(extractionIdentity ? [extractionIdentity] : []))
}

export function validateRetrievalPage(value: unknown): CachedRetrievalPage | undefined {
  const result = pageSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export async function readCachedPage(cache: RetrievalCache | undefined, key: string): Promise<CachedRetrievalPage | undefined> {
  if (!cache) return undefined
  try {
    return validateRetrievalPage(await cache.get(key))
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

interface CachedRetrievalVector {
  version: 1
  encoding: 'float32-le-base64'
  dimensions: number
  data: string
  sha256: string
}

/** Persist the same normalized Float32 precision used by cosine search. Explicit
 * byte order also makes caches reusable between CPU architectures. */
export function encodeCachedVector(input: ArrayLike<number>): CachedRetrievalVector {
  const vector = compactRetrievalVector(input)
  const bytes = Buffer.allocUnsafe(vector.byteLength)
  for (let index = 0; index < vector.length; index++) bytes.writeFloatLE(vector[index]!, index * 4)
  return { version: 1, encoding: 'float32-le-base64', dimensions: vector.length,
    data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
}

function decodeCachedVector(value: unknown, dimensions: number): number[] | undefined {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || !value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 5 || record.version !== 1 || record.encoding !== 'float32-le-base64'
    || record.dimensions !== dimensions || typeof record.data !== 'string' || typeof record.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.sha256) || record.data.length !== Math.ceil(dimensions * 4 / 3) * 4) return
  const bytes = Buffer.from(record.data, 'base64')
  if (bytes.length !== dimensions * 4 || bytes.toString('base64') !== record.data
    || createHash('sha256').update(bytes).digest('hex') !== record.sha256) return
  const vector: number[] = []
  let squaredNorm = 0
  for (let index = 0; index < dimensions; index++) {
    const item = bytes.readFloatLE(index * 4)
    if (!Number.isFinite(item)) return
    vector.push(item); squaredNorm += item * item
  }
  // Every new record is normalized before serialization. Reject zero, invalid
  // and unnormalized payloads rather than silently blessing corrupted bytes.
  return Math.abs(squaredNorm - 1) <= 1e-5 ? vector : undefined
}

export async function readCachedVector(cache: RetrievalCache | undefined, key: string, dimensions: number): Promise<number[] | undefined> {
  try {
    const value = await cache?.get(key)
    if (validVector(value, dimensions)) {
      // Migrate old JSON arrays as they are reused, without embedding again.
      await cacheDerived(cache, key, encodeCachedVector(value))
      return [...value]
    }
    return decodeCachedVector(value, dimensions)
  } catch { return undefined }
}
