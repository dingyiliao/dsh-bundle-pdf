import { z } from 'zod'
import type { PdfConnection } from './api.js'

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

export type ImageUnderstandingAvailability = z.infer<typeof availability>
export type PreparedImageUnderstanding = z.infer<typeof prepared>

export interface ImageUnderstandingApi {
  availability(sessionId: string, signal?: AbortSignal): Promise<ImageUnderstandingAvailability>
  prepare(request: { sessionId: string; image: { mediaType: 'image/png'; data: string; width: number; height: number };
    question: string }, signal?: AbortSignal): Promise<PreparedImageUnderstanding>
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
  }
}
