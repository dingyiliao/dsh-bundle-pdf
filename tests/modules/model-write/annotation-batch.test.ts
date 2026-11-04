import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryEvidenceReferenceStore, createTextRangeReferences, createTextReferenceResolver,
  evidenceSha256, type TextReferenceResolverPort } from '../../../src/modules/evidence/index.ts'
import { createModelWriteService, modelAnnotationCreateSchema, type ModelAnnotationItem } from '../../../src/modules/model-write/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { memoryWorkspace, nativeFixture } from '../../native-fixture.ts'

const sessionId = 'atomic-annotation-batch'
const agent = { session: { id: sessionId, header: {} } }
const signal = new AbortController().signal

async function fixture() {
  const state = memoryWorkspace(await nativeFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const strings = ['Before A start passage', 'A ending after', 'Before B start passage', 'B ending after']
  const pages = { async readPageText(owner: string, id: string, page: number) {
    const str = strings[page - 1]!
    return { snapshot: state.workspaces.readSnapshot(owner, id), content: {
      items: [{ str, transform: [12, 0, 0, 12, 60, 260], width: str.length * 6, height: 12,
        dir: 'ltr', fontName: 'test', hasEOL: true,
        glyphs: Array.from(str, (_, i) => [60 + i * 6, 260, 6]) }],
      styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null,
    } as NativeTextContent }
  } }
  const references = createMemoryEvidenceReferenceStore()
  const capture = createTextRangeReferences(state.workspaces, pages, references)
  const a = await capture.capture(sessionId, opened.id, {
    start: { page: 1, quote: 'A start' }, end: { page: 2, quote: 'A ending' },
  }, signal)
  const b = await capture.capture(sessionId, opened.id, {
    start: { page: 3, quote: 'B start' }, end: { page: 4, quote: 'B ending' },
  }, signal)
  const partial = await capture.capture(sessionId, opened.id, {
    start: { page: 1, quote: 'start' }, end: { page: 2, quote: 'A ending' },
  }, signal)
  const resolver = createTextReferenceResolver(state.workspaces, pages, references)
  const item = (refId: string): ModelAnnotationItem => ({ subtype: 'Highlight', target: { kind: 'reference', refId } })
  const input = { documentId: opened.id, expectedRevision: opened.revision, annotations: [item(a.refId), item(b.refId)] }
  const writes = createModelWriteService(state.workspaces, pages, resolver)
  return { state, opened, pages, resolver, writes, capture, a, b, partial, item, input,
    async dispose() { writes.dispose(); await state.workspaces.dispose() } }
}

test('independent cross-page references and a note form one complete draft revision and undo', async () => {
  const f = await fixture()
  try {
    const result = await f.writes.annotate(sessionId, { ...f.input, annotations: [
      { ...f.input.annotations[0]!, color: [1, 1, 0], comment: 'First range' }, f.input.annotations[1]!,
      { subtype: 'Text', target: { kind: 'pdf-region', page: 2, rectPdf: [40, 50, 60, 70] }, comment: 'A separate note' },
    ] }, agent, signal)
    assert.equal(result.status, 'updated')
    assert.equal(result.revision, f.opened.revision + 1)
    assert.equal(result.savedToFile, false)
    assert.equal(result.dirty, true)
    assert.equal(result.canUndo, true)
    assert.equal(result.annotationIds.length, 5)
    assert.deepEqual(result.annotations.map(entry => [entry.index, entry.coverage.pages.map(page => page.page)]),
      [[0, [1, 2]], [1, [3, 4]], [2, [2]]])
    assert.ok(result.annotations.every(entry => entry.coverage.complete && entry.status === 'updated'))
    assert.equal(result.annotations[0]!.resolvedTarget.refId, f.a.refId)
    assert.equal(result.annotations[1]!.resolvedTarget.refId, f.b.refId)
    assert.deepEqual(result.annotations[0]!.coverage.pages.map(page => page.text), ['A start passage', 'A ending'])
    const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
    assert.equal(draft.document.annotations.filter(mark => mark.contents === 'First range').length, 1)
    assert.equal(draft.document.annotations.length, f.opened.document.annotations.length + 5)
    const undone = await f.state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: f.opened.id, revision: result.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.deepEqual(undone.document.annotations, f.opened.document.annotations)
    assert.equal(undone.canUndo, false, 'one undo removes all batch additions')
    assert.equal(f.state.writes(), 0)
  } finally { await f.dispose() }
})

test('invalid last reference or note geometry rolls back the whole batch before any draft change', async () => {
  for (const last of [
    { subtype: 'Highlight', target: { kind: 'reference', refId: 'unknown-reference' } },
    { subtype: 'Text', target: { kind: 'pdf-region', page: 1, rectPdf: [0, 0, 10, 10] }, comment: 'Invalid crop bounds' },
  ] as ModelAnnotationItem[]) {
    const f = await fixture()
    try {
      await assert.rejects(f.writes.annotate(sessionId, { ...f.input, annotations: [f.input.annotations[0]!, last] }, agent, signal),
        error => error instanceof Error && 'index' in error && error.index === 1 && /annotations\[1\]/.test(error.message))
      const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
      assert.equal(draft.revision, f.opened.revision)
      assert.deepEqual(draft.document.annotations, f.opened.document.annotations)
      assert.equal(draft.canUndo, false)
      assert.equal(f.state.writes(), 0)
    } finally { await f.dispose() }
  }
})

test('identical pending marks share IDs and fully repeated batches do not increment revision', async () => {
  const f = await fixture()
  try {
    const annotations = [f.input.annotations[0]!, f.input.annotations[0]!, f.input.annotations[1]!]
    const first = await f.writes.annotate(sessionId, { ...f.input, annotations }, agent, signal)
    assert.equal(first.annotationIds.length, 4)
    assert.deepEqual(first.annotations[0]!.annotationIds, first.annotations[1]!.annotationIds)
    assert.equal(first.annotations[1]!.status, 'already_annotated')
    assert.ok(first.annotations[1]!.coverage.pages.every(page => page.action === 'existing'))
    const second = await f.writes.annotate(sessionId, { ...f.input, annotations, expectedRevision: first.revision }, agent, signal)
    assert.equal(second.status, 'already_annotated')
    assert.equal(second.revision, first.revision)
    assert.deepEqual(second.annotationIds, first.annotationIds)
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).document.annotations.length,
      f.opened.document.annotations.length + 4)
    assert.equal(f.state.writes(), 0)
  } finally { await f.dispose() }
})

test('batch styling conflicts are symmetric and report both indexes and the pending mark ID', async () => {
  const options: Array<[Partial<ModelAnnotationItem>, Partial<ModelAnnotationItem>]> = [
    [{ color: [1, 0, 0] }, { color: [0, 0, 1] }], [{ comment: 'One' }, { comment: 'Two' }],
    [{}, { color: [1, 0, 0] }], [{}, { comment: 'Added comment' }],
  ]
  for (const pair of options.flatMap(pair => [pair, [...pair].reverse()])) {
    const f = await fixture()
    try {
      await assert.rejects(f.writes.annotate(sessionId, { ...f.input, annotations: pair.map(options =>
        ({ ...f.input.annotations[0]!, ...options })) }, agent, signal), error => {
        assert.ok(error instanceof Error && 'code' in error && error.code === 'pdf/annotation-already-exists')
        assert.ok('index' in error && error.index === 1)
        assert.ok('conflictingIndexes' in error)
        assert.deepEqual(error.conflictingIndexes, [0])
        assert.ok('annotationIds' in error && Array.isArray(error.annotationIds) && error.annotationIds.length === 1)
        assert.match(error.message, /annotations\[1\].*annotations\[0\].*ai_/)
        return true
      })
      const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
      assert.equal(draft.revision, f.opened.revision)
      assert.deepEqual(draft.document.annotations, f.opened.document.annotations)
      assert.equal(draft.canUndo, false)
    } finally { await f.dispose() }
  }
})

test('partial overlap rejects pending and existing marks without adding an independent earlier entry', async () => {
  for (const existing of [false, true]) {
    const f = await fixture()
    try {
      const first = existing ? await f.writes.annotate(sessionId, { documentId: f.opened.id,
        expectedRevision: f.opened.revision, ...f.input.annotations[0]! }, agent, signal) : undefined
      const revision = first?.revision ?? f.opened.revision
      const before = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
      const annotations = existing ? [f.item(f.b.refId), f.item(f.partial.refId)]
        : [f.item(f.b.refId), f.item(f.a.refId), f.item(f.partial.refId)]
      await assert.rejects(f.writes.annotate(sessionId, { ...f.input, expectedRevision: revision, annotations }, agent, signal), error => {
        assert.ok(error instanceof Error && 'code' in error && error.code === 'pdf/annotation-overlap')
        assert.ok('index' in error && error.index === (existing ? 1 : 2))
        assert.ok('annotationIds' in error && Array.isArray(error.annotationIds) && error.annotationIds.length > 0)
        return true
      })
      const after = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
      assert.equal(after.revision, revision)
      assert.deepEqual(after.document.annotations, before.document.annotations)
    } finally { await f.dispose() }
  }
})

test('existing omitted-option reuse coexists with missing new entries and sequential revision chaining', async () => {
  const f = await fixture()
  try {
    const first = await f.writes.annotate(sessionId, { documentId: f.opened.id, expectedRevision: f.opened.revision,
      ...f.item(f.a.refId), color: [1, 0, 0], comment: 'Keep original' }, agent, signal)
    await assert.rejects(f.writes.annotate(sessionId, f.input, agent, signal), { code: 'pdf/stale-revision' })
    const second = await f.writes.annotate(sessionId, { ...f.input, expectedRevision: first.revision }, agent, signal)
    assert.equal(second.revision, first.revision + 1)
    assert.equal(second.annotations[0]!.status, 'already_annotated')
    assert.deepEqual(second.annotations[0]!.annotationIds, first.annotationIds)
    assert.equal(second.annotations[1]!.status, 'updated')
    const third = await f.writes.updateAnnotation(sessionId, { documentId: f.opened.id,
      expectedRevision: second.revision, annotationId: first.annotationId, comment: 'Changed via returned revision' }, agent, signal)
    assert.equal(third.revision, second.revision + 1)
    assert.equal(f.state.writes(), 0)
  } finally { await f.dispose() }
})

test('stale reference metadata, source replacement and concurrent UI edits prevent every batch addition', async () => {
  for (const mode of ['metadata', 'source', 'ui'] as const) {
    const f = await fixture()
    let reads = 0
    const resolver: TextReferenceResolverPort = { resolve: f.resolver.resolve.bind(f.resolver), async resolveRange(...args) {
      const result = await f.resolver.resolveRange(...args)
      if (++reads === 2) {
        if (mode === 'metadata') return { ...result, pages: result.pages.map(page => ({ ...page, revision: page.revision + 1 })) }
        if (mode === 'source') await f.state.files.save(agent, f.opened.path, Buffer.from('Externally replaced source'),
          evidenceSha256(f.state.current()), { signal })
        else await f.state.workspaces.execute(sessionId, { action: 'change', sessionId,
          id: f.opened.id, revision: f.opened.revision, operations: [{ type: 'add', annotation: {
            id: 'ui-note', page: 1, subtype: 'Text', rect: [40, 50, 60, 70], contents: 'Concurrent UI edit',
          } }] }, agent, signal)
      }
      return result
    } }
    const writes = createModelWriteService(f.state.workspaces, f.pages, resolver)
    try {
      await assert.rejects(writes.annotate(sessionId, f.input, agent, signal),
        { code: mode === 'source' ? 'pdf/source-conflict' : 'pdf/stale-revision' })
      const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
      assert.equal(draft.revision, f.opened.revision + (mode === 'ui' ? 1 : 0))
      assert.deepEqual(draft.document.annotations.filter(mark => mark.id !== 'ui-note'), f.opened.document.annotations)
      assert.equal(draft.document.annotations.some(mark => mark.id.startsWith('ai_')), false)
      assert.equal(f.state.writes(), mode === 'source' ? 1 : 0)
    } finally { writes.dispose(); await f.dispose() }
  }
})

test('single and batch contracts are strict alternatives with bounded structured arrays', async () => {
  const f = await fixture()
  try {
    const single = { documentId: f.opened.id, expectedRevision: f.opened.revision, ...f.item(f.a.refId) }
    assert.ok(modelAnnotationCreateSchema.safeParse(single).success)
    assert.ok(modelAnnotationCreateSchema.safeParse(f.input).success)
    for (const input of [{ ...f.input, ...f.item(f.a.refId) }, { ...f.input, color: [1, 0, 0] },
      { ...f.input, comment: 'Mixed comment' }, { ...f.input, annotations: [] },
      { ...f.input, annotations: Array.from({ length: 51 }, () => f.item(f.a.refId)) },
      { ...f.input, annotations: Array.from({ length: 33 }, () => ({ ...f.item(f.a.refId), comment: 'x'.repeat(2000) })) },
      { ...f.input, annotations: JSON.stringify(f.input.annotations) },
      { ...f.input, annotations: [{ ...f.item(f.a.refId), expectedRevision: f.opened.revision }] }]) {
      assert.equal(modelAnnotationCreateSchema.safeParse(input).success, false)
    }
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).revision, f.opened.revision)
  } finally { await f.dispose() }
})

test('page-operation budget is checked before applying even an entirely duplicate batch', async () => {
  const f = await fixture()
  try {
    const full = await f.capture.capture(sessionId, f.opened.id, {
      start: { page: 1, quote: 'A start' }, end: { page: 4, quote: 'B ending' },
    }, signal)
    await assert.rejects(f.writes.annotate(sessionId, { ...f.input,
      annotations: Array.from({ length: 26 }, () => f.item(full.refId)) }, agent, signal),
    { code: 'pdf/annotation-batch-too-large', index: 25, appliedCount: 0 })
    const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
    assert.equal(draft.revision, f.opened.revision)
    assert.deepEqual(draft.document.annotations, f.opened.document.annotations)
    assert.equal(draft.canUndo, false)
  } finally { await f.dispose() }
})
