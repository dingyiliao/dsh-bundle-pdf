import assert from 'node:assert/strict'
import test from 'node:test'
import { listAgentBookmarks, summarizeOutline, type AgentOutlinePort } from '../../../src/modules/navigation/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'
import type { PdfUserBookmark } from '../../../src/shared/contracts.ts'

const signal = new AbortController().signal

function source(revision = 1): HostWorkspaceSnapshot {
  return { id: 'doc-1', path: '/paper.pdf', contentVersion: 'content-1', revision,
    document: { pageCount: 4 }, bytes: new Uint8Array([1]) } as HostWorkspaceSnapshot
}

function personal(): PdfUserBookmark[] {
  return [{ id: 'mine', title: 'My bookmark', position: { page: 3 }, stale: 'none',
    createdAt: '2026-01-01', updatedAt: '2026-01-01' } as PdfUserBookmark]
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

test('bookmark listing merges personal and embedded entries through explicit ports', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const outline: AgentOutlinePort = { async readOutline() { return { snapshot,
    items: [{ title: 'Chapter', dest: [1], items: [] }] } } }
  let personalCalls = 0, outlineCalls = 0
  const listPersonal = async () => { personalCalls++; return personal() }
  const trackedOutline: AgentOutlinePort = { async readOutline(...args) {
    outlineCalls++
    return outline.readOutline(...args)
  } }
  const first = await listAgentBookmarks(workspaces, trackedOutline, listPersonal,
    'session-1', snapshot.id, 'all', 0, 1, signal)
  assert.equal(first.total, 2)
  assert.deepEqual(first.entries.map(item => item.key), ['mine'])
  assert.equal(first.nextCursor, 1)
  const second = await listAgentBookmarks(workspaces, trackedOutline, listPersonal,
    'session-1', snapshot.id, 'all', first.nextCursor, 1, signal)
  assert.deepEqual(second.entries.map(item => [item.kind, item.page]), [['embedded', 2]])
  const onlyEmbedded = await listAgentBookmarks(workspaces, trackedOutline, listPersonal,
    'session-1', snapshot.id, 'embedded', undefined, undefined, signal)
  assert.equal(onlyEmbedded.total, 1)
  assert.deepEqual(onlyEmbedded.entries.map(item => item.kind), ['embedded'])
  assert.equal(personalCalls, 2, 'embedded-only listing skips personal storage')
  const onlyPersonal = await listAgentBookmarks(workspaces, trackedOutline, listPersonal,
    'session-1', snapshot.id, 'personal', undefined, undefined, signal)
  assert.deepEqual(onlyPersonal.entries.map(item => item.kind), ['personal'])
  assert.equal(outlineCalls, 3, 'personal-only listing skips native outline')
  await assert.rejects(listAgentBookmarks(workspaces, trackedOutline, listPersonal,
    'session-1', snapshot.id, 'all', 3, 1, signal), { code: 'pdf/invalid-window' })
})

test('bookmark listing rejects a changed outline snapshot or revision changed during listing', async () => {
  let current = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const staleOutline: AgentOutlinePort = { async readOutline() { return { snapshot: source(2), items: [] } } }
  await assert.rejects(listAgentBookmarks(workspaces, staleOutline, async () => [],
    'session-1', current.id, 'embedded', undefined, undefined, signal), { code: 'pdf/stale-reader' })
  const outline: AgentOutlinePort = { async readOutline() { current = source(2)
    return { snapshot: source(), items: [] } } }
  await assert.rejects(listAgentBookmarks(workspaces, outline, async () => [],
    'session-1', current.id, 'embedded', undefined, undefined, signal), { code: 'pdf/stale-reader' })
})
