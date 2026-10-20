import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { createReadingPositionService, type ReadingPositionRecord } from '../../../src/host/reading-positions.ts'
import type { DraftRecord } from '../../../src/modules/working-copy/index.ts'
import { createWorkspaces, type HostWorkspaceSnapshot } from '../../../src/host/workspaces.ts'
import { nativeFixture } from '../../native-fixture.ts'

const PATH = '/fixtures/resumed.pdf'
const address = (sessionId: string) => `dsh-resource://file/session/${sessionId}//fixtures/resumed.pdf`
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
/** Storage key the service derives from a path; repeated here to seed and inspect records. */
const keyOf = (path: string) => createHash('sha256').update(path).digest('hex')
const agent = (sessionId: string) => ({ session: { id: sessionId, header: {} } })
const START = { x: 40, y: 300, scale: 1.2, fit: 'custom' as const, viewportAnchor: { x: 0, y: 0 } }

/** Durable records outlive the service, so a restart reuses the same table. */
function storage() {
  const records = new Map<string, ReadingPositionRecord>()
  return { records, table: {
    get: (key: string) => records.get(key),
    async put(key: string, record: ReadingPositionRecord) { records.set(key, structuredClone(record)) },
    async delete(key: string) { records.delete(key) },
  } }
}

/** The service must never write PDF bytes, so `save` stays unreachable. */
function service(current: () => Uint8Array, table: ReturnType<typeof storage>['table']) {
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) { assert.equal(requested, PATH); return PATH },
    async read(_agent, requested) {
      assert.equal(requested, PATH)
      const bytes = current()
      return { path: PATH, bytes, version: digest(bytes), fsVersion: '1', size: bytes.length }
    },
    async save() { throw new Error('Reading positions must never write PDF bytes') },
  }
  const drafts = new Map<string, DraftRecord>()
  const workspaces = createWorkspaces(files, { get: (key: string) => drafts.get(key),
    async put(key: string, value: DraftRecord) { drafts.set(key, value) }, async delete(key: string) { drafts.delete(key) } })
  const positions = createReadingPositionService(workspaces, table)
  const signal = new AbortController().signal
  return {
    async open(sessionId: string): Promise<HostWorkspaceSnapshot> {
      return await workspaces.execute(sessionId, { action: 'open', sessionId, address: address(sessionId) },
        agent(sessionId), signal) as HostWorkspaceSnapshot
    },
    async invoke(sessionId: string, input: Record<string, unknown>): Promise<unknown> {
      return await positions.dispatch(sessionId, { sessionId, ...input }, agent(sessionId), signal)
    },
    async get(sessionId: string, id: string) {
      return await this.invoke(sessionId, { action: 'get', id }) as
        { position: { position: { page: number }, stale: string, updatedAt: string } | null }
    },
    async dispose() { await positions.dispose(); await workspaces.dispose() },
  }
}

/** The coded failure a rejected request reports, or a marker when it succeeded. */
async function rejection(task: Promise<unknown>): Promise<string> {
  try { await task; return 'accepted' } catch (error) { return String((error as { code?: string }).code ?? error) }
}

test('the latest reading position is kept per path and survives a restart', async () => {
  const bytes = await nativeFixture()
  const original = digest(bytes)
  const { records, table } = storage()
  let reader = service(() => bytes, table)
  try {
    const first = await reader.open('first')
    assert.deepEqual(await reader.get('first', first.id), { position: null })

    await reader.invoke('first', { action: 'set', id: first.id, position: { ...START, page: 2 } })
    await reader.invoke('first', { action: 'set', id: first.id, position: { ...START, page: 3 } })
    // One record per path, holding only the latest position.
    assert.equal(records.size, 1)
    assert.equal(records.get(keyOf(PATH))?.position.page, 3)
    assert.equal(records.get(keyOf(PATH))?.sourceHash, original)

    // Another session reads the same path through its own working copy.
    const second = await reader.open('second')
    const resumed = await reader.get('second', second.id)
    assert.equal(resumed.position?.position.page, 3)
    assert.equal(resumed.position?.stale, 'none')
    assert.ok(resumed.position?.updatedAt)

    // Remembering a position never rewrites the PDF.
    assert.equal(digest(bytes), original)

    await reader.dispose()
    reader = service(() => bytes, table)
    const reopened = await reader.open('reopened')
    assert.equal((await reader.get('reopened', reopened.id)).position?.position.page, 3)
  } finally {
    await reader.dispose()
  }
})

test('a position taken from other source bytes is reported, never replayed', async () => {
  let bytes = await nativeFixture()
  const { table } = storage()
  const reader = service(() => bytes, table)
  try {
    const before = await reader.open('before')
    await reader.invoke('before', { action: 'set', id: before.id, position: { ...START, page: 3 } })

    // A rewrite that still has page 3: different bytes, same page number.
    const rewritten = await PDFDocument.create()
    for (let index = 0; index < 4; index++) rewritten.addPage([300, 400])
    bytes = await rewritten.save({ useObjectStreams: false })
    const after = await reader.open('after')
    const changed = await reader.get('after', after.id)
    assert.equal(changed.position?.stale, 'content-changed')
    assert.equal(changed.position?.position.page, 3)

    // A shortened rewrite: the page itself is gone, which is the reason to act on.
    const shorter = await PDFDocument.create()
    shorter.addPage([300, 400])
    bytes = await shorter.save({ useObjectStreams: false })
    const third = await reader.open('third')
    assert.equal((await reader.get('third', third.id)).position?.stale, 'page-missing')
  } finally {
    await reader.dispose()
  }
})

test('an out-of-range position, a foreign record and a foreign session are all refused', async () => {
  const bytes = await nativeFixture()
  const { table } = storage()
  const reader = service(() => bytes, table)
  try {
    const snapshot = await reader.open('bounds')
    assert.equal(snapshot.document.pageCount, 4)
    assert.equal(await rejection(reader.invoke('bounds', { action: 'set', id: snapshot.id, position: { ...START, page: 5 } })),
      'pdf/invalid-page')
    // A non-positive page never reaches the storage layer.
    assert.notEqual(await rejection(reader.invoke('bounds', { action: 'set', id: snapshot.id, position: { ...START, page: 0 } })), 'accepted')

    // A record left under this path's key for a different file must not be trusted.
    table.put(keyOf(PATH), { format: 1, path: '/fixtures/other.pdf', sourceHash: digest(bytes),
      position: { ...START, page: 1 }, updatedAt: new Date().toISOString() })
    assert.equal(await rejection(reader.invoke('bounds', { action: 'get', id: snapshot.id })), 'pdf/position-identity')

    // Another session's working copy is not addressable from this one.
    const other = await reader.open('other-session')
    assert.equal(await rejection(reader.invoke('bounds', { action: 'get', id: other.id })), 'pdf/session-mismatch')
  } finally {
    await reader.dispose()
  }
})
