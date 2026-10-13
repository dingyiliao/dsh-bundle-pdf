import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { createBookmarkService, type BookmarkRecord } from '../src/host/bookmarks.ts'
import { createWorkspaces, type HostWorkspaceSnapshot } from '../src/host/workspaces.ts'
import type { PdfUserBookmark } from '../src/shared/contracts.ts'
import { nativeFixture } from './native-fixture.ts'

const address = (sessionId: string) => `dsh-resource://file/session/${sessionId}//fixtures/bookmarked.pdf`
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

test('plugin bookmarks survive a new session and restart; changed or missing targets are flagged', async () => {
  let bytes = await nativeFixture()
  let fileRevision = 1
  const path = '/fixtures/bookmarked.pdf'
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) { assert.equal(requested, path); return path },
    async read(_agent, requested) {
      assert.equal(requested, path)
      return { path, bytes, version: digest(bytes), fsVersion: String(fileRevision), size: bytes.length }
    },
    async save() { throw new Error('Bookmark actions must never write PDF bytes') },
  }
  const drafts = new Map<string, any>()
  const bookmarkRecords = new Map<string, BookmarkRecord>()
  const draftTable = { get: (key: string) => drafts.get(key), async put(key: string, record: any) { drafts.set(key, record) },
    async delete(key: string) { drafts.delete(key) } }
  const table = { get: (key: string) => bookmarkRecords.get(key), async put(key: string, record: BookmarkRecord) { bookmarkRecords.set(key, structuredClone(record)) },
    async delete(key: string) { bookmarkRecords.delete(key) } }
  const signal = new AbortController().signal
  const agent = (sessionId: string) => ({ session: { id: sessionId, header: {} } })
  let workspaces = createWorkspaces(files, draftTable)
  let bookmarks = createBookmarkService(workspaces, table)
  const open = async (sessionId: string): Promise<HostWorkspaceSnapshot> => workspaces.execute(sessionId,
    { action: 'open', sessionId, address: address(sessionId) }, agent(sessionId), signal) as Promise<HostWorkspaceSnapshot>
  const invoke = async (sessionId: string, input: Record<string, unknown>): Promise<PdfUserBookmark[]> =>
    bookmarks.dispatch(sessionId, { sessionId, ...input }, agent(sessionId), signal) as Promise<PdfUserBookmark[]>
  try {
    const originalHash = digest(bytes)
    const first = await open('first')
    const start = { x: 40, y: 300, scale: 1.2, fit: 'custom' as const, viewportAnchor: { x: 0, y: 0 } }
    const firstBookmark = (await invoke('first', { action: 'add', id: first.id, title: 'Start', position: { ...start, page: 1 } }))[0]
    const lastBookmark = (await invoke('first', { action: 'add', id: first.id, title: 'Later', position: { ...start, page: 3 } }))[1]
    assert.equal(digest(bytes), originalHash)

    const second = await open('second')
    assert.deepEqual((await invoke('second', { action: 'list', id: second.id })).map(item => item.title), ['Start', 'Later'])
    await invoke('second', { action: 'rename', id: second.id, bookmarkId: firstBookmark.id, title: 'Introduction' })

    const shorter = await PDFDocument.create()
    shorter.addPage([300, 400])
    bytes = await shorter.save({ useObjectStreams: false })
    const shorterHash = digest(bytes)
    fileRevision++
    const third = await open('third')
    const changed = await invoke('third', { action: 'list', id: third.id })
    assert.equal(changed.find(item => item.id === firstBookmark.id)?.stale, 'content-changed')
    assert.equal(changed.find(item => item.id === lastBookmark.id)?.stale, 'page-missing')
    assert.deepEqual(changed.map(item => item.title), ['Introduction', 'Later'])

    await bookmarks.dispose()
    await workspaces.dispose()
    workspaces = createWorkspaces(files, draftTable)
    bookmarks = createBookmarkService(workspaces, table)
    const reopened = await open('reopened')
    assert.equal((await invoke('reopened', { action: 'list', id: reopened.id })).length, 2)
    const afterRemove = await invoke('reopened', { action: 'remove', id: reopened.id, bookmarkId: lastBookmark.id })
    assert.deepEqual(afterRemove.map(item => item.title), ['Introduction'])
    assert.equal(digest(bytes), shorterHash)
  } finally {
    await bookmarks.dispose()
    await workspaces.dispose()
  }
})
