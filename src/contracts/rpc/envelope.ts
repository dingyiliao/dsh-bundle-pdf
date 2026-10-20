import { z } from 'zod'

export const PDF_ENDPOINT = 'pdf.dispatch.v2'

/** The Connection carrier authenticates this envelope before resource lookup. */
export const requestEnvelopeSchema = z.object({
  type: z.literal('client-request'),
  rpcId: z.string().min(1).max(256),
  method: z.string(),
  payload: z.unknown(),
}).passthrough()

export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
