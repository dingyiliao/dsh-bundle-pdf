import type { OpenWorkingCopyDocument } from '../../../modules/working-copy/index.js'
import type { RetrievalProgress } from '../../../modules/retrieval/index.js'
import { indexingProgressSchema } from '../../../contracts/indexing.js'

export interface RetrievalPrefetchDocument extends Pick<OpenWorkingCopyDocument,
  'sessionId' | 'id' | 'contentVersion' | 'sourceDigest' | 'conflict'> {}
export interface RetrievalPrefetchStatus {
  revision: string
  state: 'idle' | 'running' | 'suspended' | 'disposed'
  skippedDocuments: number
  failureCode?: string
  documents: Array<{ sessionId: string; id: string; contentVersion: string;
    occurrence: number; state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
    progress?: RetrievalProgress; failureCode?: string }>
}
interface Entry {
  document: RetrievalPrefetchDocument
  signature: string
  occurrence: number
  state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
  progress?: RetrievalProgress
  failureCode?: string
  rebuild?: boolean
}
interface Running { entry: Entry; controller: AbortController; promise: Promise<void> }
interface Ports {
  /** Only real UI/model owners belong here; indexing leases are not owners. */
  documents(): readonly RetrievalPrefetchDocument[]
  /** A stable saved binding/registration identity, not mutable discovery metadata. */
  selection(): { identity: string } | undefined
  prepare(sessionId: string, input: { documentId: string; rebuild?: boolean }, signal: AbortSignal,
    onProgress?: (progress: RetrievalProgress) => void): Promise<void>
  subscribe?(listener: () => void): () => void
  onChange?(status: RetrievalPrefetchStatus): void
  maxDocuments?: number
}

const documentKey = (document: RetrievalPrefetchDocument) => JSON.stringify([document.sessionId, document.id])
const signatureFor = (identity: string, document: RetrievalPrefetchDocument) => JSON.stringify([
  identity, document.sessionId, document.id, document.contentVersion, document.sourceDigest,
])
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
const failureCode = (error: unknown): string => {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof value === 'string' && /^[a-zA-Z0-9/_.:-]{1,128}$/.test(value) ? value : 'pdf/retrieval-prefetch-failed'
}

/** One bounded, owner-aware background lane; foreground queries share the actual retrieval index. */
export function createRetrievalPrefetch(ports: Ports) {
  const maximum = ports.maxDocuments ?? 64
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024) throw new RangeError('Invalid background indexing document limit')
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  // Most recent explicit requests get room ahead of automatic preparation,
  // without exceeding the same bounded document directory.
  const priority = new Set<string>()
  let running: Running | undefined
  let disposal: Promise<void> | undefined
  let scheduled = false, suspended = false, disposed = false, skippedDocuments = 0
  let lastFailure: string | undefined
  let revision = crypto.randomUUID(), occurrence = 0

  function snapshot(): Omit<RetrievalPrefetchStatus, 'revision'> {
    return { state: disposed ? 'disposed' : suspended ? 'suspended' : running ? 'running' : 'idle',
      skippedDocuments, ...(lastFailure ? { failureCode: lastFailure } : {}),
      documents: [...entries.values()].map(entry => ({ sessionId: entry.document.sessionId, id: entry.document.id,
        contentVersion: entry.document.contentVersion, occurrence: entry.occurrence, state: entry.state,
        ...(entry.progress ? { progress: { ...entry.progress } } : {}),
        ...(entry.failureCode ? { failureCode: entry.failureCode } : {}) })) }
  }
  let visibleSignature = JSON.stringify(snapshot())
  function status(): RetrievalPrefetchStatus { return { revision, ...snapshot() } }
  function observe(callback: () => unknown): void {
    try { void Promise.resolve(callback()).catch(() => undefined) } catch { /* Passive task observers do not own execution. */ }
  }
  function notify(): void {
    const next = JSON.stringify(snapshot())
    if (next === visibleSignature) return
    visibleSignature = next; revision = crypto.randomUUID()
    if (ports.onChange) observe(() => ports.onChange!(status()))
    for (const listener of [...listeners]) observe(listener)
  }
  function refresh(): void {
    if (disposed || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed || suspended) return
      try { reconcile() } catch (error) {
        lastFailure = failureCode(error)
        entries.clear(); priority.clear(); running?.controller.abort()
        notify()
      }
    })
  }
  function run(entry: Entry): void {
    entry.state = 'running'
    const controller = new AbortController()
    const task: Running = { entry, controller, promise: Promise.resolve() }
    // Register the task before invoking the port. Opening a file never awaits
    // model work, and synchronous observers cannot start a second background lane.
    running = task
    task.promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      await ports.prepare(entry.document.sessionId, { documentId: entry.document.id,
        ...(entry.rebuild ? { rebuild: true } : {}) }, controller.signal, progress => {
        if (controller.signal.aborted || entries.get(documentKey(entry.document)) !== entry || entry.state !== 'running') return
        const parsed = indexingProgressSchema.safeParse(progress)
        if (!parsed.success) return
        entry.progress = parsed.data
        notify()
      })
      controller.signal.throwIfAborted()
      if (entries.get(documentKey(entry.document)) === entry) entry.state = 'ready'
    }).catch(error => {
      if (!controller.signal.aborted && entries.get(documentKey(entry.document)) === entry) {
        entry.state = 'failed'; entry.failureCode = failureCode(error)
      }
    }).finally(() => {
      if (running === task) running = undefined
      notify(); refresh()
    })
    notify()
  }
  function reconcile(): void {
    const selection = ports.selection()
    const desired = new Map<string, { document: RetrievalPrefetchDocument; signature: string }>()
    let skipped = 0
    if (selection) {
      const available = new Map(ports.documents().filter(document => !document.conflict).map(document => [documentKey(document), document]))
      for (const key of priority) if (!available.has(key)) priority.delete(key)
      const ordered = new Set([...priority].reverse().concat([...available.keys()]))
      for (const key of ordered) {
        const document = available.get(key)!
        if (document.conflict) continue
        if (desired.has(key)) continue
        if (desired.size >= maximum) { skipped++; continue }
        desired.set(key, { document: { ...document }, signature: signatureFor(selection.identity, document) })
      }
    }
    skippedDocuments = skipped; lastFailure = undefined
    for (const [key, entry] of entries) {
      if (desired.get(key)?.signature === entry.signature) continue
      entries.delete(key)
      if (running?.entry === entry) running.controller.abort()
    }
    for (const [key, value] of desired) {
      if (!entries.has(key)) entries.set(key, { ...value, occurrence: ++occurrence, state: 'queued' })
    }
    if (!running) {
      const next = [...desired.keys()].map(key => entries.get(key)!).find(entry => entry.state === 'queued')
      if (next) { run(next); return }
    }
    notify()
  }
  const unsubscribe = ports.subscribe?.(refresh) ?? (() => {})
  function ownedDocument(sessionId: string, id: string): RetrievalPrefetchDocument {
    if (disposed) fail('pdf/cancelled', 'PDF indexing is unloading.')
    const document = ports.documents().find(document => document.sessionId === sessionId && document.id === id)
    if (!document) return fail('pdf/unknown-document', 'PDF indexing requires an open document in this session.')
    return document
  }
  function enqueue(sessionId: string, id: string, rebuild: boolean): void {
    const document = ownedDocument(sessionId, id)
    if (suspended) fail('pdf/retrieval-busy', 'PDF indexes are being reset. Retry shortly.')
    if (document.conflict) fail('pdf/stale-reader', 'Resolve the PDF source conflict before indexing.')
    let selection: { identity: string } | undefined
    try { selection = ports.selection() } catch { fail('pdf/retrieval-engine-unavailable', 'Configure an available semantic search engine before indexing.') }
    if (!selection) return fail('pdf/retrieval-engine-unavailable', 'Enable semantic search before indexing.')
    const key = documentKey(document), previous = entries.get(key)
    const signature = signatureFor(selection.identity, document)
    if (previous?.signature === signature && (rebuild
      ? previous.rebuild && ['queued', 'running'].includes(previous.state)
      : ['queued', 'running', 'ready'].includes(previous.state))) return
    priority.delete(key); priority.add(key)
    if (priority.size > maximum) priority.delete(priority.values().next().value!)
    entries.set(key, { document: { ...document }, signature, occurrence: ++occurrence, state: 'queued',
      ...(rebuild ? { rebuild: true } : {}) })
    if (running && running.entry === previous) running.controller.abort()
    reconcile()
  }
  refresh()
  return {
    refresh,
    status,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start(sessionId: string, id: string): void {
      enqueue(sessionId, id, false)
    },
    rebuild(sessionId: string, id: string): void {
      enqueue(sessionId, id, true)
    },
    cancel(sessionId: string, id: string): void {
      ownedDocument(sessionId, id)
      const entry = entries.get(JSON.stringify([sessionId, id]))
      if (!entry || ['ready', 'failed', 'cancelled'].includes(entry.state)) return
      entry.state = 'cancelled'
      if (running?.entry === entry) running.controller.abort()
      notify()
    },
    async suspend(): Promise<void> {
      if (disposed) return
      suspended = true; entries.clear(); priority.clear(); skippedDocuments = 0
      const active = running
      active?.controller.abort()
      notify()
      await active?.promise
    },
    resume(): void {
      if (disposed) return
      suspended = false; refresh()
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      disposed = true; entries.clear(); priority.clear(); skippedDocuments = 0
      const active = running
      let failure: { error: unknown } | undefined
      // Even a faulty subscription disposer cannot bypass the operation drain.
      // Register the promise first because abort listeners may dispose reentrantly.
      disposal = Promise.resolve().then(async () => {
        await active?.promise
        listeners.clear()
        if (failure) throw failure.error
      })
      try { unsubscribe() } catch (error) { failure = { error } }
      active?.controller.abort(); notify()
      return disposal
    },
  }
}
