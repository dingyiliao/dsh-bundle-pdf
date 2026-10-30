import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryEvidenceReferenceStore, createTextRangeReferences, createTextReferenceResolver,
  evidenceSha256, readPageWindow, savedReferenceSchema,
  type EvidenceReferenceStore, type SavedReference } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { isSavedImageReference } from '../../../src/modules/evidence/reference-store.ts'

const signal = new AbortController().signal
function fixture(texts = ['first START alpha', 'middle evidence', 'omega END last']) {
  let current: HostWorkspaceSnapshot = { id: 'doc-1', path: '/paper.pdf', bytes: Buffer.from('source'),
    sourceVersion: 'fs-1', contentVersion: 'content-1', revision: 0, conflict: false,
    dirty: false, canUndo: false, canRedo: false,
    document: { pageCount: texts.length, pages: texts.map(() => ({ cropBox: [0, 0, 100000, 800] })) } as HostWorkspaceSnapshot['document'] }
  let extraction: 'local-ocr' | undefined
  let onRead: (() => void) | undefined
  const workspaces = { readSnapshot(owner: string, id: string) {
    if (owner !== 'alice' || id !== current.id) throw Object.assign(new Error('Not owned'), { code: 'pdf/session-mismatch' })
    return current
  } }
  const pages = { async readPageText(owner: string, id: string, page: number, abort: AbortSignal) {
    abort.throwIfAborted()
    const snapshot = workspaces.readSnapshot(owner, id), text = texts[page - 1]!
    const content: NativeTextContent = { items: [{ str: text, hasEOL: false,
      transform: [12, 0, 0, 12, 60, 200], width: Array.from(text).length * 6, height: 12,
      dir: 'ltr', fontName: 'test', glyphs: Array.from(text, (_, index) => [60 + index * 6, 200, 6]) }],
      styles: {}, lang: null, ...(extraction ? { extraction } : {}) }
    onRead?.()
    return { snapshot, content }
  } }
  const references = createMemoryEvidenceReferenceStore()
  return { workspaces, pages, references, texts,
    ranges: createTextRangeReferences(workspaces, pages, references),
    resolver: createTextReferenceResolver(workspaces, pages, references),
    current: () => current,
    update(patch: Partial<HostWorkspaceSnapshot>) { current = { ...current, ...patch } },
    extraction(value: 'local-ocr') { extraction = value },
    onRead(value: () => void) { onRead = value },
  }
}
const range = { start: { page: 1, quote: 'START' }, end: { page: 3, quote: 'END' } }

test('continuous evidence captures every intervening page and resolves verified native glyphs', async () => {
  const f = fixture()
  const result = await f.ranges.capture('alice', 'doc-1', range, signal)
  assert.deepEqual(result.pages.map(page => page.snapshot.text), ['START alpha', 'middle evidence', 'omega END'])
  assert.deepEqual(result.pages.map(page => page.page), [1, 2, 3])
  assert.equal(f.references.get(result.refId)?.evidence.source, 'pdf-text-range')
  assert.ok(savedReferenceSchema.safeParse(f.references.get(result.refId)).success)
  for (const page of result.pages) await f.references.delete(page.refId)
  const resolved = await f.resolver.resolveRange('alice', 'doc-1', result.refId, signal)
  assert.deepEqual(resolved.pages.map(page => page.text), ['START alpha', 'middle evidence', 'omega END'])
  assert.ok(resolved.pages.every(page => page.quadPoints.length === 8))
})

test('evidence subquotes are scoped to the captured occurrence and can span adjacent pages', async () => {
  const f = fixture()
  const parent = await f.ranges.capture('alice', 'doc-1', range, signal)
  const child = await f.ranges.derive('alice', 'doc-1', parent.refId, 'alpha\nmiddle evidence\nomega', signal)
  assert.deepEqual(child.pages.map(page => page.snapshot.text), ['alpha', 'middle evidence', 'omega'])
  const target = await f.resolver.resolveRange('alice', 'doc-1', child.refId, signal)
  assert.deepEqual(target.pages.map(page => page.page), [1, 2, 3])
  await assert.rejects(f.ranges.derive('alice', 'doc-1', parent.refId, 'first', signal), { code: 'pdf/text-not-found' })
  const repeated = fixture(['START repeated repeated END'])
  const repeatedParent = await repeated.ranges.capture('alice', 'doc-1',
    { start: { page: 1, quote: 'START' }, end: { page: 1, quote: 'END' } }, signal)
  await assert.rejects(repeated.ranges.derive('alice', 'doc-1', repeatedParent.refId, 'repeated', signal),
    { code: 'pdf/ambiguous-text-target' })
})

test('reference reads allow derived text but precise range creation and writes require native geometry', async () => {
  const f = fixture(['ordinary text'])
  f.extraction('local-ocr')
  const page = await readPageWindow(f.workspaces, f.pages, 'alice', 'doc-1', 1, 0, 8000, signal, f.references)
  const read = await f.ranges.readEvidence('alice', 'doc-1', page.evidence!.refId, signal)
  assert.equal(read.pages[0]?.snapshot.text, 'ordinary text')
  await assert.rejects(f.resolver.resolveRange('alice', 'doc-1', read.refId, signal), { code: 'pdf/text-geometry-unavailable' })
  await assert.rejects(f.ranges.capture('alice', 'doc-1',
    { start: { page: 1, quote: 'ordinary' }, end: { page: 1, quote: 'text' } }, signal),
  { code: 'pdf/text-geometry-unavailable' })
})

test('single and continuous evidence remain session-authorized and revalidate complete page text', async () => {
  const f = fixture(), parent = await f.ranges.capture('alice', 'doc-1', range, signal)
  await assert.rejects(f.ranges.readEvidence('bob', 'doc-1', parent.refId, signal), { code: 'pdf/reference-unavailable' })
  const bytes = Buffer.from('annotation-only save')
  f.update({ revision: 2, bytes, sourceVersion: 'fs-2' })
  const read = await f.ranges.readEvidence('alice', 'doc-1', parent.refId, signal,
    async () => ({ path: '/paper.pdf', digest: evidenceSha256(bytes) }))
  assert.equal(read.revalidated, true)
  assert.equal(read.revision, 2)
  f.texts[1] = 'changed middle evidence'
  await assert.rejects(f.ranges.readEvidence('alice', 'doc-1', parent.refId, signal), { code: 'pdf/stale-reader' })
  await assert.rejects(f.resolver.resolveRange('alice', 'doc-1', parent.refId, signal), { code: 'pdf/stale-reader' })
})

test('bounds, ambiguous anchors, external changes and cancellation fail before publishing a range', async () => {
  for (const input of [
    { start: { page: 3, quote: 'END' }, end: { page: 1, quote: 'START' } },
    { start: { page: 0, quote: 'START' }, end: { page: 3, quote: 'END' } },
    { start: { page: 1, quote: ' ' }, end: { page: 3, quote: 'END' } },
  ]) {
    const f = fixture()
    await assert.rejects(f.ranges.capture('alice', 'doc-1', input, signal), { code: 'pdf/invalid-text-range' })
  }
  const f = fixture()
  await assert.rejects(f.ranges.capture('alice', 'doc-1', range, signal,
    async () => ({ path: '/paper.pdf', digest: evidenceSha256('external') })), { code: 'pdf/stale-reader' })
  const controller = new AbortController()
  f.onRead(() => controller.abort())
  await assert.rejects(f.ranges.capture('alice', 'doc-1', range, controller.signal), { name: 'AbortError' })
  const race = fixture()
  race.onRead(() => race.update({ revision: 1 }))
  await assert.rejects(race.ranges.capture('alice', 'doc-1', range, signal), { code: 'pdf/stale-reader' })
})

test('empty, oversized, tampered and incomplete ranges cannot authorize multi-page actions', async () => {
  const oversized = fixture(['START' + 'a'.repeat(4000), 'b'.repeat(4000), 'END'])
  await assert.rejects(oversized.ranges.capture('alice', 'doc-1', range, signal), { code: 'pdf/text-range-too-large' })
  const f = fixture(), captured = await f.ranges.capture('alice', 'doc-1', range, signal)
  const record = f.references.get(captured.refId)!
  if (record.evidence.source !== 'pdf-text-range') assert.fail('Expected range')
  record.evidence.pages.splice(1, 1)
  await assert.rejects(f.ranges.readEvidence('alice', 'doc-1', captured.refId, signal), { code: 'pdf/invalid-evidence' })
  await assert.rejects(f.resolver.resolveRange('alice', 'doc-1', captured.refId, signal), { code: 'pdf/invalid-evidence' })
})

test('publication rolls back every candidate when storage persists a child or parent and then rejects', async () => {
  for (const rejectAt of [2, 4]) {
    const f = fixture(), records = new Map<string, SavedReference>()
    const original = new Error('Storage flush failed after persisting')
    let writes = 0, deletes = 0
    const store: EvidenceReferenceStore = { get: key => records.get(key),
      async put(key, value) { records.set(key, value); if (++writes === rejectAt) throw original },
      async delete(key) {
        records.delete(key)
        // A rollback failure must not stop other deletes or mask the write error.
        if (++deletes === 1) throw new Error('Cleanup failed after deleting')
      },
      async deleteSession() {},
    }
    await assert.rejects(createTextRangeReferences(f.workspaces, f.pages, store)
      .capture('alice', 'doc-1', range, signal), error => error === original)
    assert.equal(records.size, 0, 'no persisted child or parent survives the failed publication')
    assert.equal(deletes, 4, 'all three children and the parent are rollback candidates')
  }
})

test('cancellation during child or parent persistence rolls back without masking the abort reason', async () => {
  for (const abortAt of [2, 4]) {
    const f = fixture(), records = new Map<string, SavedReference>(), controller = new AbortController()
    const reason = new DOMException('User cancelled', 'AbortError')
    let writes = 0, deletes = 0
    const store: EvidenceReferenceStore = { get: key => records.get(key),
      async put(key, value) { records.set(key, value); if (++writes === abortAt) controller.abort(reason) },
      async delete(key) { records.delete(key); if (++deletes === 1) throw new Error('Cleanup failure') },
      async deleteSession() {},
    }
    await assert.rejects(createTextRangeReferences(f.workspaces, f.pages, store)
      .capture('alice', 'doc-1', range, controller.signal), error => error === reason)
    assert.equal(records.size, 0)
    assert.equal(deletes, 4)
    assert.equal(writes, abortAt, 'cancellation prevents any additional persistence')
  }
})

test('conflict-only changes during the final source await reject and roll back freshly signed references', async () => {
  const f = fixture(), records = new Map<string, SavedReference>()
  const store: EvidenceReferenceStore = { get: key => records.get(key),
    async put(key, value) { records.set(key, value) }, async delete(key) { records.delete(key) },
    async deleteSession() {},
  }
  let checks = 0
  await assert.rejects(createTextRangeReferences(f.workspaces, f.pages, store)
    .capture('alice', 'doc-1', range, signal, async () => {
      if (++checks === 3) f.update({ conflict: true })
      return { path: '/paper.pdf', digest: evidenceSha256(f.current().bytes) }
    }), { code: 'pdf/stale-reader' })
  assert.equal(checks, 3)
  assert.equal(records.size, 0)
})

test('reading rejects a digest-consistent stored range that splits a supplementary Unicode character', async () => {
  for (const [start, end] of [[1, 2], [2, 3]] as const) {
    const f = fixture(['A😀B'])
    const read = await readPageWindow(f.workspaces, f.pages, 'alice', 'doc-1', 1, 0, 8000, signal, f.references)
    const refId = read.evidence!.refId, record = f.references.get(refId)!
    if (record.evidence.source !== 'pdf-text') assert.fail('Expected a single-page text reference')
    const partial = 'A😀B'.slice(start, end)
    record.evidence.locator.startUtf16 = start
    record.evidence.locator.endUtf16 = end
    record.evidence.snapshot = { text: partial, sha256: evidenceSha256(partial) }
    await assert.rejects(f.ranges.readEvidence('alice', 'doc-1', refId, signal), { code: 'pdf/invalid-text-range' })
  }
})

test('deriving half an emoji is rejected while a complete Unicode scalar and its parent remain readable', async () => {
  const f = fixture(['A😀B'])
  const read = await readPageWindow(f.workspaces, f.pages, 'alice', 'doc-1', 1, 0, 8000, signal, f.references)
  const refId = read.evidence!.refId
  for (const half of ['😀'.slice(0, 1), '😀'.slice(1)]) {
    await assert.rejects(f.ranges.derive('alice', 'doc-1', refId, half, signal), { code: 'pdf/invalid-text-range' })
  }
  const scalar = await f.ranges.derive('alice', 'doc-1', refId, '😀', signal)
  assert.equal(scalar.pages[0]?.snapshot.text, '😀')
  assert.deepEqual(scalar.pages[0]?.locator.startUtf16, 1)
  assert.deepEqual(scalar.pages[0]?.locator.endUtf16, 3)
  assert.equal((await f.ranges.readEvidence('alice', 'doc-1', refId, signal)).pages[0]?.snapshot.text, 'A😀B')
})

test('a combined range exceeding the shared budget fails before persistence even when each page fits', async () => {
  const f = fixture(['START' + 'a'.repeat(3995), 'b'.repeat(3997) + 'END'])
  let writes = 0
  const store: EvidenceReferenceStore = { get() { return undefined },
    async put() { writes++ }, async delete() {}, async deleteSession() {} }
  assert.deepEqual(f.texts.map(text => text.length), [4000, 4000])
  await assert.rejects(createTextRangeReferences(f.workspaces, f.pages, store).capture('alice', 'doc-1',
    { start: { page: 1, quote: 'START' }, end: { page: 2, quote: 'END' } }, signal),
  { code: 'pdf/text-range-too-large' })
  assert.equal(writes, 0)
})

test('range classification and session cleanup preserve other owners while removing a complete range', async () => {
  const f = fixture(), captured = await f.ranges.capture('alice', 'doc-1', range, signal)
  const parent = f.references.get(captured.refId)!, child = f.references.get(captured.pages[0]!.refId)!
  assert.equal(parent.evidence.source, 'pdf-text-range')
  assert.equal(child.evidence.source, 'pdf-text')
  assert.equal(isSavedImageReference(parent), false)
  const other = structuredClone(child)
  other.sessionId = 'bob'
  other.evidence.refId = 'pdfref_00000000-0000-4000-8000-000000000001'
  await f.references.put(other.evidence.refId, other)
  await f.references.deleteSession('alice')
  assert.equal(f.references.get(captured.refId), undefined)
  for (const page of captured.pages) assert.equal(f.references.get(page.refId), undefined)
  assert.deepEqual(f.references.get(other.evidence.refId), other)
  await f.references.deleteSession('unrelated')
  assert.deepEqual(f.references.get(other.evidence.refId), other)
})

test('range resolution rejects a foreign owner or a mismatched parent reference identity', async () => {
  const f = fixture(), captured = await f.ranges.capture('alice', 'doc-1', range, signal)
  await assert.rejects(f.resolver.resolveRange('bob', 'doc-1', captured.refId, signal), { code: 'pdf/reference-unavailable' })
  const parent = f.references.get(captured.refId)!
  parent.evidence.refId = 'pdfref_00000000-0000-4000-8000-000000000002'
  await assert.rejects(f.resolver.resolveRange('alice', 'doc-1', captured.refId, signal), { code: 'pdf/reference-unavailable' })
})

test('a queued concurrent edit after one page resolves cannot escape the aggregate range version check', async () => {
  const f = fixture(), captured = await f.ranges.capture('alice', 'doc-1', range, signal)
  let completedRead = false, checksAfterRead = 0
  const workspaces = { readSnapshot(owner: string, id: string) {
    const observed = f.workspaces.readSnapshot(owner, id)
    // Simulate an edit queued after an individual target's final verification,
    // before the awaiting multi-page operation can admit the next target.
    if (completedRead && ++checksAfterRead === 2) queueMicrotask(() => f.update({ revision: 1 }))
    return observed
  } }
  const pages = { async readPageText(owner: string, id: string, page: number, abort: AbortSignal) {
    const read = await f.pages.readPageText(owner, id, page, abort)
    completedRead = true
    return read
  } }
  await assert.rejects(createTextReferenceResolver(workspaces, pages, f.references)
    .resolveRange('alice', 'doc-1', captured.refId, signal),
  { code: 'pdf/stale-reader', message: 'PDF changed while resolving the continuous text range' })
  assert.equal(f.current().revision, 1)
})
