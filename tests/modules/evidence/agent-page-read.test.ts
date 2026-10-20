import assert from 'node:assert/strict'
import test from 'node:test'
import { listPageAnnotations, readPageWindow, searchPageWindows,
  type AgentPageReadPort } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'

const signal = new AbortController().signal

function source(pageCount = 12, annotations: unknown[] = []): HostWorkspaceSnapshot {
  return { id: 'doc-1', path: '/paper.pdf', sourceVersion: 'fs-1', contentVersion: 'content-1',
    revision: 1, dirty: false, conflict: false, canUndo: false, canRedo: false,
    bytes: new Uint8Array([1, 2, 3]), baselineAnnotations: [],
    document: { pageCount, annotations } } as unknown as HostWorkspaceSnapshot
}

function content(text: string): NativeTextContent {
  return { items: text ? [{ str: text, transform: [1, 0, 0, 1, 0, 0], width: 100,
    height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }] : [],
  styles: {}, lang: null } as NativeTextContent
}

test('page-read use case works with explicit ports and fences stale snapshots', async () => {
  const snapshot = source()
  let version = snapshot
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return version } }
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot, content: content('plain PDF text') } } }
  const result = await readPageWindow(workspaces, pages, 'session-1', snapshot.id, 2, 0, 8000, signal)
  assert.equal(result.text, 'plain PDF text')
  assert.equal(result.sourceVersion, 'fs-1')
  assert.match(result.sourceDigest, /^sha256:/)
  version = { ...snapshot, revision: 2 }
  await assert.rejects(readPageWindow(workspaces, pages, 'session-1', snapshot.id, 2, 0, 8000, signal),
    { code: 'pdf/stale-reader' })
})

test('model search keeps its exact ten-page window and explicit continuation', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const calls: number[] = []
  const pages: AgentPageReadPort = { async readPageText(_session, _document, page) {
    calls.push(page)
    return { snapshot, content: content(page === 2 ? 'Needle and needle' : page === 11 ? 'Needle' : '') }
  } }
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id, 'Needle', 1, 0, signal)
  assert.deepEqual(first.matches.map(match => [match.page, match.offset]), [[2, 0]])
  assert.deepEqual(first.nextCursor, { page: 11, offset: 0 })
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const second = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id, 'Needle', 11, 0, signal)
  assert.deepEqual(second.matches.map(match => match.page), [11])
  assert.equal(second.nextCursor, null)
  await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', snapshot.id, 'Needle', 13, 0, signal),
    { code: 'pdf/invalid-page' })
})

test('annotation listing projects unsaved marks without native text read for notes', async () => {
  const snapshot = source(2, [
    { id: 'a', page: 1, subtype: 'Text', contents: 'Note A', rect: [0, 0, 10, 10] },
    { id: 'b', page: 1, subtype: 'Text', contents: 'Note B', rect: [0, 0, 10, 10] },
    { id: 'link', page: 1, subtype: 'Link', rect: [0, 0, 10, 10] },
  ])
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const pages: AgentPageReadPort = { async readPageText() { throw new Error('Unnecessary native text read') } }
  const first = await listPageAnnotations(workspaces, pages, 'session-1', snapshot.id, 1, undefined, 1, signal)
  assert.equal(first.total, 2)
  assert.deepEqual(first.annotations.map(item => [item.id, item.draft]), [['a', true]])
  assert.ok(first.nextCursor)
  const second = await listPageAnnotations(workspaces, pages, 'session-1', snapshot.id, 1, first.nextCursor!, 1, signal)
  assert.deepEqual(second.annotations.map(item => item.id), ['b'])
  assert.equal(second.nextCursor, null)
  await assert.rejects(listPageAnnotations(workspaces, pages, 'session-1', snapshot.id, 1, 'invalid', 1, signal),
    { code: 'pdf/invalid-window' })
})
