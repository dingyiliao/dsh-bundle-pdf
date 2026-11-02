import type { OpenWorkingCopyDocument } from '../../../modules/working-copy/index.js'
import type { RetrievalProgress } from '../../../modules/retrieval/index.js'
import { indexingProgressSchema } from '../../../contracts/indexing.js'
import type { PrefetchDiagnosticEvent, IndexingCancellationReason } from './indexing-diagnostics.js'

export interface RetrievalPrefetchDocument extends Pick<OpenWorkingCopyDocument,
  'sessionId' | 'id' | 'path' | 'contentVersion' | 'sourceDigest' | 'conflict'> {}
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
  planId?: string
  started?: boolean
  lastServed?: number
  boost?: boolean
}
interface Running { entry: Entry; controller: AbortController; promise: Promise<void> }
interface Ports {
  /** Only real UI/model owners belong here; indexing leases are not owners. */
  documents(): readonly RetrievalPrefetchDocument[]
  /** A stable saved binding/registration identity, not mutable discovery metadata. */
  selection(document: RetrievalPrefetchDocument): { identity: string; planId?: string } | undefined
  prepare(sessionId: string, input: { documentId: string; rebuild?: boolean; indexPlanId?: string }, signal: AbortSignal,
    onProgress?: (progress: RetrievalProgress) => void): Promise<void>
  /** A cooperative quantum: false preserves this occurrence and requeues it. */
  prepareSlice?(sessionId: string, input: { documentId: string; rebuild?: boolean; indexPlanId?: string }, signal: AbortSignal,
    onProgress?: (progress: RetrievalProgress) => void): Promise<boolean>
  subscribe?(listener: () => void): () => void
  onChange?(status: RetrievalPrefetchStatus): void
  onDiagnostic?(event: PrefetchDiagnosticEvent): void
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

/** One owner-aware lane rotates durable quanta; foreground queries share its index. */
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
  let served = 0, priorityBurst = 0

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
  function diagnostic(entry: Entry, event: PrefetchDiagnosticEvent['event'], error?: unknown, reason?: IndexingCancellationReason): void {
    if (ports.onDiagnostic) observe(() => ports.onDiagnostic!({ sessionId: entry.document.sessionId,
      documentId: entry.document.id, occurrence: entry.occurrence, event,
      ...(entry.progress ? { progress: { ...entry.progress } } : {}),
      ...(error !== undefined ? { error } : {}), ...(reason ? { reason } : {}) }))
  }
  function cancelEntry(entry: Entry, reason: IndexingCancellationReason): void {
    if (entry.state !== 'queued' && entry.state !== 'running') return
    entry.state = 'cancelled'; diagnostic(entry, 'cancelled', undefined, reason)
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
        for (const entry of entries.values()) cancelEntry(entry, 'configuration')
        entries.clear(); priority.clear(); running?.controller.abort()
        notify()
      }
    })
  }
  function run(entry: Entry): void {
    entry.state = 'running'
    entry.lastServed = ++served
    entry.boost = false
    const controller = new AbortController()
    const task: Running = { entry, controller, promise: Promise.resolve() }
    // Register the task before invoking the port. Opening a file never awaits
    // model work, and synchronous observers cannot start a second background lane.
    running = task
    let yielded = false
    const computedBeforeSlice = ports.prepareSlice ? entry.progress?.computedChunks ?? 0 : 0
    task.promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const input = { documentId: entry.document.id,
        ...(entry.planId ? { indexPlanId: entry.planId } : {}),
        ...(entry.rebuild ? { rebuild: true } : {}) }
      const progress = (progress: RetrievalProgress) => {
        if (running !== task || controller.signal.aborted || entries.get(documentKey(entry.document)) !== entry || entry.state !== 'running') return
        const parsed = indexingProgressSchema.safeParse(progress)
        if (!parsed.success) return
        const computed = parsed.data.computedChunks
        // Core reports work done by this quantum. The visible occurrence spans
        // all of its quanta, so prior work cannot become a cache hit at resume.
        const totalComputed = Math.min(parsed.data.embeddedChunks, computedBeforeSlice + (computed ?? 0))
        entry.progress = ports.prepareSlice && computed !== undefined
          ? { ...parsed.data, computedChunks: totalComputed, reusedChunks: parsed.data.embeddedChunks - totalComputed }
          : parsed.data
        diagnostic(entry, 'progress')
        notify()
      }
      const complete = ports.prepareSlice
        ? await ports.prepareSlice(entry.document.sessionId, input, controller.signal, progress)
        : await ports.prepare(entry.document.sessionId, input, controller.signal, progress).then(() => true)
      controller.signal.throwIfAborted()
      if (entries.get(documentKey(entry.document)) === entry) {
        if (complete) { entry.state = 'ready'; diagnostic(entry, 'ready') }
        else { entry.state = 'queued'; yielded = true }
      }
    }).catch(error => {
      if (!controller.signal.aborted && entries.get(documentKey(entry.document)) === entry) {
        entry.state = 'failed'; entry.failureCode = failureCode(error)
        diagnostic(entry, 'failed', error)
      }
    }).finally(() => {
      if (running === task) running = undefined
      notify()
      // A fully cached slice can settle synchronously. Yield the event loop
      // between incomplete quanta, even with a single document, so cancellation
      // and Reader input remain observable instead of a microtask-only loop.
      if (yielded) setImmediate(refresh)
      else refresh()
    })
    if (!entry.started) { entry.started = true; diagnostic(entry, 'started') }
    notify()
  }
  function reconcile(): void {
    const desired = new Map<string, { document: RetrievalPrefetchDocument; signature: string; planId?: string }>()
    let skipped = 0
    const owned = new Map(ports.documents().map(document => [documentKey(document), document]))
    {
      const available = new Map([...owned].filter(([, document]) => !document.conflict))
      for (const key of priority) if (!available.has(key)) priority.delete(key)
      const ordered = new Set([...priority].reverse().concat([...available.keys()]))
      for (const key of ordered) {
        const document = available.get(key)!
        const selection = ports.selection(document)
        if (!selection) continue
        if (desired.size >= maximum) { skipped++; continue }
        desired.set(key, { document: { ...document }, signature: signatureFor(selection.identity, document),
          ...(selection.planId ? { planId: selection.planId } : {}) })
      }
    }
    skippedDocuments = skipped; lastFailure = undefined
    for (const [key, entry] of entries) {
      if (desired.get(key)?.signature === entry.signature) continue
      cancelEntry(entry, desired.has(key) ? 'replaced' : owned.has(key) ? 'configuration' : 'closed')
      entries.delete(key)
      if (running?.entry === entry) running.controller.abort()
    }
    for (const [key, value] of desired) {
      if (!entries.has(key)) {
        const entry: Entry = { ...value, occurrence: ++occurrence, state: 'queued' }
        entries.set(key, entry); diagnostic(entry, 'queued')
      }
    }
    if (!running) {
      const queued = [...desired.keys()].map(key => entries.get(key)!).filter(entry => entry.state === 'queued')
      const boosted = queued.find(entry => entry.boost)
      // Explicit requests receive a bounded fast lane, then oldest-turn work
      // runs. A stream of clicks cannot starve previously admitted documents.
      const fast = boosted && priorityBurst < 2
      const next = fast ? boosted : queued.sort((a, b) => (a.lastServed ?? 0) - (b.lastServed ?? 0))[0]
      if (fast) priorityBurst++; else priorityBurst = 0
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
    let selection: { identity: string; planId?: string } | undefined
    try { selection = ports.selection(document) } catch { fail('pdf/retrieval-engine-unavailable', 'Configure an available semantic search engine before indexing.') }
    if (!selection) return fail('pdf/retrieval-engine-unavailable', 'Enable semantic search before indexing.')
    const key = documentKey(document), previous = entries.get(key)
    const signature = signatureFor(selection.identity, document)
    if (previous?.signature === signature && (rebuild
      ? previous.rebuild && ['queued', 'running'].includes(previous.state)
      : ['queued', 'running', 'ready'].includes(previous.state))) {
      if (previous.state === 'queued') { previous.boost = true; priority.delete(key); priority.add(key); reconcile() }
      return
    }
    priority.delete(key); priority.add(key)
    if (priority.size > maximum) priority.delete(priority.values().next().value!)
    if (previous) cancelEntry(previous, 'replaced')
    const entry: Entry = { document: { ...document }, signature, occurrence: ++occurrence, state: 'queued', boost: true,
      ...(selection.planId ? { planId: selection.planId } : {}),
      ...(rebuild ? { rebuild: true } : {}) }
    entries.set(key, entry); diagnostic(entry, 'queued')
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
      cancelEntry(entry, 'user')
      if (running?.entry === entry) running.controller.abort()
      notify()
    },
    async suspend(): Promise<void> {
      if (disposed) return
      suspended = true
      for (const entry of entries.values()) cancelEntry(entry, 'suspended')
      entries.clear(); priority.clear(); skippedDocuments = 0
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
      disposed = true
      for (const entry of entries.values()) cancelEntry(entry, 'disposed')
      entries.clear(); priority.clear(); skippedDocuments = 0
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
