import { z } from 'zod'
import { RETRIEVAL_REBUILD_METHOD, retrievalRebuildResultSchema } from '../../../contracts/retrieval-index.js'
import type { PdfConnection } from './pdf-api.js'

const reply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: retrievalRebuildResultSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])

/** Settings action uses the authenticated connection, independently of any PDF view or Session. */
export function createRetrievalIndexApi(connection: PdfConnection, lifetime: AbortSignal) {
  return {
    async rebuild(signal: AbortSignal): Promise<void> {
      const active = AbortSignal.any([lifetime, signal])
      active.throwIfAborted()
      const raw = await connection.rpc.call('/api', RETRIEVAL_REBUILD_METHOD, {}, active)
      active.throwIfAborted()
      const result = reply.parse(raw)
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    },
  }
}
