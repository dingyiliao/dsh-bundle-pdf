import { z } from 'zod'
import { responseSchema } from '../../../contracts/rpc/index.js'
import { MAX_EXPLANATION_REGION_IMAGE_BYTES } from '../../../modules/explanation/index.js'
import { inspectPng } from '../../../shared/png.js'
import type { PdfRegionEvidenceApi } from '../../../modules/viewer/index.js'
import type { PdfConnection } from './pdf-api.js'

export type { PdfRegionEvidence, PdfRegionEvidenceApi } from '../../../modules/viewer/index.js'

const identity = z.string().min(1).max(512)
const rectPdf = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
const requestSchema = z.object({
  sessionId: identity,
  documentId: identity,
  page: z.number().int().min(1).max(100_000),
  rectPdf,
  expectedRevision: z.number().int().nonnegative(),
  expectedContentVersion: identity,
  maxEdge: z.number().int().min(256).max(1024).optional(),
}).strict()
const resultSchema = z.object({
  refId: z.string().regex(/^pdfref_[0-9a-f-]{36}$/),
  documentId: identity,
  page: z.number().int().min(1).max(100_000),
  rectPdf,
  sourcePath: z.string().min(1).max(32_768),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceVersion: z.string().min(1).max(4096),
  contentVersion: identity,
  revision: z.number().int().nonnegative(),
  mediaType: z.literal('image/png'),
  width: z.number().int().min(1).max(1026),
  height: z.number().int().min(1).max(1026),
  bytes: z.instanceof(Uint8Array),
}).strict()

/** Check the multipart bytes themselves; metadata alone cannot establish that
 * the image is a bounded, complete PNG of the declared dimensions. */
function validatePng(bytes: Uint8Array, width: number, height: number): void {
  const actual = inspectPng(bytes, { maxBytes: MAX_EXPLANATION_REGION_IMAGE_BYTES,
    maxWidth: 1026, maxHeight: 1026 })
  if (actual.width !== width || actual.height !== height) {
    throw new Error('PDF region PNG dimensions do not match the response')
  }
}

/** The Host renders and authorizes the crop. The Client only accepts an exact,
 * bounded PNG over Connection's authenticated binary attachment transport. */
export function createRegionEvidenceApi(connection: PdfConnection, lifetime: AbortSignal): PdfRegionEvidenceApi {
  return {
    async prepare(request, signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime
      combined.throwIfAborted()
      const payload = requestSchema.parse(request)
      const response = responseSchema.parse(await connection.rpc.call('/api', 'pdf.region', payload, combined))
      combined.throwIfAborted()
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      const result = resultSchema.parse(response.value)
      validatePng(result.bytes, result.width, result.height)
      combined.throwIfAborted()
      return result
    },
  }
}
