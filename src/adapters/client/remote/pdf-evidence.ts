import { z } from 'zod'
import { responseSchema } from '../../../contracts/rpc/index.js'
import type { RevalidateEvidence } from '../../../client/toolview/pdf-evidence-navigation.js'
import type { PdfConnection } from './pdf-api.js'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const validEvidence = z.object({
  status: z.literal('valid'), documentId: z.string(), page: z.number().int().positive(),
  sourceDigest: digest, sourceVersion: z.string(), contentVersion: z.string(),
  revision: z.number().int().nonnegative(),
}).strict()

/** The Host owns authorization and whole-page equivalence. The Client only
 * accepts a checked response, then independently checks its visible Reader. */
export function createPdfEvidenceRevalidator(connection: PdfConnection, lifetime: AbortSignal): RevalidateEvidence {
  return async (request, signal) => {
    const combined = AbortSignal.any([signal, lifetime])
    combined.throwIfAborted()
    const response = responseSchema.parse(await connection.rpc.call('/api', 'pdf.evidence', request, combined))
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    combined.throwIfAborted()
    return validEvidence.parse(response.value)
  }
}
