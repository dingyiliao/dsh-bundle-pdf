import assert from 'node:assert/strict'
import test from 'node:test'
import { listPageAnnotations, readPageWindow, searchPageWindows, decodeToolCursor, encodeToolCursor,
  type AgentPageReadPort } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { createMemoryEvidenceReferenceStore,
  type EvidenceReferenceStore } from '../../../src/modules/evidence/reference-store.ts'

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
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', fromPage: 1, offset: 0 }, signal)
  assert.deepEqual(first.matches.map(match => [match.page, match.offset]), [[2, 0]])
  assert.equal(typeof first.nextCursor, 'string')
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const second = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', cursor: first.nextCursor! }, signal)
  assert.deepEqual(second.matches.map(match => match.page), [11])
  assert.equal(second.nextCursor, null)
  await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', fromPage: 13 }, signal),
    { code: 'pdf/invalid-page' })
})

test('search continuation resumes within a dense page without duplicate or omitted matches', async () => {
  const snapshot = source(1)
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const text = Array.from({ length: 41 }, () => 'Needle').join(' ')
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot, content: content(text) } } }
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id, { query: 'Needle' }, signal)
  const second = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', cursor: first.nextCursor! }, signal)
  const third = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', cursor: second.nextCursor! }, signal)
  assert.deepEqual([...first.matches, ...second.matches, ...third.matches].map(match => match.offset),
    Array.from({ length: 41 }, (_, index) => index * 7))
  assert.equal(third.nextCursor, null)
})

test('a validly encoded continuation cannot move outside its original single-page scope', async () => {
  const snapshot = source(3), text = Array.from({ length: 41 }, () => 'Needle').join(' ')
  const workspaces = { readSnapshot() { return snapshot } }
  const visited: number[] = []
  const pages: AgentPageReadPort = { async readPageText(_session, _document, page) {
    visited.push(page)
    return { snapshot, content: content(text) }
  } }
  const input = { query: 'Needle', page: 2 }
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id, input, signal)
  const cursor = decodeToolCursor(first.nextCursor!)
  if (cursor.kind !== 'search') assert.fail('Expected a search continuation')
  for (const page of [1, 3]) {
    const altered = encodeToolCursor({ ...cursor, page })
    await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
      { ...input, cursor: altered }, signal), { code: 'pdf/invalid-page' })
  }
  assert.deepEqual(visited, [2], 'out-of-scope cursors fail before reading another page')
})

test('search cursors reject changed query, document, session, version or source bytes', async () => {
  const initial = source()
  let current = initial
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot: current, content: content('Needle') } } }
  const first = await searchPageWindows(workspaces, pages, 'session-1', initial.id, { query: 'Needle' }, signal)
  const cursor = first.nextCursor!
  for (const [sessionId, documentId, query] of [
    ['session-1', initial.id, 'needle'], ['session-2', initial.id, 'Needle'],
    ['session-1', 'doc-2', 'Needle'],
  ]) {
    current = { ...initial, id: documentId! }
    await assert.rejects(searchPageWindows(workspaces, pages, sessionId!, documentId!,
      { query: query!, cursor }, signal), { code: 'pdf/stale-reader' })
  }
  for (const changed of [
    { ...initial, revision: 2 }, { ...initial, contentVersion: 'content-2' },
    { ...initial, bytes: new Uint8Array([9]) },
  ]) {
    current = changed
    await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', initial.id,
      { query: 'Needle', cursor }, signal), { code: 'pdf/stale-reader' })
  }
})

test('search rejects malformed or mixed continuation locators and invalid first-window offsets', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot, content: content('Needle') } } }
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id, { query: 'Needle' }, signal)
  for (const input of [
    { query: 'Needle', cursor: 'invalid' },
    { query: 'Needle', cursor: first.nextCursor!, offset: 0 },
    { query: 'Needle', offset: 7 }, { query: 'Needle', offset: -1 },
  ]) {
    await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', snapshot.id, input, signal),
      { code: 'pdf/invalid-window' })
  }
})

test('search reports blank and OCR pages, respects terminal boundaries and rejects concurrent changes', async () => {
  const initial = source(2)
  let current = initial
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const pages: AgentPageReadPort = { async readPageText(_session, _document, page) {
    return { snapshot: initial, content: page === 1 ? content('') : { ...content('Needle'), extraction: 'local-ocr' } }
  } }
  const result = await searchPageWindows(workspaces, pages, 'session-1', initial.id, { query: 'Needle' }, signal)
  assert.deepEqual(result.noTextPages, [1])
  assert.deepEqual(result.ocrRepairedPages, [2])
  assert.equal(result.nextCursor, null)
  const boundary = await searchPageWindows(workspaces, pages, 'session-1', initial.id,
    { query: 'Needle', fromPage: 2, offset: 6 }, signal)
  assert.deepEqual(boundary.matches, [])
  assert.equal(boundary.nextCursor, null)
  const changed: AgentPageReadPort = { async readPageText() {
    current = { ...initial, bytes: new Uint8Array([8]) }
    return { snapshot: initial, content: content('Needle') }
  } }
  await assert.rejects(searchPageWindows(workspaces, changed, 'session-1', initial.id, { query: 'Needle' }, signal),
    { code: 'pdf/stale-reader' })
})

test('search never returns a partial successful page after cancellation', async () => {
  const snapshot = source()
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const controller = new AbortController()
  const pages: AgentPageReadPort = { async readPageText() {
    controller.abort()
    return { snapshot, content: content('Needle '.repeat(20)) }
  } }
  await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle' }, controller.signal), { name: 'AbortError' })
})

test('search continuation carries the remaining match budget into later pages', async () => {
  const snapshot = source(2)
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const pages: AgentPageReadPort = { async readPageText(_session, _document, page) {
    return { snapshot, content: content(page === 1 ? 'Needle '.repeat(20) : 'Needle') }
  } }
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id, { query: 'Needle' }, signal)
  assert.equal(first.matches.length, 20)
  const second = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', cursor: first.nextCursor! }, signal)
  assert.deepEqual(second.matches.map(match => [match.page, match.offset]), [[2, 0]])
  assert.equal(second.nextCursor, null)
})

test('search evidence captures exact repeated-query ranges rather than surrounding excerpts', async () => {
  const snapshot = source(1)
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const text = 'α 🧠 Needle / Needle tail'
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot, content: content(text) } } }
  const references = createMemoryEvidenceReferenceStore()
  const result = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle' }, signal, references)
  const first = result.matches[0]!.evidence!
  const second = result.matches[1]!.evidence!
  assert.notEqual(first.refId, second.refId)
  assert.deepEqual([first.locator.startUtf16, second.locator.startUtf16], [text.indexOf('Needle'), text.lastIndexOf('Needle')])
  for (const match of result.matches) {
    const evidence = match.evidence!
    const saved = references.get(evidence.refId)!
    assert.equal(saved.sessionId, 'session-1')
    if (saved.evidence.source !== 'pdf-text') assert.fail('Expected saved text evidence')
    assert.equal(saved.evidence.documentId, snapshot.id)
    assert.equal(saved.evidence.snapshot.text, 'Needle')
    assert.equal(saved.evidence.locator.endUtf16, match.offset + 'Needle'.length)
    assert.equal(text.slice(saved.evidence.locator.startUtf16, saved.evidence.locator.endUtf16), 'Needle')
    assert.equal(evidence.snapshot.text.includes('tail'), false)
    assert.equal(evidence.snapshot.text.includes('α'), false)
  }
})

test('search rechecks cancellation and PDF revision after asynchronously persisting evidence', async () => {
  const initial = source(1)
  let current = initial
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return current } }
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot: initial, content: content('Needle') } } }
  const memory = createMemoryEvidenceReferenceStore()
  const changed: EvidenceReferenceStore = { ...memory, async put(key, value) {
    await memory.put(key, value)
    current = { ...initial, revision: 2 }
  } }
  await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', initial.id,
    { query: 'Needle' }, signal, changed), { code: 'pdf/stale-reader' })
  current = initial
  const controller = new AbortController()
  const cancelled: EvidenceReferenceStore = { ...memory, async put(key, value) {
    await memory.put(key, value)
    controller.abort()
  } }
  await assert.rejects(searchPageWindows(workspaces, pages, 'session-1', initial.id,
    { query: 'Needle' }, controller.signal, cancelled), { name: 'AbortError' })
})

test('search provenance output budgets resume at the omitted match without losing evidence', async () => {
  const snapshot = source(1)
  const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
  const text = 'Needle '.repeat(20)
  const pages: AgentPageReadPort = { async readPageText() { return { snapshot, content: {
    ...content(text), warnings: Array.from({ length: 8 }, () => 'w'.repeat(500)),
  } } } }
  const references = createMemoryEvidenceReferenceStore()
  const first = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle' }, signal, references)
  assert.ok(first.matches.length > 0 && first.matches.length < 20)
  assert.ok(JSON.stringify(first).length < 65_000)
  const second = await searchPageWindows(workspaces, pages, 'session-1', snapshot.id,
    { query: 'Needle', cursor: first.nextCursor! }, signal, references)
  assert.deepEqual([...first.matches, ...second.matches].map(match => match.offset),
    Array.from({ length: 20 }, (_, index) => index * 7))
  assert.equal(second.nextCursor, null)
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
