import { z } from 'zod'
import { TranslationError, type TranslationEngine, type TranslationEngineDescriptor } from '../translation/index.js'
import type { PdfConnection } from './api.js'

const wireResult = z.object({
  text: z.string().min(1).max(32768), status: z.enum(['complete', 'partial']),
  warnings: z.array(z.string().max(200)).max(20), detectedSourceLanguage: z.string().max(100).optional(),
})
const response = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: wireResult }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
const errorCodes = new Set(['disabled', 'not-configured', 'engine-unavailable', 'authentication-failed',
  'invalid-request', 'limit-exceeded', 'timeout', 'cancelled', 'stale-result', 'translation-failed'])

/** Provider credentials and model calls remain behind the authenticated Host route. */
export function createHostTranslationEngine(connection: PdfConnection, lifetime: AbortSignal,
  descriptor: TranslationEngineDescriptor): TranslationEngine {
  return {
    descriptor,
    async translate(request) {
      if (!request.context?.sessionId) throw new TranslationError('invalid-request', 'Translation requires a PDF session.')
      const result = response.parse(await connection.rpc.call('/api', 'pdf.translation', {
        sessionId: request.context.sessionId, engineId: descriptor.id,
        text: request.text, sourceLanguage: request.sourceLanguage ?? 'auto', targetLanguage: request.targetLanguage,
        timeoutMs: request.timeoutMs, context: request.context,
      }, AbortSignal.any([lifetime, request.signal])))
      if (!result.ok) {
        const code = result.error.code === 'pdf/cancelled' ? 'cancelled'
          : errorCodes.has(result.error.code) ? result.error.code as TranslationError['code'] : 'translation-failed'
        throw new TranslationError(code, result.error.message)
      }
      return result.value
    },
  }
}
