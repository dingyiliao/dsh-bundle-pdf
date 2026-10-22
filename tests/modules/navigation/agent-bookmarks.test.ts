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
  const first = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, 0, 1, signal)
  assert.equal(first.total, 2)
  assert.deepEqual(first.entries.map(item => [item.outlineId, item.page]), [['chapter', 2]])
  assert.equal(first.nextCursor, 1)
  const second = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, first.nextCursor, 1, signal)
  assert.deepEqual(second.entries.map(item => [item.outlineId, item.page]), [['section', 4]])
  assert.equal(second.nextCursor, null)
  const end = await listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, 2, undefined, signal)
  assert.deepEqual(end.entries, [])
  await assert.rejects(listAgentBookmarks(workspaces, outline, 'session-1', snapshot.id, 3, 1, signal),
    { code: 'pdf/invalid-window' })
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
