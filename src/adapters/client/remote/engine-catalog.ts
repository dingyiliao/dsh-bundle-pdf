import { engineCatalogSchema, type EngineCatalogSnapshot } from '../../../modules/engines/index.js'
import type { PdfConnection } from './pdf-api.js'
import { z } from 'zod'

const response = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: engineCatalogSchema }),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
])

/** One connection-scoped long poll, retained only while there are subscribers. */
export function createEngineCatalogStore(connection: PdfConnection, lifetime: AbortSignal, initial: EngineCatalogSnapshot) {
  let snapshot = engineCatalogSchema.parse(initial)
  const listeners = new Set<() => void>()
  let watch: AbortController | undefined
  const pause = (signal: AbortSignal, ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
  const start = () => {
    if (watch || lifetime.aborted || !listeners.size) return
    const controller = new AbortController()
    watch = controller
    const signal = AbortSignal.any([controller.signal, lifetime])
    void (async () => {
      while (!signal.aborted && listeners.size) {
        try {
          const before = snapshot.revision, started = Date.now()
          const reply = response.parse(await connection.rpc.call('/api', 'pdf.engines', { revision: before }, signal))
          if (signal.aborted) break
          if (!reply.ok) throw new Error(reply.error.message)
          if (reply.value.revision !== snapshot.revision) {
            snapshot = reply.value
            for (const listener of [...listeners]) { try { listener() } catch { /* Isolate observers. */ } }
          }
          if (Date.now() - started < 250) await pause(signal, 250)
        } catch {
          if (!signal.aborted) await pause(signal, 1000)
          // Keep the last directory across disconnects; connection loss is not
          // evidence that every installed engine was unregistered.
        }
      }
      if (watch === controller) watch = undefined
    })()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener); start()
      return () => { listeners.delete(listener); if (!listeners.size) { watch?.abort(); watch = undefined } }
    },
    dispose() { watch?.abort(); watch = undefined; listeners.clear() },
  }
}
