import { z } from 'zod'
import { responseSchema } from '../../../contracts/rpc/index.js'
import type { PdfTextSelectionEvidenceApi } from '../../../modules/viewer/index.js'
import type { PdfConnection } from './pdf-api.js'

const identity = z.string().min(1).max(512)
const coordinate = z.number().finite()
const rect = z.tuple([coordinate, coordinate, coordinate, coordinate])
const requestSchema = z.object({
  sessionId: identity, documentId: identity,
  expectedRevision: z.number().int().nonnegative(), expectedContentVersion: identity,
  quote: z.string().min(1).max(12_000),
  fragments: z.array(z.object({ page: z.number().int().min(1).max(100_000), rect,
    quadPoints: z.array(coordinate).min(8).max(1024) }).strict()).min(1).max(10),
}).strict()
const resultSchema = z.object({
  text: z.string().min(1).max(8_000), documentId: identity,
  sourcePath: z.string().min(1).max(32_768),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceVersion: z.string().min(1).max(4096), contentVersion: identity,
  revision: z.number().int().nonnegative(),
  excerpts: z.array(z.object({ page: z.number().int().min(1).max(100_000),
    text: z.string().min(1).max(8_000), refId: z.string().regex(/^pdfref_[0-9a-f-]{36}$/),
    startUtf16: z.number().int().nonnegative(), endUtf16: z.number().int().positive() }).strict()).min(1).max(10),
}).strict()

/** The Host, not the browser selection, determines the text admitted as evidence. */
export function createTextSelectionEvidenceApi(connection: PdfConnection, lifetime: AbortSignal): PdfTextSelectionEvidenceApi {
  return {
    async prepare(input, signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime
      combined.throwIfAborted()
      const request = requestSchema.parse(input)
      const response = responseSchema.parse(await connection.rpc.call('/api', 'pdf.selection', request, combined))
      combined.throwIfAborted()
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      const result = resultSchema.parse(response.value)
      if (result.documentId !== request.documentId || result.contentVersion !== request.expectedContentVersion
        || result.revision !== request.expectedRevision
        || result.excerpts.some(excerpt => !request.fragments.some(fragment => fragment.page === excerpt.page)
          || excerpt.endUtf16 <= excerpt.startUtf16)) {
        throw new Error('Host text selection identity does not match the requested PDF selection')
      }
      return result
    },
  }
}
