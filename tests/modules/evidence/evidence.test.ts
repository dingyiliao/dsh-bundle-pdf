import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvidenceReader, type EvidenceReferenceStore } from '../../../src/modules/evidence/index.ts'
import { createEvidenceReferenceStore } from '../../../src/adapters/host/storage/evidence-references.ts'
import { approximateTextRects } from '../../../src/modules/evidence/geometry.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'

const signal = new AbortController().signal

function fixture(texts: string[], referenceStore?: EvidenceReferenceStore) {
  let revision = 1
  let documentId = 'doc-1'
  let path = '/paper.pdf'
  let bytes = Buffer.from('%PDF-test-baseline')
  const snapshot = (): HostWorkspaceSnapshot => ({ id: documentId, path,
    sourceVersion: 'fs-v1', contentVersion: 'content-v1', revision, dirty: false,
    canUndo: false, canRedo: false, conflict: false, bytes,
    document: { pageCount: texts.length } as HostWorkspaceSnapshot['document'] })
  const workspaces = { readSnapshot(sessionId: string, documentId: string) {
    if (sessionId !== 'alice' || documentId !== snapshot().id) {
      throw Object.assign(new Error('Wrong session or document'), { code: 'pdf/session-mismatch' })
    }
    return snapshot()
  } }
  const pages = { async readPageText(sessionId: string, documentId: string, page: number, readSignal: AbortSignal) {
    readSignal.throwIfAborted()
    const current = workspaces.readSnapshot(sessionId, documentId)
    if (page < 1 || page > texts.length) throw Object.assign(new Error('Outside document'), { code: 'pdf/invalid-page' })
    const content = { items: [{ str: texts[page - 1]!, hasEOL: false,
      transform: [1, 0, 0, 1, 0, 0], width: 0, height: 1, dir: 'ltr', fontName: 'test' }],
    styles: {}, lang: null } as NativeTextContent
    return { snapshot: current, content }
  } }
  const reader = createEvidenceReader(workspaces, pages, referenceStore)
  return { reader, workspaces, pages, restart: () => createEvidenceReader(workspaces, pages, referenceStore),
    reopen() { documentId = 'doc-2' }, change() { revision++ }, movePath(next: string) { path = next },
    replaceBytes() { bytes = Buffer.from('%PDF-replaced') } }
}

test('status reports the authorized working copy and does not imply an external-file check', () => {
  const { reader } = fixture(['Example'])
  const status = reader.status('alice', 'doc-1')
  assert.equal(status.pageCount, 1)
  assert.equal(status.sourceVersion, 'fs-v1')
  assert.match(status.sourceDigest, /^sha256:[a-f0-9]{64}$/)
  assert.ok(status.limitations.some(value => value.includes('external changes')))
  assert.throws(() => reader.status('bob', 'doc-1'), { code: 'pdf/session-mismatch' })
})

test('disposing a session removes its in-memory evidence references', async () => {
  const { reader } = fixture(['This is a unique paragraph'])
  const located = await reader.locate('alice', { documentId: 'doc-1', quote: 'unique paragraph' }, signal)
  const refId = located.matches[0]!.evidence.refId
  assert.equal(reader.reference('alice', refId).refId, refId)
  await reader.forgetSession('alice')
  assert.throws(() => reader.reference('alice', refId), { code: 'pdf/reference-unavailable' })
})

test('locate scans at most ten pages, distinguishes partial from not found, and binds its cursor', async () => {
  const pages = Array.from({ length: 12 }, () => '')
  pages[11] = 'Last page answer'
  const { reader, change } = fixture(pages)
  const first = await reader.locate('alice', { documentId: 'doc-1', quote: 'answer' }, signal)
  assert.equal(first.status, 'partial')
  assert.deepEqual(first.coverage.pagesScanned, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(first.matches.length, 0)
  assert.ok(first.coverage.nextCursor)
  const input = { documentId: 'doc-1', quote: 'answer', cursor: first.coverage.nextCursor! }
  const second = await reader.locate('alice', input, signal)
  assert.equal(second.status, 'ok')
  assert.equal(second.matches[0]?.page, 12)
  assert.equal(second.matches[0]?.evidence.precision, 'exact-text')
  assert.equal(second.matches[0]?.evidence.locator.startUtf16, 10)
  assert.ok(second.matches[0]?.evidence.limitations.some(value => value.includes('coordinates')))
  await assert.rejects(reader.locate('alice', { ...input, quote: 'wrong' }, signal), { code: 'pdf/stale-reader' })
  await assert.rejects(reader.locate('bob', input, signal), { code: 'pdf/session-mismatch' })
  change()
  await assert.rejects(reader.locate('alice', input, signal), { code: 'pdf/stale-reader' })
})

test('locate handles same-page repetition, normalized matching and exact absence', async () => {
  const { reader } = fixture(['Alpha alpha\n   ALPHA', 'other'])
  const exact = await reader.locate('alice', { documentId: 'doc-1', quote: 'alpha', page: 1 }, signal)
  assert.equal(exact.status, 'ok')
  assert.deepEqual(exact.matches.map(item => item.offset), [6])
  const folded = await reader.locate('alice', { documentId: 'doc-1', quote: 'alpha', mode: 'normalized', page: 1 }, signal)
  assert.equal(folded.status, 'ambiguous')
  assert.deepEqual(folded.matches.map(item => item.offset), [0, 6, 15])
  const missing = await reader.locate('alice', { documentId: 'doc-1', quote: 'missing', page: 1 }, signal)
  assert.equal(missing.status, 'not_found')
  assert.equal(missing.coverage.nextCursor, null)
})

test('a pagination cursor is rejected when PDF bytes change without a revision bump', async () => {
  const { reader, replaceBytes } = fixture(Array.from({ length: 12 }, () => 'No match here'))
  const first = await reader.locate('alice', { documentId: 'doc-1', quote: 'needle' }, signal)
  assert.equal(first.status, 'partial')
  replaceBytes()
  await assert.rejects(reader.locate('alice', { documentId: 'doc-1', quote: 'needle',
    cursor: first.coverage.nextCursor! }, signal), { code: 'pdf/stale-reader' })
})

test('context is bounded, returns versioned snapshots, and rejects stale or foreign references', async () => {
  const { reader, change, replaceBytes } = fixture(['A'.repeat(3000), 'B'.repeat(3000), 'C'.repeat(3000)])
  const first = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 }, maxPages: 3, maxChars: 8000 }, signal)
  assert.equal(first.status, 'partial')
  assert.equal(first.coverage.actualChars, 8000)
  assert.equal(first.chunks.length, 3)
  assert.equal(first.coverage.actualChars,
    first.chunks.reduce((total, chunk) => total + chunk.evidence.snapshot.text.length, 0))
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 64_000)
  assert.equal(Object.hasOwn(first.chunks[0]!, 'text'), false, 'the model must not receive duplicate body text')
  assert.ok(first.coverage.nextCursor)
  const ref = first.chunks[0]!.evidence.refId
  assert.equal(reader.reference('alice', ref).snapshot.text.length, 3000)
  assert.throws(() => reader.reference('bob', ref), { code: 'pdf/reference-unavailable' })
  const next = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 }, maxPages: 3, maxChars: 8000,
    cursor: first.coverage.nextCursor! }, signal)
  assert.equal(next.chunks[0]?.page, 3)
  assert.equal(next.chunks[0]?.evidence.locator.startUtf16, 2000)
  replaceBytes()
  assert.throws(() => reader.reference('alice', ref), { code: 'pdf/stale-reader' })
  change()
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 }, maxPages: 3, maxChars: 8000,
    cursor: first.coverage.nextCursor! }, signal), { code: 'pdf/stale-reader' })
})

test('query focus requires a unique fully scanned match before producing context', async () => {
  const { reader } = fixture(['one target here', 'other target here'])
  const ambiguous = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'query', quote: 'target' } }, signal)
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.chunks.length, 0)
  const unique = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'query', quote: 'one target' } }, signal)
  assert.equal(unique.status, 'ok')
  assert.equal(unique.chunks[0]?.page, 1)
  assert.match(unique.chunks[0]?.evidence.snapshot.text ?? '', /one target/)
})

test('query context cannot mistake a later locate page for a globally unique match', async () => {
  const { reader } = fixture(['target target target target target target'])
  const first = await reader.locate('alice', { documentId: 'doc-1', quote: 'target' }, signal)
  assert.equal(first.status, 'partial')
  assert.equal(first.matches.length, 5)
  const later = await reader.locate('alice', { documentId: 'doc-1', quote: 'target',
    cursor: first.coverage.nextCursor! }, signal)
  assert.equal(later.status, 'ok')
  assert.equal(later.matches.length, 1)
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'query', quote: 'target' }, cursor: first.coverage.nextCursor! }, signal),
  { code: 'pdf/invalid-window' })
})

test('context output budget counts escaped JSON and never repeats body text', async () => {
  const { reader } = fixture([`UniqueAnchor${'\0'.repeat(11900)}`])
  const result = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 }, maxChars: 12000 }, signal)
  const serialized = JSON.stringify(result)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 64_000)
  assert.equal(result.coverage.actualChars,
    result.chunks.reduce((total, chunk) => total + chunk.evidence.snapshot.text.length, 0))
  assert.equal(serialized.split('UniqueAnchor').length - 1, 1)
  assert.ok(result.coverage.nextCursor)
})

test('references revalidate same page text across annotation revisions and changed PDF bytes', async () => {
  const pages = ['A unique referenced paragraph', 'Another page']
  const { reader, change, replaceBytes } = fixture(pages)
  const located = await reader.locate('alice', { documentId: 'doc-1', quote: 'unique referenced' }, signal)
  const refId = located.matches[0]!.evidence.refId
  change() // an annotation-only draft increments revision without changing page text
  assert.throws(() => reader.reference('alice', refId), { code: 'pdf/stale-reader' })
  const revisionRebound = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'reference', refId }, maxPages: 1 }, signal)
  assert.equal(revisionRebound.revalidatedReference?.from, refId)
  assert.notEqual(revisionRebound.revalidatedReference?.to, refId)
  assert.equal(revisionRebound.chunks[0]?.evidence.revision, 2)
  const digestBefore = revisionRebound.sourceDigest
  replaceBytes() // a save can change source bytes but leave extracted page text identical
  const digestRebound = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'reference', refId }, maxPages: 1 }, signal)
  assert.notEqual(digestRebound.sourceDigest, digestBefore)
  assert.ok(digestRebound.revalidatedReference)
  await assert.rejects(reader.context('bob', { documentId: 'doc-1',
    focus: { kind: 'reference', refId } }, signal), { code: 'pdf/session-mismatch' })
  pages[0] = 'A changed page with the same short phrase: unique referenced'
  change()
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'reference', refId } }, signal), { code: 'pdf/stale-reader' })
})

test('reference revalidation refuses missing, cross-source and removed-page targets', async () => {
  const texts = ['First page', 'Second page unique passage']
  const { reader, change, movePath } = fixture(texts)
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'reference', refId: 'pdfref_missing' } }, signal),
  { code: 'pdf/reference-unavailable' })
  const located = await reader.locate('alice', { documentId: 'doc-1', quote: 'unique passage' }, signal)
  const refId = located.matches[0]!.evidence.refId
  movePath('/different-source.pdf')
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'reference', refId } }, signal), { code: 'pdf/reference-unavailable' })
  movePath('/paper.pdf')
  texts.pop()
  change()
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'reference', refId } }, signal), { code: 'pdf/stale-reader' })
})

test('evidence extraction fails closed if the working copy changes during page text reading', async () => {
  const { workspaces, pages, change } = fixture(['A page of text'])
  const reader = createEvidenceReader(workspaces, {
    async readPageText(owner, documentId, page, abort) {
      const captured = await pages.readPageText(owner, documentId, page, abort)
      change()
      return captured
    },
  })
  await assert.rejects(reader.locate('alice', { documentId: 'doc-1', quote: 'page' }, signal),
    { code: 'pdf/stale-reader' })
})

test('evidence marks glyph-origin rectangles approximate rather than exact painted bounds', async () => {
  const text = 'Hello'
  const snapshot = { id: 'doc-1', path: '/paper.pdf', sourceVersion: 'fs-v1', contentVersion: 'content-v1',
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    bytes: Buffer.from('%PDF-test-geometry'), document: { pageCount: 1,
      pages: [{ page: 1, cropBox: [0, 0, 200, 200] as [number, number, number, number],
        rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false } } satisfies HostWorkspaceSnapshot
  const content = { items: [{ str: text, hasEOL: false, transform: [10, 0, 0, 10, 10, 10],
    width: 50, height: 10, dir: 'ltr', fontName: 'test',
    glyphs: Array.from(text, (_, index) => [10 + index * 10, 10, 10]) }],
  styles: {}, lang: null } as NativeTextContent
  const reader = createEvidenceReader({ readSnapshot: () => snapshot }, {
    async readPageText() { return { snapshot, content } },
  })
  const result = await reader.locate('alice', { documentId: 'doc-1', quote: text }, signal)
  assert.equal(result.matches[0]?.evidence.precision, 'approximate-geometry')
  assert.deepEqual(result.matches[0]?.evidence.locator.rectsPdf, [[10, 8, 60, 18]])
  assert.match(result.matches[0]!.evidence.limitations[0]!, /approximate selection bounds/)
})

test('context rejects invalid limits before reading page text', async () => {
  const { reader } = fixture(['A page of text'])
  for (const input of [{ maxPages: 0 }, { maxPages: 11 }, { maxChars: 1 }, { maxChars: 12001 }]) {
    await assert.rejects(reader.context('alice', { documentId: 'doc-1',
      focus: { kind: 'page-window', page: 1 }, ...input }, signal), { code: 'pdf/invalid-window' })
  }
})

test('context shrinks escaped output windows and paginates before duplicating long path metadata', async () => {
  const { reader, movePath } = fixture(['\0'.repeat(4000), 'Second page'])
  movePath(`/papers/${'a'.repeat(15000)}`)
  const result = await reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 }, maxPages: 2, maxChars: 12000 }, signal)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.coverage.pagesScanned, [1, 2])
  assert.equal(result.chunks.length, 1, 'the second evidence record would exceed the output budget')
  assert.equal(result.chunks[0]!.evidence.snapshot.text.length, 4000)
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64_000)
  assert.ok(result.coverage.nextCursor)
})

test('context rejects even a minimal window when a valid source path cannot fit its output budget', async () => {
  const { reader, movePath } = fixture(['A'])
  movePath(`/papers/${'a'.repeat(32000)}`)
  await assert.rejects(reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 } }, signal), { code: 'pdf/output-too-large' })
})

test('a durable text reference can be replayed after Host restart and re-opened document identity', async () => {
  const records = new Map<string, import('../../../src/modules/evidence/index.ts').SavedReference>()
  const store = createEvidenceReferenceStore({
    get: key => records.get(key),
    put: async (key, value) => { records.set(key, structuredClone(value)) },
    delete: async key => records.delete(key),
    entries: () => records.entries(),
  })
  const { reader, restart, reopen } = fixture(['a reusable paragraph'], store)
  const first = await reader.locate('alice', { documentId: 'doc-1', quote: 'reusable' }, signal)
  const refId = first.matches[0]!.evidence.refId
  reader.dispose()
  reopen()
  const restored = restart()
  const result = await restored.context('alice', { documentId: 'doc-2', focus: { kind: 'reference', refId },
    maxPages: 1 }, signal)
  assert.equal(result.revalidatedReference?.from, refId)
  assert.equal(result.chunks[0]?.evidence.documentId, 'doc-2')
  assert.equal(records.has(refId), true)
  await assert.rejects(restored.context('bob', { documentId: 'doc-2', focus: { kind: 'reference', refId } }, signal),
    { code: 'pdf/session-mismatch' })
  restored.dispose()
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
