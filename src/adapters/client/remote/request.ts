import { responseSchema } from '../../../contracts/rpc/index.js'
import type { PdfConnection } from './pdf-api.js'

/** Ordinary authenticated calls; routes retain their own result validation. */
export function createRemoteCall(connection: PdfConnection, lifetime: AbortSignal, method: string) {
  return async (request: object, signal?: AbortSignal): Promise<unknown> => {
    const result = responseSchema.parse(await connection.rpc.call('/api', method, request,
      signal ? AbortSignal.any([signal, lifetime]) : lifetime))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
}

/** Cancellation wakes passive poll backoff without rejecting the watch loop. */
export function pauseRemotePoll(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}
