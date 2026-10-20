import { z } from 'zod'
import { responseSchema } from '../../../contracts/rpc/index.js'
import { MAX_EXPLANATION_IMAGE_BYTES } from '../../../modules/explanation/index.js'
import { inspectPng } from '../../../shared/png.js'
import type { ImageUnderstandingApi, ImageUnderstandingAvailability, PreparedImageUnderstanding,
  PreparedImageReference } from '../../../modules/viewer/index.js'
import type { PdfConnection } from './pdf-api.js'

export type { ImageUnderstandingApi, ImageUnderstandingAvailability, PreparedImageUnderstanding,
  PreparedImageReference } from '../../../modules/viewer/index.js'

const reply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
const availability = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), kind: z.enum(['direct-image', 'derived-text']),
    backendId: z.string(), limitation: z.string().optional() }),
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
])
const prepared = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct-image'), backendId: z.string(),
    provenance: z.object({ backendId: z.string(), mode: z.literal('session-vision') }) }),
  z.object({ kind: z.literal('derived-text'), text: z.string().max(32_768),
    provenance: z.object({ backendId: z.string(), mode: z.enum(['ocr-text', 'image-description']), model: z.string().optional() }),
    limitations: z.string().optional() }),
])

const identity = z.string().min(1).max(512)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const referenceId = z.string().regex(/^pdfref_[0-9a-f-]{36}$/)
const locator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page-only') }).strict(),
  z.object({ kind: z.literal('pdf-region'), rectPdf: z.tuple([
    z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
  ]) }).strict(),
])
const evidence = z.object({
  refId: referenceId, documentId: identity, page: z.number().int().positive(),
  locator, sourceDigest: digest, sourceVersion: z.string().min(1).max(4096),
  contentVersion: identity, revision: z.number().int().nonnegative(),
  renderedImageSha256: digest,
}).strict()
const referencePreparation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct-image'), backendId: z.string(),
    requestedRefId: referenceId, evidence,
    provenance: z.object({ backendId: z.string(), mode: z.literal('session-vision') }),
    bytes: z.instanceof(Uint8Array) }).strict(),
  z.object({ kind: z.literal('derived-text'), backendId: z.string(),
    requestedRefId: referenceId, evidence, text: z.string().max(32_768),
    provenance: z.object({ backendId: z.string(), mode: z.enum(['ocr-text', 'image-description']), model: z.string().optional() }),
    limitations: z.string().optional() }).strict(),
])

/** Read and validate the PNG container returned for a Host-verified reference. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  return inspectPng(bytes, { maxBytes: MAX_EXPLANATION_IMAGE_BYTES,
    maxWidth: 8192, maxHeight: 8192, maxPixels: 24_000_000 })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

async function checkedReference(value: z.infer<typeof referencePreparation>,
  request: { sessionId: string; documentId: string; refId: string }): Promise<PreparedImageReference> {
  // The Host may reissue the opaque ref after reopening byte-identical source.
  if (value.requestedRefId !== request.refId || value.evidence.documentId !== request.documentId) {
    throw new Error('PDF image reference response does not match the requested document or reference')
  }
  if (value.kind === 'derived-text') {
    return { kind: 'derived-text', backendId: value.backendId, requestedRefId: value.requestedRefId,
      text: value.text, provenance: value.provenance,
      ...(value.limitations ? { limitations: value.limitations } : {}), evidence: value.evidence }
  }
  const { width, height } = pngDimensions(value.bytes)
  if (await sha256(value.bytes) !== value.evidence.renderedImageSha256) {
    throw new Error('PDF image reference bytes do not match their Host digest')
  }
  return { kind: 'direct-image', backendId: value.backendId, requestedRefId: value.requestedRefId,
    provenance: value.provenance, evidence: value.evidence,
    image: { mediaType: 'image/png', data: value.bytes, width, height } }
}

/** A separate route decides whether image bytes go to this Session or a configured backend. */
export function createImageUnderstandingApi(connection: PdfConnection, lifetime: AbortSignal): ImageUnderstandingApi {
  const call = async (request: object, signal?: AbortSignal): Promise<unknown> => {
    const result = reply.parse(await connection.rpc.call('/api', 'pdf.image', request,
      signal ? AbortSignal.any([signal, lifetime]) : lifetime))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  return {
    availability: async (sessionId, signal) => availability.parse(await call({ action: 'availability', sessionId }, signal)),
    prepare: async (request, signal) => prepared.parse(await call({ action: 'prepare', ...request }, signal)),
    prepareReference: async (request, signal) => {
      const value = referencePreparation.parse(await call({
        action: 'prepare-reference', sessionId: request.sessionId, documentId: request.documentId,
        refId: request.refId, question: request.question,
      }, signal))
      return await checkedReference(value, request)
    },
  }
}
