import type { PdfClientApi, WorkspaceSnapshot } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'

interface Observable<Value> {
  getSnapshot(): Value
  subscribe(listener: () => void): () => void
}

interface OpenTab {
  readonly sessionId: string
  readonly tabId: string
  readonly kind: string
  readonly contentId: string
}

export interface PdfSidebarNavigation {
  readonly mounted: Observable<string | undefined>
  readonly openTabs: Observable<readonly OpenTab[]>
  /** Public navigation only closes a tab of the currently mounted Session. */
  close(tabId: string): void
}

export interface PdfSessionSource {
  getSnapshot(): { readonly key: string | undefined }
  subscribe(listener: () => void): () => void
}

export interface PdfSessionOwner {
  /** Session containing the sidebar tab; it may differ from the resource's Session. */
  readonly containerSessionId: string
  /** Session authorizing reads and mutations of the addressed file. */
  readonly resourceSessionId: string
  readonly tabId: string
  readonly resourceAddress: string
  /** The occurrence lifetime, which survives hiding and switching Sessions. */
  readonly signal: AbortSignal
  readonly close: () => void
}

interface LifecycleApi {
  open: PdfClientApi['open']
  release: PdfClientApi['release']
}

interface OwnerRecord {
  owner: PdfSessionOwner
  readonly referenceId: string
  readonly resourceSessions: Set<string>
  readonly documents: Map<string, { sessionId: string; id: string }>
  readonly release: () => void
  generation: number
  pendingOpens: number
  navigationSettled: boolean
  adopted?: string
  retiring?: Promise<void>
  closing: boolean
}

export interface PdfSessionLifecycle {
  /** Register once per tab occurrence; React unmount does not release it. */
  register(owner: PdfSessionOwner): void
  /** Admit an open after previous switch cleanup and retain its eventual workspace identity. */
  open(owner: PdfSessionOwner, sessionId: string, address: string, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  /** Retry an earlier failed cleanup before admitting further opens. */
  drain(): Promise<void>
  dispose(): Promise<void>
}

/** Close departing tabs and release only their views of shared Host drafts. */
export function createPdfSessionLifecycle(options: {
  readonly currentSession: PdfSessionSource
  readonly sidebar: PdfSidebarNavigation
  readonly api: LifecycleApi
  readonly signal: AbortSignal
  readonly onError?: (error: unknown) => void
}): PdfSessionLifecycle {
  const owners = new Map<AbortSignal, OwnerRecord>()
  const closing = new Set<OwnerRecord>()
  // These exact records were present when their Session was left. A missing
  // record is retired, so a later new tab with the same id is never targeted.
  const pendingTabs = new Map<string, OpenTab>()
  let selected = options.currentSession.getSnapshot().key
  let cleanup: Promise<void> | undefined
  let disposed = false
  let disposal: Promise<void> | undefined

  function assertLive(): void {
    options.signal.throwIfAborted()
    if (disposed) throw new DOMException('PDF Session lifecycle has ended', 'AbortError')
  }

  function forget(record: OwnerRecord): void {
    record.release()
    if (owners.get(record.owner.signal) === record) owners.delete(record.owner.signal)
  }

  const documentKey = (sessionId: string, id: string) => JSON.stringify([sessionId, id])

  function retirePreviousDocuments(record: OwnerRecord): void {
    if (disposed || record.closing || !record.navigationSettled) return
    const operation = (record.retiring ?? Promise.resolve()).then(async () => {
      if (disposed || record.closing || !record.navigationSettled) return
      const results = await Promise.allSettled([...record.documents].filter(([key]) => key !== record.adopted).map(async ([key, document]) => {
        await options.api.release(document.sessionId, document.id, record.referenceId)
        record.documents.delete(key)
      }))
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
    }).catch(error => {
      // A failed retirement does not hide the new document. Keep its identity
      // for a later retry or the final terminal occurrence release.
      if (!disposed && !options.signal.aborted) options.onError?.(error)
    })
    record.retiring = operation
    void operation.then(() => { if (record.retiring === operation) record.retiring = undefined })
  }

  const tabKey = (tab: OpenTab): string => JSON.stringify([tab.sessionId, tab.tabId])
  const sameTab = (left: OpenTab, right: OpenTab): boolean => left.sessionId === right.sessionId &&
    left.tabId === right.tabId && left.kind === right.kind && left.contentId === right.contentId

  function captureUnvisitedTabs(sessionId: string): void {
    for (const tab of options.sidebar.openTabs.getSnapshot()) {
      if (tab.sessionId !== sessionId || tab.kind !== 'text') continue
      try {
        const file = sessionFile(tab.contentId)
        if (!/\.pdf$/i.test(file.path)) continue
        pendingTabs.set(tabKey(tab), { ...tab })
      } catch { /* Other resource grammars do not belong to this plugin. */ }
    }
  }

  function inventoryChanged(): void {
    if (disposed) return
    const current = options.sidebar.openTabs.getSnapshot()
    for (const [key, tab] of pendingTabs) {
      if (current.some(candidate => sameTab(candidate, tab))) continue
      pendingTabs.delete(key)
    }
    void beginCleanup().catch(() => undefined)
  }

  function closeMountedPending(): void {
    if (disposed) return
    inventoryChanged()
    for (const tab of [...pendingTabs.values()]) {
      // Guard every call: close() intentionally cannot address an old Session.
      // A pending record is retried when its original seat next mounts.
      if (options.sidebar.mounted.getSnapshot() !== tab.sessionId) continue
      if (pendingTabs.get(tabKey(tab)) !== tab) continue
      if (!options.sidebar.openTabs.getSnapshot().some(candidate => sameTab(candidate, tab))) continue
      const registered = [...owners.values()].filter(record => record.owner.containerSessionId === tab.sessionId &&
        record.owner.tabId === tab.tabId && record.owner.resourceAddress === tab.contentId)
      if (registered.length) closeRecords(registered)
      if (pendingTabs.get(tabKey(tab)) !== tab) continue
      if (options.sidebar.mounted.getSnapshot() !== tab.sessionId) continue
      try { options.sidebar.close(tab.tabId) } catch (error) { options.onError?.(error) }
      inventoryChanged()
    }
  }

  async function clean(): Promise<void> {
    while (closing.size) {
      assertLive()
      const batch = [...closing]
      // Closing the named occurrence also covers pending/lost open responses.
      // Host tombstones the token, so cleanup never waits on those responses.
      const results = await Promise.allSettled(batch.flatMap(record =>
        [...record.resourceSessions].map(sessionId =>
          options.api.release(sessionId, undefined, record.referenceId))))
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
      for (const record of batch) { closing.delete(record); forget(record) }
    }
  }

  function beginCleanup(): Promise<void> {
    if (cleanup) return cleanup
    if (!closing.size) return Promise.resolve()
    // Defer until all close callbacks in this synchronous switch have run.
    const operation = Promise.resolve().then(clean)
    cleanup = operation
    void operation.then(
      () => { if (cleanup === operation) cleanup = undefined },
      error => {
        if (cleanup === operation) cleanup = undefined
        if (!disposed && !options.signal.aborted) options.onError?.(error)
      },
    )
    return operation
  }

  async function drain(): Promise<void> {
    assertLive()
    while (cleanup || closing.size) await (cleanup ?? beginCleanup())
    assertLive()
  }

  function closeRecords(records: readonly OwnerRecord[]): void {
    const newlyClosing = records.filter(record => !record.closing)
    for (const record of newlyClosing) {
      record.closing = true
      closing.add(record)
    }
    for (const record of newlyClosing) {
      // Tab ids can be restored by layout undo with a new occurrence. Never
      // invoke an ended occurrence's close callback a second time.
      if (!record.owner.signal.aborted) {
        try { record.owner.close() } catch (error) { options.onError?.(error) }
      }
    }
    // Observe rejection here. A later open calls drain() and retries the
    // retained batch; until that succeeds no new Host open can enter.
    void beginCleanup().catch(() => undefined)
  }

  function closeIfDeparted(record: OwnerRecord): void {
    const { owner } = record
    const pending = pendingTabs.get(JSON.stringify([owner.containerSessionId, owner.tabId]))
    if ((selected !== undefined && selected !== owner.containerSessionId) || pending?.contentId === owner.resourceAddress) {
      closeRecords([record])
    }
  }

  function recordFor(owner: PdfSessionOwner, updateOwner = true): OwnerRecord {
    assertLive()
    const existing = owners.get(owner.signal)
    if (existing) {
      if (existing.owner.containerSessionId !== owner.containerSessionId ||
          existing.owner.tabId !== owner.tabId) {
        throw new Error('A PDF tab occurrence cannot change its container Session or tab identity')
      }
      // Navigation may change the file and its authorizing Session without
      // ending the occurrence. A delayed open from an earlier render must not
      // replace the latest registered close/address metadata.
      if (updateOwner) {
        if (existing.owner.resourceSessionId !== owner.resourceSessionId ||
          existing.owner.resourceAddress !== owner.resourceAddress) {
          existing.generation++
          existing.pendingOpens = 0
          existing.navigationSettled = false
        }
        existing.owner = owner
      }
      closeIfDeparted(existing)
      return existing
    }
    owner.signal.throwIfAborted()
    const aborted = (): void => {
      // Both manual close and Session switches release view references. Neither
      // action owns the shared draft, which may still be used by model tools.
      if (!record.closing) {
        record.closing = true
        closing.add(record)
        void beginCleanup().catch(() => undefined)
      }
    }
    const record: OwnerRecord = {
      owner, referenceId: crypto.randomUUID(), resourceSessions: new Set(), documents: new Map(),
      generation: 0, pendingOpens: 0, navigationSettled: false, closing: false,
      release: () => owner.signal.removeEventListener('abort', aborted),
    }
    owners.set(owner.signal, record)
    owner.signal.addEventListener('abort', aborted, { once: true })
    // A body may mount late, after its Session ceased to be foreground.
    closeIfDeparted(record)
    return record
  }

  const changed = (): void => {
    if (disposed) return
    const next = options.currentSession.getSnapshot().key
    if (next === selected) return
    const previous = selected
    selected = next
    if (previous !== undefined) {
      captureUnvisitedTabs(previous)
      closeRecords([...owners.values()].filter(record => record.owner.containerSessionId === previous))
      closeMountedPending()
    }
  }
  const unsubscribeInventory = options.sidebar.openTabs.subscribe(inventoryChanged)
  const unsubscribeMounted = options.sidebar.mounted.subscribe(closeMountedPending)
  const unsubscribe = options.currentSession.subscribe(changed)
  changed()

  function dispose(): Promise<void> {
    if (disposal) return disposal
    disposed = true
    unsubscribe()
    unsubscribeInventory()
    unsubscribeMounted()
    options.signal.removeEventListener('abort', dispose)
    const records = [...owners.values()]
    for (const record of records) record.release()
    // Teardown RPCs have an independent bounded lifetime: sibling Cordis
    // disposers may already have aborted ordinary PDF requests.
    disposal = Promise.resolve().then(() => Promise.allSettled(records.flatMap(record =>
      [...record.resourceSessions].map(sessionId =>
        Promise.resolve().then(() => options.api.release(sessionId, undefined, record.referenceId)))))).then(() => undefined)
    owners.clear()
    closing.clear()
    pendingTabs.clear()
    return disposal
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  if (options.signal.aborted) dispose()

  return {
    register(owner) { recordFor(owner) },
    async open(owner, sessionId, address, signal) {
      if (sessionId !== owner.resourceSessionId) throw new Error('PDF resource Session mismatch')
      const record = recordFor(owner, false)
      const generation = record.generation
      await drain()
      // Finish an earlier nonterminal release before this occurrence can
      // reacquire that same document/token pair during a rapid A → B → A.
      while (record.retiring) await record.retiring
      signal?.throwIfAborted()
      owner.signal.throwIfAborted()
      if (record.closing) throw new DOMException('PDF tab closed after Session switch', 'AbortError')
      if (record.generation !== generation || record.owner.resourceSessionId !== sessionId ||
        record.owner.resourceAddress !== address) throw new DOMException('PDF navigation was superseded', 'AbortError')
      // Record authorization before dispatch; a failed reply must not leave an
      // acquired Host reference unreachable from this occurrence's cleanup.
      record.resourceSessions.add(sessionId)
      record.pendingOpens++
      record.navigationSettled = false
      try {
        const snapshot = await options.api.open(sessionId, address, options.signal, record.referenceId)
        const key = documentKey(sessionId, snapshot.id)
        record.documents.set(key, { sessionId, id: snapshot.id })
        assertLive()
        owner.signal.throwIfAborted()
        if (record.closing) throw new DOMException('PDF tab closed after Session switch', 'AbortError')
        if (record.generation !== generation) throw new DOMException('PDF navigation was superseded', 'AbortError')
        // Canonical aliases can return the same id. Retire by actual identity,
        // not the addressed string, so alias navigation keeps its shared lease.
        record.adopted = key
        signal?.throwIfAborted()
        return snapshot
      } finally {
        if (record.generation === generation) {
          record.pendingOpens--
          if (!record.pendingOpens) record.navigationSettled = true
        }
        retirePreviousDocuments(record)
      }
    },
    drain,
    dispose,
  }
}
