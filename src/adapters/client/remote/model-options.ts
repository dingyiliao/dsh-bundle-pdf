import { z } from 'zod'
import { PDF_MODEL_OPTIONS_METHOD, visionModelCatalogSchema, type VisionModelCatalog } from '../../../contracts/model-options.js'
import type { PdfConnection } from './pdf-api.js'

export interface ModelOptionsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  catalog?: VisionModelCatalog
  error?: string
}
export interface ModelOptionsStore {
  getSnapshot(): ModelOptionsSnapshot
  subscribe(listener: () => void): () => void
  load(): Promise<void>
  refresh(): Promise<void>
}
const reply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: visionModelCatalogSchema }),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
])

/** Read-only DSH catalog mirror. It never submits a conversation model selection. */
export function createModelOptionsStore(connection: PdfConnection, lifetime: AbortSignal): ModelOptionsStore & { dispose(): void } {
  let snapshot: ModelOptionsSnapshot = { status: 'idle' }
  const listeners = new Set<() => void>()
  let request: { controller: AbortController; promise: Promise<void> } | undefined
  let disposed = false
  const publish = (next: ModelOptionsSnapshot) => {
    snapshot = next
    for (const listener of [...listeners]) { try { listener() } catch { /* Read-only observers are independent. */ } }
  }
  function cancel() {
    const active = request
    request = undefined
    active?.controller.abort()
    if (!disposed && snapshot.status === 'loading') publish({ status: snapshot.catalog ? 'ready' : 'idle',
      ...(snapshot.catalog ? { catalog: snapshot.catalog } : {}) })
  }
  async function load(refresh = false): Promise<void> {
    if (disposed || lifetime.aborted) return
    if (request) return request.promise
    if (!refresh && snapshot.status === 'ready') return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime])
    // Defer the I/O one microtask so the captured owner exists before a synchronous failure.
    const active = { controller, promise: Promise.resolve() }
    request = active
    publish({ status: 'loading', ...(snapshot.catalog ? { catalog: snapshot.catalog } : {}) })
    active.promise = Promise.resolve().then(async () => {
      let stopAbort: (() => void) | undefined
      try {
        signal.throwIfAborted()
        const cancelled = new Promise<never>((_, reject) => {
          const aborted = () => reject(signal.reason)
          signal.addEventListener('abort', aborted, { once: true })
          stopAbort = () => signal.removeEventListener('abort', aborted)
          if (signal.aborted) aborted()
        })
        const response = reply.parse(await Promise.race([
          connection.rpc.call('/api', PDF_MODEL_OPTIONS_METHOD, {}, signal), cancelled,
        ]))
        signal.throwIfAborted()
        if (disposed || request !== active) return
        if (!response.ok) throw new Error(response.error.message)
        publish({ status: 'ready', catalog: response.value })
      } catch (error) {
        if (!disposed && request === active && !signal.aborted) {
          publish({ status: 'error', ...(snapshot.catalog ? { catalog: snapshot.catalog } : {}),
            error: error instanceof Error ? error.message : 'Model choices are unavailable.' })
        }
      } finally { stopAbort?.(); if (request === active) request = undefined }
    })
    return active.promise
  }
  const aborted = () => { cancel(); listeners.clear() }
  lifetime.addEventListener('abort', aborted, { once: true })
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed || lifetime.aborted) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener); if (!listeners.size) cancel() }
    },
    load: () => load(), refresh: () => load(true),
    dispose() { if (disposed) return; disposed = true; cancel(); listeners.clear(); lifetime.removeEventListener('abort', aborted) },
  }
}
