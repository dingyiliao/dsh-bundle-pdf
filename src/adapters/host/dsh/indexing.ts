import { createHash } from 'node:crypto'
import { PASSIVE_POLL_TIMEOUT_MS } from '../../../shared/passive-poll.js'
import { indexingRequestSchema, indexingSnapshotSchema, type PdfIndexingSnapshot } from '../../../contracts/indexing.js'
import type { OpenWorkingCopyDocument } from '../../../modules/working-copy/index.js'
import type { createRetrievalPrefetch } from './retrieval-prefetch.js'

type Prefetch = ReturnType<typeof createRetrievalPrefetch>
const unavailable = () => Object.assign(new Error('PDF indexing is unavailable.'), { code: 'pdf/cancelled' })

/** Session-filtered task control. The transport owns current-agent authorization. */
export function createPdfIndexing(prefetch: Prefetch, ports: {
  documents(): readonly OpenWorkingCopyDocument[]
  enabled(): boolean
}) {
  const listeners = new Set<() => void>()
  let disposed = false
  const changed = () => {
    for (const listener of [...listeners]) { try { listener() } catch { /* Passive observers. */ } }
  }
  const stop = prefetch.subscribe(changed)
  function snapshot(sessionId: string): PdfIndexingSnapshot {
    if (disposed) throw unavailable()
    const open = new Map(ports.documents().filter(document => document.sessionId === sessionId).map(document => [document.id, document]))
    const state = prefetch.status()
    const value = { enabled: ports.enabled(), tasks: state.documents.flatMap(task => {
      const document = open.get(task.id)
      if (task.sessionId !== sessionId || !document) return []
      return [{ documentId: task.id, title: (document.title || 'PDF').slice(0, 512),
        occurrence: task.occurrence, state: task.state,
        ...(task.progress ? { progress: task.progress } : {}), ...(task.failureCode ? { failureCode: task.failureCode } : {}) }]
    }) }
    // Another Session's tasks do not change this Session's observable revision.
    const revision = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    return indexingSnapshotSchema.parse({ revision, ...value })
  }
  function wait(sessionId: string, revision: string | undefined, signal: AbortSignal): Promise<PdfIndexingSnapshot> {
    signal.throwIfAborted()
    const current = snapshot(sessionId)
    if (!revision || current.revision !== revision) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const cleanup = () => { clearTimeout(timer); listeners.delete(update); signal.removeEventListener('abort', abort) }
      const update = (timeout = false) => {
        try {
          const value = snapshot(sessionId)
          if (!timeout && value.revision === revision) return
          cleanup(); resolve(value)
        } catch (error) { cleanup(); reject(error) }
      }
      const abort = () => { cleanup(); reject(signal.reason ?? unavailable()) }
      listeners.add(update)
      timer = setTimeout(() => update(true), PASSIVE_POLL_TIMEOUT_MS)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort(); else update()
    })
  }
  return {
    snapshot,
    changed,
    async dispatch(sessionId: string, input: unknown, signal: AbortSignal): Promise<PdfIndexingSnapshot> {
      const request = indexingRequestSchema.parse(input)
      signal.throwIfAborted()
      if (request.sessionId !== sessionId) throw Object.assign(new Error('Session identity mismatch.'), { code: 'pdf/session-mismatch' })
      if (request.action === 'status') return wait(sessionId, request.revision, signal)
      if (disposed) throw unavailable()
      if (!ports.documents().some(document => document.sessionId === sessionId && document.id === request.documentId)) {
        throw Object.assign(new Error('Open this PDF before controlling its index.'), { code: 'pdf/unknown-document' })
      }
      if (request.action === 'start') prefetch.start(sessionId, request.documentId)
      else if (request.action === 'rebuild') prefetch.rebuild(sessionId, request.documentId)
      else prefetch.cancel(sessionId, request.documentId)
      return snapshot(sessionId)
    },
    dispose() { if (disposed) return; disposed = true; stop(); changed(); listeners.clear() },
  }
}
