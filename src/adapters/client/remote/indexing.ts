import { z } from 'zod'
import { PDF_INDEXING_METHOD, indexingSnapshotSchema, type indexingRequestSchema, type PdfDocumentIndexPolicy,
  type PdfIndexingSnapshot } from '../../../contracts/indexing.js'
import type { PdfConnection } from './pdf-api.js'
import type { PdfIndexingClientSnapshot } from '../../../modules/viewer/index.js'
const reply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: indexingSnapshotSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
interface SessionStore {
  value: PdfIndexingClientSnapshot; listeners: Set<() => void>; watch?: AbortController; sequence: number
}
type ControlRequest = Exclude<z.infer<typeof indexingRequestSchema>, { action: 'status' }>

/** One cancellable status subscription per resource Session, shared across PDF views. */
export function createPdfIndexingApi(connection: PdfConnection, lifetime: AbortSignal) {
  const sessions = new Map<string, SessionStore>()
  const disposal = new AbortController()
  let disposed = false
  const get = (sessionId: string): SessionStore => {
    let entry = sessions.get(sessionId)
    if (!entry) {
      // Keep active subscriptions, but bound snapshots left by closed tabs.
      if (sessions.size >= 32) {
        const inactive = [...sessions].find(([, value]) => !value.listeners.size && !value.watch)
        if (inactive) sessions.delete(inactive[0])
      }
      entry = { value: { status: 'loading', enabled: false, tasks: [] }, listeners: new Set(), sequence: 0 }
      sessions.set(sessionId, entry)
    }
    return entry
  }
  const publish = (entry: SessionStore, value: PdfIndexingClientSnapshot) => {
    if (entry.value.status === value.status && entry.value.revision === value.revision && entry.value.enabled === value.enabled) return
    const dismissed = Object.fromEntries(value.tasks.filter(task => task.state === 'ready'
      && entry.value.dismissed?.[task.documentId] === task.occurrence).map(task => [task.documentId, task.occurrence]))
    entry.value = { ...value, dismissed }
    for (const listener of [...entry.listeners]) { try { listener() } catch { /* Isolate views. */ } }
  }
  const pause = (signal: AbortSignal, ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
  const call = async (input: object, signal: AbortSignal): Promise<PdfIndexingSnapshot> => {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Indexing request cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      const response = reply.parse(await Promise.race([
        connection.rpc.call('/api', PDF_INDEXING_METHOD, input, signal), cancelled,
      ]))
      signal.throwIfAborted()
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      return response.value
    } finally { signal.removeEventListener('abort', abort) }
  }
  function watch(sessionId: string, entry: SessionStore): void {
    if (disposed || lifetime.aborted || entry.watch || !entry.listeners.size) return
    const controller = new AbortController()
    entry.watch = controller
    publish(entry, { ...entry.value, status: 'loading' })
    const signal = AbortSignal.any([controller.signal, lifetime])
    void (async () => {
      while (!signal.aborted && entry.listeners.size) {
        const sequence = entry.sequence, started = Date.now()
        try {
          const value = await call({ action: 'status', sessionId,
            ...(entry.value.status === 'ready' && entry.value.revision ? { revision: entry.value.revision } : {}) }, signal)
          if (signal.aborted) break
          if (entry.sequence === sequence) { entry.sequence++; publish(entry, { status: 'ready', ...value }) }
          if (Date.now() - started < 200) await pause(signal, 200)
        } catch {
          if (signal.aborted) break
          if (entry.sequence === sequence) { entry.sequence++; publish(entry, { ...entry.value, status: 'unavailable' }) }
          await pause(signal, 1000)
        }
      }
      if (entry.watch === controller) entry.watch = undefined
    })()
  }
  async function control(input: ControlRequest, signal: AbortSignal): Promise<void> {
    const active = AbortSignal.any([signal, lifetime, disposal.signal])
    if (disposed) throw new DOMException('Indexing connection is closed', 'AbortError')
    const entry = get(input.sessionId), sequence = ++entry.sequence
    const value = await call(input, active)
    if (sequence === entry.sequence) { entry.sequence++; publish(entry, { status: 'ready', ...value }) }
  }
  return {
    getSnapshot: (sessionId: string) => get(sessionId).value,
    subscribe(sessionId: string, listener: () => void) {
      const entry = get(sessionId)
      entry.listeners.add(listener); watch(sessionId, entry)
      return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entry.watch?.abort(); entry.watch = undefined } }
    },
    start: (sessionId: string, documentId: string, signal: AbortSignal) => control({ action: 'start', sessionId, documentId }, signal),
    rebuild: (sessionId: string, documentId: string, signal: AbortSignal) => control({ action: 'rebuild', sessionId, documentId }, signal),
    cancel: (sessionId: string, documentId: string, signal: AbortSignal) => control({ action: 'cancel', sessionId, documentId }, signal),
    configure: (sessionId: string, documentId: string, revision: number, policy: PdfDocumentIndexPolicy, signal: AbortSignal) =>
      control({ action: 'configure', sessionId, documentId, revision, policy }, signal),
    useDefaults: (sessionId: string, documentId: string, revision: number, signal: AbortSignal) =>
      control({ action: 'defaults', sessionId, documentId, revision }, signal),
    dismiss(sessionId: string, documentId: string, occurrence: number) {
      if (disposed || lifetime.aborted) return
      const entry = get(sessionId)
      if (entry.value.status !== 'ready' || entry.value.dismissed?.[documentId] === occurrence
        || !entry.value.tasks.some(task => task.documentId === documentId && task.occurrence === occurrence && task.state === 'ready')) return
      entry.value = { ...entry.value, dismissed: { ...entry.value.dismissed, [documentId]: occurrence } }
      for (const listener of [...entry.listeners]) { try { listener() } catch { /* Isolate views. */ } }
    },
    dispose() { disposed = true; disposal.abort(); for (const entry of sessions.values()) { entry.watch?.abort(); entry.listeners.clear() }; sessions.clear() },
  }
}
