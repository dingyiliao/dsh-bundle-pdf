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
  discardMany(resourceSessionId: string, workspaceIds: readonly string[]): Promise<void>
  discardAddresses(resourceSessionId: string, addresses: readonly string[]): Promise<void>
}

interface PendingTab extends OpenTab { readonly resourceSessionId: string }

interface OwnerRecord {
  owner: PdfSessionOwner
  readonly pending: Set<Promise<WorkspaceSnapshot>>
  readonly workspaces: Map<string, Set<string>>
  readonly release: () => void
  closing: boolean
}

export interface PdfSessionLifecycle {
  /** Register once per tab occurrence; React unmount does not release it. */
  register(owner: PdfSessionOwner): void
  /** Admit an open after previous switch cleanup and retain its eventual workspace identity. */
  open(owner: PdfSessionOwner, sessionId: string, address: string, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  /** Retry an earlier failed cleanup before admitting further opens. */
  drain(): Promise<void>
  dispose(): void
}

/** Close departing Session tabs and discard their shared Host working copies. */
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
  const pendingTabs = new Map<string, PendingTab>()
  const discardedAddresses = new Map<string, Set<string>>()
  let selected = options.currentSession.getSnapshot().key
  let cleanup: Promise<void> | undefined
  let disposed = false

  function assertLive(): void {
    options.signal.throwIfAborted()
    if (disposed) throw new DOMException('PDF Session lifecycle has ended', 'AbortError')
  }

  function forget(record: OwnerRecord): void {
    record.release()
    if (owners.get(record.owner.signal) === record) owners.delete(record.owner.signal)
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
        pendingTabs.set(tabKey(tab), { ...tab, resourceSessionId: file.sessionId })
      } catch { /* Other resource grammars do not belong to this plugin. */ }
    }
  }

  function inventoryChanged(): void {
    if (disposed) return
    const current = options.sidebar.openTabs.getSnapshot()
    for (const [key, tab] of pendingTabs) {
      if (current.some(candidate => sameTab(candidate, tab))) continue
      pendingTabs.delete(key)
      let addresses = discardedAddresses.get(tab.resourceSessionId)
      if (!addresses) { addresses = new Set(); discardedAddresses.set(tab.resourceSessionId, addresses) }
      addresses.add(tab.contentId)
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
    while (closing.size || discardedAddresses.size) {
      assertLive()
      const batch = [...closing]
      const addressBatch = new Map([...discardedAddresses].map(([sessionId, addresses]) => [sessionId, [...addresses]]))
      // Open calls deliberately retain the plugin signal. Even after a tab has
      // closed we must observe its eventual id before deleting its draft.
      await Promise.allSettled(batch.flatMap(record => [...record.pending]))
      assertLive()
      const groups = new Map<string, Set<string>>()
      for (const record of batch) {
        for (const [sessionId, workspaces] of record.workspaces) {
          let ids = groups.get(sessionId)
          if (!ids) { ids = new Set(); groups.set(sessionId, ids) }
          for (const id of workspaces) ids.add(id)
        }
      }
      // A partial failure retains the entire batch. Host discard is idempotent,
      // so retrying cannot resurrect or accidentally reopen any working copy.
      const results = await Promise.allSettled([
        ...[...groups].map(([sessionId, ids]) =>
          ids.size ? options.api.discardMany(sessionId, [...ids]) : Promise.resolve()),
        ...[...addressBatch].map(([sessionId, addresses]) => options.api.discardAddresses(sessionId, addresses)),
      ])
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
      for (const record of batch) { closing.delete(record); forget(record) }
      for (const [sessionId, addresses] of addressBatch) {
        const remaining = discardedAddresses.get(sessionId)
        for (const address of addresses) remaining?.delete(address)
        if (!remaining?.size) discardedAddresses.delete(sessionId)
      }
    }
  }

  function beginCleanup(): Promise<void> {
    if (cleanup) return cleanup
    if (!closing.size && !discardedAddresses.size) return Promise.resolve()
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
    while (cleanup || closing.size || discardedAddresses.size) await (cleanup ?? beginCleanup())
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
      if (updateOwner) existing.owner = owner
      closeIfDeparted(existing)
      return existing
    }
    owner.signal.throwIfAborted()
    const aborted = (): void => {
      // Manual close preserves drafts. Session-switch cleanup owns the record
      // until its pending opens and durable deletion have settled.
      if (!record.closing) forget(record)
    }
    const record: OwnerRecord = {
      owner, pending: new Set(), workspaces: new Map(), closing: false,
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

  function dispose(): void {
    if (disposed) return
    disposed = true
    unsubscribe()
    unsubscribeInventory()
    unsubscribeMounted()
    options.signal.removeEventListener('abort', dispose)
    for (const record of owners.values()) record.release()
    owners.clear()
    closing.clear()
    pendingTabs.clear()
    discardedAddresses.clear()
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  if (options.signal.aborted) dispose()

  return {
    register(owner) { recordFor(owner) },
    async open(owner, sessionId, address, signal) {
      if (sessionId !== owner.resourceSessionId) throw new Error('PDF resource Session mismatch')
      const record = recordFor(owner, false)
      // Waiting calls are not in pending: a closing batch must never wait on
      // an open that is itself waiting for that same batch's cleanup.
      await drain()
      signal?.throwIfAborted()
      owner.signal.throwIfAborted()
      if (record.closing) throw new DOMException('PDF tab closed after Session switch', 'AbortError')
      const pending = options.api.open(sessionId, address, options.signal).then(snapshot => {
        // Capture the Session of this request, including late responses from
        // a document this same occurrence has since navigated away from.
        let ids = record.workspaces.get(sessionId)
        if (!ids) { ids = new Set(); record.workspaces.set(sessionId, ids) }
        ids.add(snapshot.id)
        return snapshot
      })
      record.pending.add(pending)
      try {
        const snapshot = await pending
        signal?.throwIfAborted()
        owner.signal.throwIfAborted()
        if (record.closing) throw new DOMException('PDF tab closed after Session switch', 'AbortError')
        return snapshot
      } finally { record.pending.delete(pending) }
    },
    drain,
    dispose,
  }
}
