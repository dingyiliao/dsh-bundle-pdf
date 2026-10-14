import { z } from 'zod'
import type { PdfRect } from '../core/pdf-types.js'
import type { PdfConnection } from './api.js'

const reply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
const availability = z.object({
  status: z.enum(['available', 'disabled', 'not-configured', 'unavailable']),
  reason: z.string().optional(),
})
const recognition = z.object({
  documentId: z.string(), page: z.number().int().positive(), revision: z.number().int(),
  contentVersion: z.string(), text: z.string().max(32_768), status: z.enum(['complete', 'partial']),
  source: z.object({ backendId: z.string(), backendVersion: z.string() }),
  geometry: z.object({ status: z.enum(['none', 'partial', 'complete']) }),
  warnings: z.array(z.string()).max(64),
})

export type HostOcrAvailability = z.infer<typeof availability>
export type HostOcrRecognition = z.infer<typeof recognition>

export interface HostOcrApi {
  availability(sessionId: string, signal?: AbortSignal): Promise<HostOcrAvailability>
  recognize(request: { sessionId: string; documentId: string; page: number; region?: PdfRect },
    signal?: AbortSignal): Promise<HostOcrRecognition>
}

/** The Host owns model capability, page rendering, OCR execution, and session authorization. */
export function createHostOcrApi(connection: PdfConnection, lifetime: AbortSignal): HostOcrApi {
  const call = async (request: object, signal?: AbortSignal): Promise<unknown> => {
    const result = reply.parse(await connection.rpc.call('/api', 'pdf.ocr', request,
      signal ? AbortSignal.any([signal, lifetime]) : lifetime))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  return {
    availability: async (sessionId, signal) => availability.parse(await call({ action: 'availability', sessionId }, signal)),
    recognize: async (request, signal) => recognition.parse(await call({ action: 'recognize', ...request }, signal)),
  }
}
