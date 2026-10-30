import assert from 'node:assert/strict'
import test from 'node:test'
import { observePdfStatus, createMemoryEvidenceReferenceStore, createTextRangeReferences,
  readPageWindow, searchPageWindows, type EvidenceReferenceStore } from '../../../src/modules/evidence/index.ts'
import { createEvidenceReferenceStore } from '../../../src/adapters/host/storage/evidence-references.ts'
import { approximateTextRects } from '../../../src/modules/evidence/geometry.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'

const signal = new AbortController().signal
function fixture(texts: string[], supplied?: EvidenceReferenceStore) {
  let revision = 1, documentId = 'doc-1', path = '/paper.pdf', bytes = Buffer.from('%PDF-test')
  const snapshot = (): HostWorkspaceSnapshot => ({ id: documentId, path, sourceVersion: 'fs-v1',
    contentVersion: 'content-v1', revision, dirty: false, canUndo: false, canRedo: false,
    conflict: false, bytes, document: { pageCount: texts.length } as HostWorkspaceSnapshot['document'] })
  const workspaces = { readSnapshot(session: string, id: string) {
    if (session !== 'alice' || id !== documentId) throw Object.assign(new Error('Not owned'), { code: 'pdf/session-mismatch' })
    return snapshot()
  } }
  const pages = { async readPageText(session: string, id: string, page: number, abort: AbortSignal) {
    abort.throwIfAborted()
    if (page < 1 || page > texts.length) throw Object.assign(new Error('Outside page'), { code: 'pdf/invalid-page' })
    return { snapshot: workspaces.readSnapshot(session, id), content: { items: [{ str: texts[page - 1]!,
      hasEOL: false, transform: [1, 0, 0, 1, 0, 0], width: 0, height: 1, dir: 'ltr', fontName: 'test' }],
      styles: {}, lang: null } as NativeTextContent }
  } }
  const references = supplied ?? createMemoryEvidenceReferenceStore()
  return { pages, workspaces, references,
    range: createTextRangeReferences(workspaces, pages, references),
    restart: () => createTextRangeReferences(workspaces, pages, references),
    change() { revision++ }, reopen() { documentId = 'doc-2' }, movePath(next: string) { path = next },
    replaceBytes() { bytes = Buffer.from('%PDF-changed') } }
}

test('status observes the authorized copy without opening another owner or checking the disk', () => {
  const f = fixture(['Example'])
  const result = observePdfStatus(f.workspaces, 'alice', 'doc-1')
  assert.equal(result.pageCount, 1)
  assert.match(result.sourceDigest, /^sha256:/)
  assert.ok(result.limitations.some(value => value.includes('external changes')))
  assert.throws(() => observePdfStatus(f.workspaces, 'bob', 'doc-1'), { code: 'pdf/session-mismatch' })
})

test('keyword matching unifies exact and normalized modes while preserving original offsets', async () => {
  const f = fixture(['Alpha alpha\n   ALPHA', 'outside'])
  const exact = await searchPageWindows(f.workspaces, f.pages, 'alice', 'doc-1', { page: 1, query: 'alpha' }, signal, f.references)
  assert.deepEqual(exact.matches.map(match => [match.offset, match.endOffset]), [[6, 11]])
  const normalized = await searchPageWindows(f.workspaces, f.pages, 'alice', 'doc-1',
    { page: 1, query: 'alpha', mode: 'normalized' }, signal, f.references)
  assert.deepEqual(normalized.matches.map(match => match.offset), [0, 6, 15])
  assert.equal(normalized.nextCursor, null)
  assert.equal(normalized.matches[2]?.evidence?.snapshot.text, 'ALPHA')
})

test('keyword search respects page bounds and rejects spliced normalized or scope continuations', async () => {
  const f = fixture(Array.from({ length: 15 }, (_, index) => `page ${index + 1} needle`))
  const input = { query: 'needle', fromPage: 3, maxPages: 12 }
  const first = await searchPageWindows(f.workspaces, f.pages, 'alice', 'doc-1', input, signal)
  assert.equal(first.throughPage, 12)
  const second = await searchPageWindows(f.workspaces, f.pages, 'alice', 'doc-1', { ...input, cursor: first.nextCursor! }, signal)
  assert.deepEqual(second.matches.map(match => match.page), [13, 14])
  assert.equal(second.nextCursor, null)
  for (const patch of [{ maxPages: 13 }, { fromPage: 1 }, { mode: 'normalized' as const }]) {
    await assert.rejects(searchPageWindows(f.workspaces, f.pages, 'alice', 'doc-1',
      { ...input, ...patch, cursor: first.nextCursor! }, signal), { code: 'pdf/stale-reader' })
  }
})

test('durable references rebind after authorized reopen without recreating the old snapshot', async () => {
  const records = new Map<string, import('../../../src/modules/evidence/index.ts').SavedReference>()
  const store = createEvidenceReferenceStore({ get: key => records.get(key),
    put: async (key, value) => { records.set(key, structuredClone(value)) },
    delete: async key => records.delete(key), entries: () => records.entries() })
  const f = fixture(['a reusable paragraph'], store)
  const page = await readPageWindow(f.workspaces, f.pages, 'alice', 'doc-1', 1, 0, 8000, signal, store)
  const refId = page.evidence!.refId
  f.reopen()
  const result = await f.restart().readEvidence('alice', 'doc-2', refId, signal)
  assert.equal(result.revalidated, true)
  assert.equal(result.pages[0]?.snapshot.text, 'a reusable paragraph')
  assert.equal(result.pages[0]?.documentId, 'doc-2')
  await assert.rejects(f.restart().readEvidence('bob', 'doc-2', refId, signal), { code: 'pdf/reference-unavailable' })
})

test('glyph geometry maps joined offsets without inventing positions for missing or rotated text', () => {
  const page = { page: 1, cropBox: [0, 0, 200, 200] as [number, number, number, number], rotation: 0, userUnit: 1 }
  const makeRun = (str: string, startX: number) => ({ str, transform: [10, 0, 0, 10, startX, 10],
    width: str.length * 10, height: 10, dir: 'ltr', fontName: 'test', hasEOL: false,
    glyphs: Array.from(str).map((_, index) => [startX + index * 10, 10, 10] as [number, number, number]) })
  const content = { items: [makeRun('Hello', 10), makeRun('world', 70)], styles: {}, lang: null } satisfies NativeTextContent
  const rects = approximateTextRects(content, page, 0, 11)
  assert.equal(rects?.length, 2, 'the synthetic joining space has no fake glyph box')
  assert.deepEqual(rects?.[0], [10, 8, 60, 18])
  assert.deepEqual(rects?.[1], [70, 8, 120, 18])
  assert.equal(approximateTextRects(content, page, 5, 6), null, 'synthetic space alone has no geometry')
  assert.equal(approximateTextRects({ ...content, items: [{ ...content.items[0]!, glyphs: undefined }] }, page, 0, 5), null)
  assert.equal(approximateTextRects(content, { ...page, rotation: 90 }, 0, 5), null)
  assert.equal(approximateTextRects(content, { ...page, cropBox: [0, 0, 50, 50] }, 0, 5), null)
})

test('glyph geometry handles a supplementary Unicode scalar as one positioned glyph', () => {
  const content = { items: [{ str: 'A😀B', transform: [10, 0, 0, 10, 10, 10], width: 30,
    height: 10, dir: 'ltr', fontName: 'test', hasEOL: false,
    glyphs: [[10, 10, 10], [20, 10, 10], [30, 10, 10]] }], styles: {}, lang: null } satisfies NativeTextContent
  const page = { page: 1, cropBox: [0, 0, 200, 200] as [number, number, number, number], rotation: 0, userUnit: 1 }
  assert.deepEqual(approximateTextRects(content, page, 1, 3), [[20, 8, 30, 18]])
  assert.equal(approximateTextRects(content, page, 2, 3), null)
})
