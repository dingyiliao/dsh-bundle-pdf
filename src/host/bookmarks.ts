import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PdfUserBookmark } from '../shared/contracts.ts'
import type { createWorkspaces } from './workspaces.ts'
import type { PdfDispatch } from './transport.ts'

const id = z.string().min(1).max(512)
const title = z.string().trim().min(1).max(200)
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const anchor = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict()
export const bookmarkPositionSchema = z.object({
  page: z.number().int().min(1).max(100000), x: z.number().finite(), y: z.number().finite(),
  scale: z.number().finite().positive(), fit: z.enum(['custom', 'width', 'page']),
  viewportAnchor: anchor.optional(),
}).strict()
const storedBookmarkSchema = z.object({
  id: z.string().uuid(), title, position: bookmarkPositionSchema, sourceHash: hash,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict()
export const bookmarkRecordSchema = z.object({
  format: z.literal(1), path: z.string().min(1).max(32768), entries: z.array(storedBookmarkSchema).max(1000),
}).strict()
export type BookmarkRecord = z.infer<typeof bookmarkRecordSchema>

interface BookmarkTable {
  get(key: string): BookmarkRecord | undefined
  put(key: string, value: BookmarkRecord): Promise<void>
  delete(key: string): Promise<unknown>
}
const requests = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), sessionId: id, id }).strict(),
  z.object({ action: z.literal('add'), sessionId: id, id, title, position: bookmarkPositionSchema }).strict(),
  z.object({ action: z.literal('rename'), sessionId: id, id, bookmarkId: z.string().uuid(), title }).strict(),
  z.object({ action: z.literal('remove'), sessionId: id, id, bookmarkId: z.string().uuid() }).strict(),
])

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }
function storageKey(path: string): string { return createHash('sha256').update(pathKey(path)).digest('hex') }

/** Each document path owns a durable, serialized plugin-only bookmark list. */
export function createBookmarkService(workspaces: ReturnType<typeof createWorkspaces>, table: BookmarkTable) {
  const queues = new Map<string, Promise<unknown>>()
  let closed = false
  const dispatch: PdfDispatch = async (sessionId, raw, agent, signal) => {
    if (closed) fail('pdf/unavailable', 'The PDF plugin is unloading')
    const input = requests.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) fail('pdf/session-mismatch', 'Session identity mismatch')
    const snapshot = workspaces.readSnapshot(sessionId, input.id)
    const path = snapshot.path
    const key = storageKey(path)
    const before = queues.get(key) ?? Promise.resolve()
    const task = before.catch(() => undefined).then(async (): Promise<PdfUserBookmark[]> => {
      signal.throwIfAborted()
      const stored = table.get(key)
      if (stored && pathKey(stored.path) !== pathKey(path)) fail('pdf/bookmark-identity', 'Stored bookmarks belong to another PDF path')
      const entries = stored?.entries ?? []
      let next = entries
      if (input.action === 'add') {
        if (entries.length >= 1000) fail('pdf/bookmark-limit', 'This PDF has reached the bookmark limit')
        if (input.position.page > snapshot.document.pageCount) fail('pdf/invalid-page', 'Bookmark page is outside the document')
        const now = new Date().toISOString()
        next = [...entries, { id: randomUUID(), title: input.title, position: input.position,
          sourceHash: workspaces.bytesHash(snapshot.bytes), createdAt: now, updatedAt: now }]
      } else if (input.action === 'rename' || input.action === 'remove') {
        const index = entries.findIndex(bookmark => bookmark.id === input.bookmarkId)
        if (index < 0) fail('pdf/bookmark-missing', 'This plugin bookmark no longer exists')
        next = input.action === 'rename'
          ? entries.map((bookmark, item) => item === index ? { ...bookmark, title: input.title, updatedAt: new Date().toISOString() } : bookmark)
          : entries.filter((_, item) => item !== index)
      }
      if (next !== entries) {
        signal.throwIfAborted()
        if (next.length) await table.put(key, { format: 1, path, entries: next })
        else await table.delete(key)
      }
      const currentHash = workspaces.bytesHash(snapshot.bytes)
      return next.map((bookmark): PdfUserBookmark => ({
        id: bookmark.id, title: bookmark.title, position: bookmark.position,
        stale: bookmark.position.page > snapshot.document.pageCount ? 'page-missing'
          : bookmark.sourceHash !== currentHash ? 'content-changed' : 'none',
        createdAt: bookmark.createdAt, updatedAt: bookmark.updatedAt,
      }))
    })
    queues.set(key, task)
    try { return await task } finally { if (queues.get(key) === task) queues.delete(key) }
  }
  return { dispatch, async dispose() { closed = true; await Promise.allSettled([...queues.values()]) } }
}
