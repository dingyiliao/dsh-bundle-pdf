import { z } from 'zod'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const refId = z.string().regex(/^pdfref_[0-9a-f-]{36}$/)
const sourcePath = z.string().min(1).max(32_768)
const MAX_REFERENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** A replayable, session-scoped text snapshot; it never grants file access. */
export const textEvidenceSchema = z.object({
  refId,
  documentId: z.string().min(1).max(512),
  sourcePath,
  sourceDigest: digest,
  sourceVersion: z.string().min(1).max(4096),
  contentVersion: z.string().min(1).max(512),
  revision: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(100_000),
  source: z.literal('pdf-text'),
  extraction: z.literal('local-ocr').optional(),
  pageTextDigest: digest.optional(),
  snapshot: z.object({ text: z.string().max(8000), sha256: digest }).strict(),
  locator: z.object({ kind: z.literal('text-window'), startUtf16: z.number().int().nonnegative(),
    endUtf16: z.number().int().nonnegative(),
    rectsPdf: z.array(z.array(z.number().finite()).length(4)).max(32).optional() }).strict(),
  precision: z.enum(['exact-text', 'approximate-geometry']),
  limitations: z.array(z.string().max(512)).max(8),
}).strict()
export type PdfTextEvidence = z.infer<typeof textEvidenceSchema>

const evidenceIdentity = z.object({
  refId,
  documentId: z.string().min(1).max(512),
  sourcePath,
  sourceDigest: digest,
  sourceVersion: z.string().min(1).max(4096),
  contentVersion: z.string().min(1).max(512),
  revision: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(100_000),
  renderedImageSha256: digest,
  locator: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('page-only') }).strict(),
    z.object({ kind: z.literal('pdf-region'), rectPdf: z.tuple([
      z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
    ]) }).strict(),
  ]),
  limitations: z.array(z.string().max(512)).max(8),
})

const attachmentSnapshot = z.object({
  kind: z.literal('attachment'),
  /** Opaque attachment-store identity; the PNG/JPEG bytes are never stored here. */
  attachmentId: z.string().min(1).max(512),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  /** Available only when the attachment store can attest to its stored bytes. */
  storedImageSha256: digest.optional(),
}).strict()

const derivedTextSnapshot = z.object({
  kind: z.literal('derived-text'),
  text: z.string().max(8_000),
  sha256: digest,
  backendId: z.string().min(1).max(256),
  backendVersion: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
}).strict()

/** A durable image/OCR provenance record, not the underlying image and not an access token. */
export const imageEvidenceSchema = z.discriminatedUnion('source', [
  evidenceIdentity.extend({ source: z.literal('direct-image'), snapshot: attachmentSnapshot,
    precision: z.enum(['page-only', 'approximate-geometry']) }).strict(),
  evidenceIdentity.extend({ source: z.literal('ocr-text'), snapshot: derivedTextSnapshot,
    precision: z.enum(['page-only', 'approximate-geometry']) }).strict(),
  evidenceIdentity.extend({ source: z.literal('auxiliary-vision'), snapshot: derivedTextSnapshot,
    precision: z.enum(['page-only', 'approximate-geometry']) }).strict(),
])
export type PdfImageEvidence = z.infer<typeof imageEvidenceSchema>

export const savedTextReferenceSchema = z.object({
  sessionId: z.string().min(1).max(512),
  evidence: textEvidenceSchema,
  pageTextDigest: digest,
  createdAt: z.number().int().nonnegative(),
}).strict()
export type SavedTextReference = z.infer<typeof savedTextReferenceSchema>

export const savedImageReferenceSchema = z.object({
  sessionId: z.string().min(1).max(512),
  evidence: imageEvidenceSchema,
  createdAt: z.number().int().nonnegative(),
}).strict()
export type SavedImageReference = z.infer<typeof savedImageReferenceSchema>

/** Existing text records keep their exact shape; new image records share the same bounded domain. */
export const savedReferenceSchema = z.union([savedTextReferenceSchema, savedImageReferenceSchema])
export type SavedReference = z.infer<typeof savedReferenceSchema>

export function isSavedTextReference(record: SavedReference): record is SavedTextReference {
  return record.evidence.source === 'pdf-text'
}

export function isSavedImageReference(record: SavedReference): record is SavedImageReference {
  return record.evidence.source !== 'pdf-text'
}

/** Reads are synchronous so a ref may be resolved without trusting a model-supplied path. */
export interface EvidenceReferenceStore {
  get(refId: string): SavedReference | undefined
  put(refId: string, value: SavedReference): Promise<void>
  delete(refId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  clear?(): void
}

/** Test/local fallback. Production injects a durable Host Storage Domain adapter. */
export function createMemoryEvidenceReferenceStore(limit = 256, now: () => number = Date.now): EvidenceReferenceStore {
  const records = new Map<string, SavedReference>()
  return {
    get(key) {
      const value = records.get(key)
      return value && now() - value.createdAt <= MAX_REFERENCE_AGE_MS ? value : undefined
    },
    async put(key, value) {
      records.set(key, value)
      for (const [refId, record] of records) {
        if (now() - record.createdAt > MAX_REFERENCE_AGE_MS) records.delete(refId)
      }
      while (records.size > limit) records.delete(records.keys().next().value!)
    },
    async delete(key) { records.delete(key) },
    async deleteSession(sessionId) {
      for (const [key, value] of records) if (value.sessionId === sessionId) records.delete(key)
    },
    clear() { records.clear() },
  }
}
