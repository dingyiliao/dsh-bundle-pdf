import type { DocumentResidency, DocumentReleaseStatus } from './ports.js'
export type { DocumentResidency } from './ports.js'
export type DocumentRelease = DocumentReleaseStatus

/** Residency policy over the working-copy registry, not a second document table. */
export interface BackgroundWorkspacePort {
  listDocuments(): DocumentResidency[]
  isUiOwned(sessionId: string, documentId: string): boolean
  touch(sessionId: string, documentId: string): void
  onIdle(listener: () => void): () => void
  suspend(sessionId: string, documentId: string, evict?: () => Promise<unknown>): Promise<DocumentRelease>
  releaseBackground(sessionId: string, documentId: string, evict?: () => Promise<unknown>, expectedReferenceId?: string | null): Promise<DocumentRelease>
}

export interface BackgroundReaderPort {
  releaseDocument(documentId: string): Promise<unknown>
}

const MAX_DOCUMENTS_PER_SESSION = 4
const MAX_BYTES_PER_SESSION = 128 * 1024 * 1024
const MAX_BYTES_GLOBAL = 256 * 1024 * 1024
const IDLE_MS = 10 * 60 * 1000
const SWEEP_MS = 60 * 1000

/** Logical IDs/drafts belong to Workspaces; only resident resources expire. */
export function createBackgroundDocuments(workspaces: BackgroundWorkspacePort, pdfService: BackgroundReaderPort,
  options: { now?: () => number; schedule?: boolean } = {}) {
  const sessionEpochs = new Map<string, number>()
  const now = options.now ?? Date.now
  let operations: Promise<unknown> = Promise.resolve()
  let stopped = false

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = operations.catch(() => undefined).then(task)
    operations = next.then(() => undefined, () => undefined)
    return next
  }

  const resident = () => workspaces.listDocuments().filter(entry => entry.resident && !entry.uiReferences)
  const releaseNative = (id: string) => () => pdfService.releaseDocument(id)
  const suspend = (entry: DocumentResidency) => workspaces.suspend(entry.sessionId, entry.id, releaseNative(entry.id))

  async function prune(): Promise<void> {
    if (stopped) return
    const expiry = now() - IDLE_MS
    for (const entry of resident()) {
      if (!entry.pins && (!entry.modelOwned || entry.touched <= expiry)) await suspend(entry)
    }
  }

  async function enforce(): Promise<void> {
    // In-flight operations can temporarily exceed the budget. Their final
    // unpin retries this policy; never spin or destroy an active document.
    const attempted = new Set<string>()
    while (!stopped) {
      const all = resident()
      const sessions = new Map<string, { count: number; bytes: number }>()
      for (const entry of all) {
        const totals = sessions.get(entry.sessionId) ?? { count: 0, bytes: 0 }
        totals.count++; totals.bytes += entry.bytes; sessions.set(entry.sessionId, totals)
      }
      const overSession = [...sessions].find(([, total]) =>
        total.count > MAX_DOCUMENTS_PER_SESSION || total.bytes > MAX_BYTES_PER_SESSION)?.[0]
      const overGlobal = all.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_BYTES_GLOBAL
      if (!overSession && !overGlobal) return
      const oldest = all.filter(entry => !entry.pins && !attempted.has(entry.id)
        && (!overSession || entry.sessionId === overSession))
        .sort((left, right) => left.touched - right.touched)[0]
      if (!oldest) return
      attempted.add(oldest.id)
      await suspend(oldest)
    }
  }

  async function reclaim(): Promise<void> { await prune(); await enforce() }
  const stopIdle = workspaces.onIdle(() => {
    if (!stopped) void serialize(reclaim).catch(() => undefined)
  })
  const timer = options.schedule === false ? undefined : setInterval(() => {
    if (!stopped) void serialize(reclaim).catch(() => undefined)
  }, SWEEP_MS)
  timer?.unref()

  return {
    epoch(sessionId: string): number { return sessionEpochs.get(sessionId) ?? 0 },
    async adopt(sessionId: string, documentId: string, bytes: number,
      expectedEpoch = sessionEpochs.get(sessionId) ?? 0, referenceId?: string): Promise<'background' | 'ui'> {
      return serialize(async () => {
        if (stopped) throw Object.assign(new Error('PDF tools are unloading'), { code: 'pdf/unavailable' })
        if (expectedEpoch !== (sessionEpochs.get(sessionId) ?? 0)) {
          await workspaces.releaseBackground(sessionId, documentId, releaseNative(documentId), referenceId)
          throw Object.assign(new Error('The session was disposed while opening this PDF'), { code: 'pdf/session-disposed' })
        }
        workspaces.touch(sessionId, documentId)
        const ui = workspaces.isUiOwned(sessionId, documentId)
        if (!ui && bytes > MAX_BYTES_PER_SESSION) {
          await workspaces.releaseBackground(sessionId, documentId, releaseNative(documentId), referenceId)
          throw Object.assign(new Error('PDF exceeds the background working-set limit'), { code: 'pdf/background-size' })
        }
        await reclaim()
        return ui ? 'ui' : 'background'
      })
    },
    touch(sessionId: string, documentId: string): void { workspaces.touch(sessionId, documentId) },
    close(sessionId: string, documentId: string): Promise<DocumentRelease> {
      const referenceId = workspaces.listDocuments().find(entry => entry.sessionId === sessionId && entry.id === documentId)?.modelReferenceId ?? null
      return serialize(() => workspaces.releaseBackground(sessionId, documentId, releaseNative(documentId), referenceId))
    },
    closeSession(sessionId: string): Promise<void> {
      sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1)
      const departing = workspaces.listDocuments().filter(entry => entry.sessionId === sessionId && entry.modelOwned)
      return serialize(async () => {
        for (const entry of departing) {
          await workspaces.releaseBackground(sessionId, entry.id, releaseNative(entry.id), entry.modelReferenceId)
        }
      })
    },
    async sweep(): Promise<void> { await serialize(reclaim) },
    async dispose(): Promise<void> {
      if (stopped) { await operations; return }
      stopped = true
      if (timer) clearInterval(timer)
      stopIdle()
      await operations
      sessionEpochs.clear()
    },
    diagnostics(): { documents: number; bytes: number } {
      const all = resident()
      return { documents: all.length, bytes: all.reduce((sum, entry) => sum + entry.bytes, 0) }
    },
  }
}
