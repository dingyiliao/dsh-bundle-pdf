import { z } from 'zod'
import { bookmarkPositionSchema } from './position-schema.js'
import type { NavigationDispatch, NavigationStore, NavigationWorkspaces } from './ports.js'

const id = z.string().min(1).max(512)
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** One latest position per file path, keyed by the source bytes it was read from. */
export const readingPositionRecordSchema = z.object({
  format: z.literal(1), path: z.string().min(1).max(32768), sourceHash: hash,
  position: bookmarkPositionSchema, updatedAt: z.string().datetime(),
}).strict()
export type ReadingPositionRecord = z.infer<typeof readingPositionRecordSchema>

/** Staleness of a stored position against the document open right now. */
export type ReadingPositionStale = 'none' | 'content-changed' | 'page-missing'

/** A stored position plus why it may not apply to the current source bytes. */
export interface StoredReadingPosition {
  position: z.infer<typeof bookmarkPositionSchema>
  stale: ReadingPositionStale
  updatedAt: string
}

const requests = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), sessionId: id, id }).strict(),
  z.object({ action: z.literal('set'), sessionId: id, id, position: bookmarkPositionSchema }).strict(),
])

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
/**
 * Remember where reading stopped, per file path, in plugin storage.
 *
 * The record carries the source-bytes hash it was written from, so a position
 * taken from one revision of a file is not silently trusted for different
 * bytes. V1 also marks annotation-only saves stale because they change PDF
 * bytes; this behavior is retained until a separate stable page-content
 * fingerprint and record migration are available.
 */
export function createReadingPositions(workspaces: NavigationWorkspaces, table: NavigationStore<ReadingPositionRecord>) {
  const queues = new Map<string, Promise<unknown>>()
  let closed = false
  const dispatch: NavigationDispatch = async (sessionId, raw, agent, signal) => {
    if (closed) fail('pdf/unavailable', 'The PDF plugin is unloading')
    const input = requests.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) fail('pdf/session-mismatch', 'Session identity mismatch')
    const snapshot = workspaces.readSnapshot(sessionId, input.id)
    const path = snapshot.path
    const key = table.key(path)
    const before = queues.get(key) ?? Promise.resolve()
    const task = before.catch(() => undefined).then(async (): Promise<{ position: StoredReadingPosition | null } | { stored: true }> => {
      signal.throwIfAborted()
      const stored = table.get(key)
      if (stored && !table.samePath(stored.path, path)) fail('pdf/position-identity', 'Stored reading position belongs to another PDF path')
      if (input.action === 'set') {
        if (input.position.page > snapshot.document.pageCount) fail('pdf/invalid-page', 'Reading position is outside the document')
        signal.throwIfAborted()
        await table.put(key, { format: 1, path, sourceHash: workspaces.bytesHash(snapshot.bytes),
          position: input.position, updatedAt: new Date().toISOString() })
        return { stored: true }
      }
      if (!stored) return { position: null }
      return { position: {
        position: stored.position,
        // Page count first: a shortened document also changed content, and the
        // missing page is the reason the reader can act on.
        stale: stored.position.page > snapshot.document.pageCount ? 'page-missing'
          : stored.sourceHash !== workspaces.bytesHash(snapshot.bytes) ? 'content-changed' : 'none',
        updatedAt: stored.updatedAt,
      } }
    })
    queues.set(key, task)
    try { return await task } finally { if (queues.get(key) === task) queues.delete(key) }
  }
  return { dispatch, async dispose() { closed = true; await Promise.allSettled([...queues.values()]) } }
}
