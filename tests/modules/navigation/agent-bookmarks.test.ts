import assert from 'node:assert/strict'
import test from 'node:test'
import { listAgentBookmarks, summarizeOutline, type AgentOutlinePort } from '../../../src/modules/navigation/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal

function source(revision = 1): HostWorkspaceSnapshot {
  return { id: 'doc-1', path: '/paper.pdf', contentVersion: 'content-1', revision,
    document: { pageCount: 4 }, bytes: new Uint8Array([1]) } as HostWorkspaceSnapshot
}


test('outline summary bounds titles, page references and external URLs', () => {
  const rows = summarizeOutline([
    { title: 'A'.repeat(301), dest: [0], items: [{ title: 'Child', dest: [3], items: [] }] },
    { title: 'External', url: 'https://example.com', dest: [4], items: [] },
  ], 4)
  assert.deepEqual(rows.map(({ key, page, depth, children }) => [key, page, depth, children]), [
    ['0', 1, 1, 1], ['0/0', 4, 2, 0], ['1', null, 1, 0],
  ])
  assert.equal(rows[0]?.title.length, 300)
  assert.equal(rows[0]?.titleTruncated, true)
  assert.equal(rows[2]?.externalLink, true)
  assert.equal(JSON.stringify(rows).includes('https://example.com'), false)
})

test('bookmark listing paginates the current embedded outline', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const outline: AgentOutlinePort = { async readOutline() { return { snapshot,
    items: [{ id: 'chapter', title: 'Chapter', dest: [1], items: [
      { id: 'section', title: 'Section', dest: [3], items: [] },
    ] }] } } }
  const first = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, undefined, 1, signal)
  assert.equal(first.total, 2)
  assert.deepEqual(first.entries.map(item => [item.outlineId, item.page]), [['chapter', 2]])
  assert.equal(typeof first.nextCursor, 'string')
  const second = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, first.nextCursor!, 30, signal)
  assert.deepEqual(second.entries.map(item => [item.outlineId, item.page]), [['section', 4]])
  assert.equal(second.nextCursor, null)
  await assert.rejects(listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, 'invalid', 1, signal),
    { code: 'pdf/invalid-window' })
})

test('bookmark continuations reject inserts, deletions and moves rather than duplicating or omitting entries', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const initial = ['A', 'B', 'C'].map(title => ({ id: title, title, dest: [0], items: [] }))
  let items = initial
  const outline: AgentOutlinePort = { async readOutline() { return { snapshot, items } } }
  const first = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, undefined, 2, signal)
  assert.deepEqual(first.entries.map(item => item.title), ['A', 'B'])
  for (const changed of [
    [{ id: 'X', title: 'X', dest: [0], items: [] }, ...initial],
    initial.slice(1), [initial[2]!, initial[0]!, initial[1]!],
  ]) {
    items = changed
    await assert.rejects(listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, first.nextCursor!, 2, signal),
      { code: 'pdf/stale-reader' })
  }
})

test('bookmark cursors bind document, session, revision, content and source digest', async () => {
  const initial = source()
  let current = initial
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const outline: AgentOutlinePort = { async readOutline() { return { snapshot: current,
    items: ['A', 'B'].map(title => ({ title, dest: [0], items: [] })) } } }
  const first = await listAgentBookmarks(workspaces, outline, 'session-1', initial.id, undefined, 1, signal)
  for (const [sessionId, changed] of [
    ['session-2', initial], ['session-1', { ...initial, id: 'doc-2' }],
    ['session-1', { ...initial, revision: 2 }], ['session-1', { ...initial, contentVersion: 'content-2' }],
    ['session-1', { ...initial, bytes: new Uint8Array([9]) }],
  ] as const) {
    current = changed
    await assert.rejects(listAgentBookmarks(workspaces, outline, sessionId, current.id, first.nextCursor!, 1, signal),
      { code: 'pdf/stale-reader' })
  }
})

test('empty outlines terminate, cursor offsets are bounded and limit is validated', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  let items = ['A', 'B'].map(title => ({ title, dest: [0], items: [] }))
  const outline: AgentOutlinePort = { async readOutline() { return { snapshot, items } } }
  const first = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, undefined, 1, signal)
  const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>
  const outside = Buffer.from(JSON.stringify({ ...decoded, offset: 3 })).toString('base64url')
  await assert.rejects(listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, outside, 1, signal),
    { code: 'pdf/invalid-window' })
  for (const limit of [0, -1, 51, 1.5]) {
    await assert.rejects(listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, undefined, limit, signal),
      { code: 'pdf/invalid-window' })
  }
  items = []
  const empty = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, undefined, undefined, signal)
  assert.deepEqual(empty.entries, [])
  assert.equal(empty.nextCursor, null)
})

test('bookmark reads reject cancellation and source changes during native extraction', async () => {
  const initial = source()
  let current = initial
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const controller = new AbortController()
  const cancelled: AgentOutlinePort = { async readOutline() { controller.abort(); return { snapshot: initial, items: [] } } }
  await assert.rejects(listAgentBookmarks(workspaces, cancelled, 'session-1', initial.id, undefined, undefined, controller.signal),
    { name: 'AbortError' })
  const changed: AgentOutlinePort = { async readOutline() {
    current = { ...initial, bytes: new Uint8Array([9]) }
    return { snapshot: initial, items: [] }
  } }
  await assert.rejects(listAgentBookmarks(workspaces, changed, 'session-1', initial.id, undefined, undefined, signal),
    { code: 'pdf/stale-reader' })
})

test('bookmark listing rejects a changed outline snapshot or revision changed during listing', async () => {
  let current = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const staleOutline: AgentOutlinePort = { async readOutline() { return { snapshot: source(2), items: [] } } }
  await assert.rejects(listAgentBookmarks(workspaces, staleOutline,
    'session-1', current.id, undefined, undefined, signal), { code: 'pdf/stale-reader' })
  const outline: AgentOutlinePort = { async readOutline() { current = source(2)
    return { snapshot: source(), items: [] } } }
  await assert.rejects(listAgentBookmarks(workspaces, outline,
    'session-1', current.id, undefined, undefined, signal), { code: 'pdf/stale-reader' })
})
