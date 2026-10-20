/** Agent-owned document lifetime has no dependency on DSH or the PDF reader implementation. */
export interface BackgroundWorkspacePort {
  isUiOwned(sessionId: string, documentId: string): boolean
  releaseBackground(sessionId: string, documentId: string): Promise<'released' | 'retained-ui' | 'already-closed'>
}

export interface BackgroundReaderPort {
  releaseDocument(documentId: string): Promise<unknown>
}

const MAX_DOCUMENTS_PER_SESSION = 4
const MAX_BYTES_PER_SESSION = 128 * 1024 * 1024
const MAX_BYTES_GLOBAL = 256 * 1024 * 1024
const IDLE_MS = 10 * 60 * 1000
const SWEEP_MS = 60 * 1000

interface Entry { sessionId: string; documentId: string; bytes: number; touched: number }
const key = (sessionId: string, documentId: string) => JSON.stringify([sessionId, documentId])

/** Bounds only Agent-owned copies; a Client-opened copy always remains with the reader UI. */
export function createBackgroundDocuments(workspaces: BackgroundWorkspacePort, pdfService: BackgroundReaderPort,
  options: { now?: () => number; schedule?: boolean } = {}) {
  const entries = new Map<string, Entry>()
  const sessionEpochs = new Map<string, number>()
  const now = options.now ?? Date.now
  let operations: Promise<unknown> = Promise.resolve()
  let stopped = false

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = operations.catch(() => undefined).then(task)
    operations = next.then(() => undefined, () => undefined)
    return next
  }

  async function release(entry: Entry): Promise<'released' | 'retained-ui' | 'already-closed'> {
    entries.delete(key(entry.sessionId, entry.documentId))
    const result = await workspaces.releaseBackground(entry.sessionId, entry.documentId)
    if (result === 'released') await pdfService.releaseDocument(entry.documentId)
    return result
  }

  async function prune(): Promise<void> {
    const expiry = now() - IDLE_MS
    for (const entry of [...entries.values()]) if (entry.touched <= expiry) await release(entry)
  }

  async function enforce(sessionId: string): Promise<void> {
    while (true) {
      const session = [...entries.values()].filter(entry => entry.sessionId === sessionId)
      const sessionBytes = session.reduce((sum, entry) => sum + entry.bytes, 0)
      const totalBytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
      if (session.length <= MAX_DOCUMENTS_PER_SESSION && sessionBytes <= MAX_BYTES_PER_SESSION
        && totalBytes <= MAX_BYTES_GLOBAL) return
      // A limit can only be exceeded when entries is nonempty. This loop is
      // serialized, so no other admission or eviction can remove it here.
      const oldest = session.length > MAX_DOCUMENTS_PER_SESSION || sessionBytes > MAX_BYTES_PER_SESSION
        ? session[0]! : entries.values().next().value as Entry
      await release(oldest)
    }
  }

  const timer = options.schedule === false ? undefined : setInterval(() => {
    if (!stopped) void serialize(prune).catch(() => undefined)
  }, SWEEP_MS)
  timer?.unref()

  return {
    epoch(sessionId: string): number { return sessionEpochs.get(sessionId) ?? 0 },
    async adopt(sessionId: string, documentId: string, bytes: number, expectedEpoch = sessionEpochs.get(sessionId) ?? 0): Promise<'background' | 'ui'> {
      return serialize(async () => {
        if (stopped) throw Object.assign(new Error('PDF tools are unloading'), { code: 'pdf/unavailable' })
        if (expectedEpoch !== (sessionEpochs.get(sessionId) ?? 0)) {
          await release({ sessionId, documentId, bytes, touched: now() })
          throw Object.assign(new Error('The session was disposed while opening this PDF'), { code: 'pdf/session-disposed' })
        }
        if (workspaces.isUiOwned(sessionId, documentId)) {
          entries.delete(key(sessionId, documentId))
          return 'ui'
        }
        if (bytes > MAX_BYTES_PER_SESSION) {
          await release({ sessionId, documentId, bytes, touched: now() })
          throw Object.assign(new Error('PDF exceeds the background working-set limit'), { code: 'pdf/background-size' })
        }
        const id = key(sessionId, documentId)
        entries.delete(id)
        entries.set(id, { sessionId, documentId, bytes, touched: now() })
        await prune()
        await enforce(sessionId)
        return 'background'
      })
    },
    touch(sessionId: string, documentId: string): void {
      const id = key(sessionId, documentId)
      const entry = entries.get(id)
      if (entry) { entries.delete(id); entries.set(id, { ...entry, touched: now() }) }
    },
    close(sessionId: string, documentId: string): Promise<'released' | 'retained-ui' | 'already-closed'> {
      return serialize(() => release(entries.get(key(sessionId, documentId))
        ?? { sessionId, documentId, bytes: 0, touched: now() }))
    },
    closeSession(sessionId: string): Promise<void> {
      sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1)
      return serialize(async () => {
        for (const entry of [...entries.values()]) if (entry.sessionId === sessionId) await release(entry)
      })
    },
    dispose(): void { stopped = true; if (timer) clearInterval(timer); entries.clear(); sessionEpochs.clear() },
    diagnostics(): { documents: number; bytes: number } {
      return { documents: entries.size, bytes: [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }
    },
  }
}
