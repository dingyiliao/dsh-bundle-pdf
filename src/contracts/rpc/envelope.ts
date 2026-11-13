import { z } from 'zod'

export const PDF_ENDPOINT = 'pdf.dispatch.v2'

/** The Connection carrier authenticates this envelope before resource lookup. */
export const requestEnvelopeSchema = z.object({
  type: z.literal('client-request'),
  rpcId: z.string().min(1).max(256),
  method: z.string(),
  payload: z.unknown(),
}).passthrough()

export const rpcErrorSchema = z.object({ code: z.string(), message: z.string() })

/**
 * Build the single response envelope used by every typed remote route.
 *
 * The transport only knows that a successful value is unknown. Feature
 * adapters provide the route-specific value schema here instead of copying
 * the same `ok/error` union and accidentally drifting its error contract.
 */
export function rpcResponseSchema<
  T extends z.ZodType,
  E extends z.ZodType = typeof rpcErrorSchema,
>(value: T, error: E = rpcErrorSchema as unknown as E) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error }),
  ])
}

export const responseSchema = rpcResponseSchema(z.unknown())
