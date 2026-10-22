import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createModelWriteService } from '../../../src/modules/model-write/index.ts'
import { buildSaveReview } from '../../../src/modules/model-write/save-review.ts'
import { NativeWorker } from '../../../src/adapters/host/pdfium/native-worker.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { memoryWorkspace, nativeFixture } from '../../native-fixture.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'

const signal = new AbortController().signal
const sessionId = 'pdf-model-write'
const agent = { session: { id: sessionId, header: {} } }
const quote = 'MMFAR title'
const target = { kind: 'pdf-text' as const, page: 1, quote }

async function fixture() {
  const state = memoryWorkspace(await nativeFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const pages = { async readPageText() { return { snapshot: state.workspaces.readSnapshot(sessionId, opened.id), content: {
    items: [{ str: quote, transform: [12, 0, 0, 12, 60, 90], width: quote.length * 6, height: 12,
      dir: 'ltr', fontName: 'test', hasEOL: false,
      glyphs: Array.from(quote, (_, index) => [60 + index * 6, 90, 6] as [number, number, number]) }],
    styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null,
  } } } }
  const writes = createModelWriteService(state.workspaces, pages)
  return { state, opened, writes, pages }
}

function annotation(id: string, revision: number) {
  return { documentId: id, expectedRevision: revision,
    subtype: 'Highlight' as const, target, color: [1, 1, 0] as [number, number, number], comment: 'AI suggestion' }
}

function textLine(str: string, y: number, hasEOL = true): NativeTextContent['items'][number] {
  return { str, transform: [12, 0, 0, 12, 60, y], width: str.length * 6, height: 12,
    dir: 'ltr', fontName: 'test', hasEOL,
    glyphs: Array.from(str, (_, index) => [60 + index * 6, y, 6]) }
}

async function rangeFixture() {
  const state = memoryWorkspace(await nativeFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const content = [
    [textLine('Before', 260), textLine('Start here', 230), textLine('Middle A', 200, false)],
    [textLine('Middle B', 260), textLine('Middle C', 230, false)],
    [textLine('Final part', 260), textLine('Stop here', 230), textLine('After', 200, false)],
  ]
  const pages = { async readPageText(_owner: string, _id: string, page: number) {
    return { snapshot: state.workspaces.readSnapshot(sessionId, opened.id), content: {
      items: content[page - 1] ?? [],
      styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } },
      lang: null,
    } }
  } }
  const writes = createModelWriteService(state.workspaces, pages)
  const target = { kind: 'pdf-text-range' as const,
    start: { page: 1, quote: 'Start here' }, end: { page: 3, quote: 'Stop here' } }
  return { state, opened, writes, pages, target }
}

test('cross-page text range fills every middle page in one undoable draft operation', async () => {
  const { state, opened, writes, target } = await rangeFixture()
  try {
    const result = await writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target, color: [1, 1, 0],
      comment: 'One comment for the complete range' }, agent, signal)
    assert.equal(result.status, 'updated')
    assert.equal(result.revision, opened.revision + 1)
    assert.deepEqual(result.coverage.pages.map(item => item.page), [1, 2, 3])
    assert.deepEqual(result.coverage.pages.map(item => item.text), [
      'Start here\nMiddle A', 'Middle B\nMiddle C', 'Final part\nStop here',
    ])
    assert.ok(result.coverage.pages.every(item => item.action === 'added'))
    const draft = state.workspaces.readSnapshot(sessionId, opened.id)
    assert.equal(draft.document.annotations.length, opened.document.annotations.length + 3)
    assert.equal(draft.document.annotations.filter(item => item.contents === 'One comment for the complete range').length, 1)
    assert.equal(state.writes(), 0)
    const undone = await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: opened.id, revision: result.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.equal(undone.document.annotations.length, opened.document.annotations.length)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('exact repeated range reuses existing marks; partial overlap rejects the whole request', async () => {
  const { state, opened, writes, target } = await rangeFixture()
  try {
    const first = await writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target }, agent, signal)
    const again = await writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: first.revision, subtype: 'Highlight', target }, agent, signal)
    assert.equal(again.status, 'already_annotated')
    assert.equal(again.revision, first.revision)
    assert.deepEqual(again.annotationIds, first.annotationIds)
    assert.ok(again.coverage.pages.every(item => item.action === 'existing'))
    await assert.rejects(writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: again.revision, subtype: 'Highlight', target,
      comment: 'A new comment was requested' }, agent, signal),
    { code: 'pdf/annotation-already-exists' })
    await assert.rejects(writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: again.revision, subtype: 'Highlight',
      target: { kind: 'pdf-text-range', start: { page: 1, quote: 'Middle A' },
        end: { page: 3, quote: 'Stop here' } } }, agent, signal),
    { code: 'pdf/annotation-overlap' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, first.revision)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations.length,
      opened.document.annotations.length + 3)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('a partially completed multi-page range adds only missing pages as one draft change', async () => {
  const { state, opened, writes, target } = await rangeFixture()
  try {
    const first = await writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target }, agent, signal)
    const removed = await writes.deleteAnnotation(sessionId, { documentId: opened.id,
      expectedRevision: first.revision, annotationId: first.annotationIds[1]! }, agent, signal)
    const completed = await writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: removed.revision, subtype: 'Highlight', target }, agent, signal)
    assert.equal(completed.status, 'updated')
    assert.equal(completed.revision, removed.revision + 1)
    assert.deepEqual(completed.coverage.pages.map(item => item.action), ['existing', 'added', 'existing'])
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations.length,
      opened.document.annotations.length + 3)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('an unpositioned middle page rejects the entire cross-page range without a partial draft', async () => {
  const { state, opened, pages, target } = await rangeFixture()
  const writes = createModelWriteService(state.workspaces, {
    async readPageText(owner, id, page) {
      const read = await pages.readPageText(owner, id, page)
      return page === 2 ? { ...read, content: { ...read.content, items: [] } } : read
    },
  })
  try {
    await assert.rejects(writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target }, agent, signal),
    { code: 'pdf/invalid-text-range' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('text ranges reject reversed spans and a page that changes during lookup', async () => {
  const { state, opened, pages, target } = await rangeFixture()
  const writes = createModelWriteService(state.workspaces, {
    async readPageText(owner, id, page) {
      const read = await pages.readPageText(owner, id, page)
      return page === 2 ? { ...read, snapshot: { ...read.snapshot, revision: read.snapshot.revision + 1 } } : read
    },
  })
  try {
    await assert.rejects(writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target: {
        kind: 'pdf-text-range', start: { page: 3, quote: 'Final part' }, end: { page: 1, quote: 'Start here' },
      } }, agent, signal), { code: 'pdf/invalid-text-range' })
    await assert.rejects(writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target }, agent, signal),
    { code: 'pdf/stale-revision' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('an already-covered range is rechecked for concurrent edits before reporting success', async () => {
  const { state, opened, writes, pages, target } = await rangeFixture()
  try {
    const first = await writes.annotate(sessionId, { documentId: opened.id,
      expectedRevision: opened.revision, subtype: 'Highlight', target }, agent, signal)
    let reads = 0
    const racing = { ...state.workspaces,
      readSnapshot(...args: Parameters<typeof state.workspaces.readSnapshot>) {
        const snapshot = state.workspaces.readSnapshot(...args)
        return ++reads === 2 ? { ...snapshot, revision: snapshot.revision + 1 } : snapshot
      },
    }
    const check = createModelWriteService(racing, pages)
    try {
      await assert.rejects(check.annotate(sessionId, { documentId: opened.id,
        expectedRevision: first.revision, subtype: 'Highlight', target }, agent, signal),
      { code: 'pdf/stale-revision' })
    } finally { check.dispose() }
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

const nativeExecutable = resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
test('real PDFium page text creates a complete two-page model mark',
  { skip: !existsSync(nativeExecutable) }, async () => {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
    const first = pdf.addPage([300, 400])
    first.drawText('Before native', { x: 60, y: 280, size: 12, font })
    first.drawText('Start native', { x: 60, y: 250, size: 12, font })
    first.drawText('Middle native', { x: 60, y: 230, size: 12, font })
    const second = pdf.addPage([300, 400])
    second.drawText('More native', { x: 60, y: 280, size: 12, font })
    second.drawText('Finish native', { x: 60, y: 250, size: 12, font })
    second.drawText('After native', { x: 60, y: 230, size: 12, font })
    const bytes = await pdf.save(), state = memoryWorkspace(bytes)
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
    assert.ok('bytes' in opened)
    const worker = new NativeWorker(nativeExecutable, nativeTestSubprocess)
    await worker.request({ command: 'open', documentId: 'range-native-test' }, bytes)
    const pages = { async readPageText(_owner: string, _id: string, page: number) {
      const response = await worker.request({ command: 'text', documentId: 'range-native-test', pageIndex: page - 1 })
      return { snapshot: state.workspaces.readSnapshot(sessionId, opened.id), content: response.value as NativeTextContent }
    } }
    const writes = createModelWriteService(state.workspaces, pages)
    try {
      const result = await writes.annotate(sessionId, { documentId: opened.id,
        expectedRevision: opened.revision, subtype: 'Highlight',
        target: { kind: 'pdf-text-range', start: { page: 1, quote: 'Start native' },
          end: { page: 2, quote: 'Finish native' } } }, agent, signal)
      assert.deepEqual(result.coverage.pages.map(item => item.page), [1, 2])
      assert.match(result.coverage.pages[0]!.text!, /Middle native/)
      assert.match(result.coverage.pages[1]!.text!, /More native/)
      assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision + 1)
    } finally { writes.dispose(); await worker.dispose(); await state.workspaces.dispose() }
  })

test('model edit immediately creates one undoable draft without changing the source PDF; save still needs approval', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const source = state.current().slice()
    const updated = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    assert.equal(updated.status, 'updated')
    assert.equal(updated.dirty, true)
    assert.equal(updated.canUndo, true)
    assert.equal(updated.savedToFile, false)
    assert.equal(updated.resolvedTarget.quote, quote)
    assert.ok(updated.resolvedTarget.rectPdf[1] < 90 && updated.resolvedTarget.rectPdf[3] > 90)
    assert.equal(state.writes(), 0)
    assert.deepEqual(state.current(), source)
    const draft = state.workspaces.readSnapshot(sessionId, opened.id)
    assert.equal(draft.revision, updated.revision)
    assert.equal(draft.document.annotations.length, opened.document.annotations.length + 1)
    assert.ok(draft.document.annotations.some(item => item.id === updated.annotationId))
    const undone = await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: opened.id, revision: draft.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.equal(undone.document.annotations.length, opened.document.annotations.length)
    const redone = await state.workspaces.execute(sessionId, { action: 'redo', sessionId,
      id: opened.id, revision: undone.revision }, agent, signal)
    assert.ok('bytes' in redone)
    assert.ok(redone.document.annotations.some(item => item.id === updated.annotationId))
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: redone.revision },
      agent, signal, async detail => {
        assert.equal(detail.kind, 'save')
        assert.equal(detail.path, '/fixtures/native.pdf')
        assert.equal(detail.saveChangeCount, 1)
        assert.match(detail.saveDiffText!, /AI suggestion/)
        return false
      }), { code: 'pdf/approval-rejected' })
    assert.equal(state.writes(), 0)
    const saved = await writes.save(sessionId, { documentId: opened.id, expectedRevision: redone.revision },
      agent, signal, async () => true)
    assert.equal(saved.status, 'saved')
    assert.equal(saved.dirty, false)
    assert.equal(state.writes(), 1)
    assert.notDeepEqual(state.current(), source)
    assert.equal((await writes.save(sessionId, { documentId: opened.id, expectedRevision: saved.revision },
      agent, signal, async () => { throw Error('clean save must not ask') })).status, 'no_changes')
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model edit validates verified text geometry, note content, revision, session and source before mutation', async () => {
  const { state, opened, writes } = await fixture()
  try {
    await assert.rejects(writes.annotate(sessionId, {
      ...annotation(opened.id, opened.revision), target: { kind: 'reference', refId: 'pdfref_123' },
    }, agent, signal), { code: 'pdf/approximate-target' })
    await assert.rejects(writes.annotate(sessionId, {
      ...annotation(opened.id, opened.revision), target: { kind: 'pdf-region', page: 1, rectPdf: [60, 80, 120, 100] },
    }, agent, signal), { code: 'pdf/unverified-region' })
    await assert.rejects(writes.annotate(sessionId, {
      ...annotation(opened.id, opened.revision), target: { ...target, quote: 'missing' },
    }, agent, signal), { code: 'pdf/text-not-found' })
    await assert.rejects(writes.annotate(sessionId, {
      ...annotation(opened.id, opened.revision), subtype: 'Text', comment: '   ',
    }, agent, signal), { code: 'pdf/invalid-comment' })
    await assert.rejects(writes.annotate(sessionId, {
      ...annotation(opened.id, opened.revision), subtype: 'Text',
      target: { kind: 'pdf-text', page: 1, quote },
    }, agent, signal), { code: 'pdf/invalid-target' })
    await assert.rejects(writes.annotate(sessionId, {
      ...annotation(opened.id, opened.revision), subtype: 'Text',
      target: { kind: 'pdf-region', page: 1, rectPdf: [60, 80, 60, 100] }, comment: 'invalid position',
    }, agent, signal), { code: 'pdf/invalid-region' })
    await assert.rejects(writes.annotate('other-session', annotation(opened.id, opened.revision), agent, signal),
      /session|belong/i)
    const first = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal),
      { code: 'pdf/stale-revision' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, first.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model write refuses stale text geometry and a noneditable existing annotation', async () => {
  const { state, opened, writes, pages } = await fixture()
  try {
    const staleGeometry = createModelWriteService(state.workspaces, {
      async readPageText() {
        const result = await pages.readPageText()
        return { ...result, snapshot: { ...result.snapshot, revision: result.snapshot.revision + 1 } }
      },
    } as never)
    try {
      await assert.rejects(staleGeometry.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal),
        { code: 'pdf/stale-revision' })
    } finally { staleGeometry.dispose() }

    const added = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    const locked = createModelWriteService({
      readSnapshot(owner, id) {
        const snapshot = state.workspaces.readSnapshot(owner, id)
        return { ...snapshot, document: { ...snapshot.document,
          annotations: snapshot.document.annotations.map(item => item.id === added.annotationId
            ? { ...item, editable: false } : item) } }
      },
      execute: state.workspaces.execute,
    }, pages)
    try {
      await assert.rejects(locked.updateAnnotation(sessionId, { documentId: opened.id,
        expectedRevision: added.revision, annotationId: added.annotationId, comment: 'changed' }, agent, signal),
      { code: 'pdf/annotation-read-only' })
    } finally { locked.dispose() }
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model can update and delete an existing mark in the shared undoable draft', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const originalBytes = state.current().slice()
    const added = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    const changed = await writes.updateAnnotation(sessionId, {
      documentId: opened.id, expectedRevision: added.revision, annotationId: added.annotationId,
      color: [0, 0.5, 1], comment: '  revised comment  ',
    }, agent, signal)
    assert.equal(changed.status, 'updated')
    assert.equal(changed.dirty, true)
    assert.equal(changed.canUndo, true)
    assert.equal(changed.savedToFile, false)
    const edited = state.workspaces.readSnapshot(sessionId, opened.id)
    const mark = edited.document.annotations.find(item => item.id === added.annotationId)
    assert.deepEqual(mark?.color, [0, 0.5, 1])
    assert.equal(mark?.contents, 'revised comment')
    assert.equal(state.writes(), 0)
    assert.deepEqual(state.current(), originalBytes)

    const removed = await writes.deleteAnnotation(sessionId, {
      documentId: opened.id, expectedRevision: changed.revision, annotationId: added.annotationId,
    }, agent, signal)
    assert.equal(removed.status, 'deleted')
    assert.equal(removed.savedToFile, false)
    assert.ok(!state.workspaces.readSnapshot(sessionId, opened.id).document.annotations
      .some(item => item.id === added.annotationId))
    const restored = await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: opened.id, revision: removed.revision }, agent, signal)
    assert.ok('bytes' in restored)
    assert.equal(restored.document.annotations.find(item => item.id === added.annotationId)?.contents,
      'revised comment')
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model annotation changes require an exact editable ID and current revision', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const added = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    const base = { documentId: opened.id, expectedRevision: added.revision, annotationId: added.annotationId }
    await assert.rejects(writes.updateAnnotation(sessionId, base, agent, signal),
      { code: 'pdf/invalid-patch' })
    await assert.rejects(writes.updateAnnotation(sessionId, { ...base, annotationId: 'missing', color: [1, 0, 0] },
      agent, signal), { code: 'pdf/unknown-annotation' })
    await assert.rejects(writes.deleteAnnotation('other-session', base, agent, signal), /session|belong/i)
    await assert.rejects(writes.deleteAnnotation(sessionId, { ...base, expectedRevision: opened.revision },
      agent, signal), { code: 'pdf/stale-revision' })

    const note = await writes.annotate(sessionId, { documentId: opened.id, expectedRevision: added.revision,
      subtype: 'Text', target: { kind: 'pdf-region', page: 1, rectPdf: [60, 80, 90, 100] },
      comment: 'A note' }, agent, signal)
    await assert.rejects(writes.updateAnnotation(sessionId, {
      documentId: opened.id, expectedRevision: note.revision, annotationId: note.annotationId,
      color: [1, 0, 0],
    }, agent, signal), { code: 'pdf/invalid-color' })
    await assert.rejects(writes.updateAnnotation(sessionId, {
      documentId: opened.id, expectedRevision: note.revision, annotationId: note.annotationId,
      comment: '   ',
    }, agent, signal), { code: 'pdf/invalid-comment' })
    const cleared = await writes.updateAnnotation(sessionId, {
      documentId: opened.id, expectedRevision: note.revision, annotationId: added.annotationId,
      comment: '',
    }, agent, signal)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations
      .find(item => item.id === added.annotationId)?.contents, '')
    await assert.rejects(writes.deleteAnnotation(sessionId, {
      documentId: opened.id, expectedRevision: note.revision, annotationId: note.annotationId,
    }, agent, signal), { code: 'pdf/stale-revision' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, cleared.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('an external source change and concurrent UI edit fail closed for model annotations', async () => {
  const { state, opened, writes, pages } = await fixture()
  try {
    const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'human-note', page: 1, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'manual',
      } }] }, agent, signal)
    assert.ok('bytes' in changed)
    await assert.rejects(writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal),
      { code: 'pdf/stale-revision' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations.length,
      opened.document.annotations.length + 1)
    const staleSource = createModelWriteService({
      readSnapshot: state.workspaces.readSnapshot,
      async execute(owner, input, caller, abort) {
        if (input.action === 'inspectTarget') return { version: `sha256:${'0'.repeat(64)}` }
        return state.workspaces.execute(owner, input, caller, abort)
      },
    }, pages)
    try {
      await assert.rejects(staleSource.annotate(sessionId, annotation(opened.id, changed.revision), agent, signal),
        { code: 'pdf/source-conflict' })
    } finally { staleSource.dispose() }
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('save refuses a changed working copy during approval, an oversized review, and a disposed service', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const updated = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: updated.revision },
      agent, signal, async () => {
        await state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: opened.id,
          revision: updated.revision }, agent, signal)
        return true
      }), { code: 'pdf/stale-revision' })
    assert.equal(state.writes(), 0)
    const dirty = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: updated.revision + 1, operations: Array.from({ length: 9 }, (_, index) => ({
        type: 'add', annotation: { id: `manual-${index}`, page: 1, subtype: 'Text',
          rect: [60 + index, 80, 90 + index, 100], contents: `manual ${index}` },
      })) }, agent, signal)
    assert.ok('bytes' in dirty)
    let asked = false
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: dirty.revision },
      agent, signal, async () => { asked = true; return true }), { code: 'pdf/review-too-large' })
    assert.equal(asked, false)
    writes.dispose()
    await assert.rejects(writes.annotate(sessionId, annotation(opened.id, dirty.revision), agent, signal),
      { code: 'pdf/write-unavailable' })
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: dirty.revision },
      agent, signal, async () => true), { code: 'pdf/write-unavailable' })
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('save rejects a changed review even when a faulty store keeps its revision unchanged', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const updated = await writes.annotate(sessionId, annotation(opened.id, opened.revision), agent, signal)
    let alterReview = false
    const guarded = createModelWriteService({
      readSnapshot(owner, id) {
        const snapshot = state.workspaces.readSnapshot(owner, id)
        return alterReview ? { ...snapshot, document: { ...snapshot.document,
          annotations: snapshot.document.annotations.map(item => item.id === updated.annotationId
            ? { ...item, contents: 'changed after approval' } : item) } } : snapshot
      },
      execute: state.workspaces.execute,
    })
    try {
      await assert.rejects(guarded.save(sessionId, { documentId: opened.id,
        expectedRevision: updated.revision }, agent, signal,
      async () => { alterReview = true; return true }), { code: 'pdf/stale-revision' })
      assert.equal(state.writes(), 0)
    } finally { guarded.dispose() }
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('save review describes add, update and delete without silently dropping changes', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const baseline = state.workspaces.readSnapshot(sessionId, opened.id)
    const old = { id: 'existing-comment', page: 1, subtype: 'Text', rect: [60, 80, 90, 100],
      contents: 'before', color: [1, 0, 0], flags: 0, supported: true, editable: true }
    const removed = { ...old, id: 'removed-comment', contents: 'remove me' }
    const synthetic = { ...baseline, baselineAnnotations: [old, removed], document: {
      ...baseline.document, annotations: [{ ...old, contents: 'after', color: [0, 1, 0] },
        { ...old, id: 'manual-comment', contents: 'manual draft' },
        { ...old, id: 'ai-comment', subtype: 'Highlight', contents: 'AI draft' }],
    } } as typeof baseline
    const review = buildSaveReview(synthetic)
    assert.equal(review.count, 4)
    assert.match(review.text, /评论："before" → "after"/)
    assert.match(review.text, /删除批注 ID："removed-comment"/)
    assert.throws(() => buildSaveReview({ ...synthetic, baselineAnnotations: [], document: {
      ...synthetic.document, annotations: [{ ...synthetic.document.annotations[0]!, id: 'oversized',
        contents: 'x'.repeat(6100) }],
    } }), { code: 'pdf/review-too-large' })
    const manual = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'manual-real', page: 1, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'manual draft',
      } }] }, agent, signal)
    assert.ok('bytes' in manual)
    const updated = await writes.annotate(sessionId, annotation(opened.id, manual.revision), agent, signal)
    await writes.save(sessionId, { documentId: opened.id, expectedRevision: updated.revision },
      agent, signal, async detail => {
        assert.equal(detail.saveChangeCount, 2)
        assert.match(detail.saveDiffText!, /manual draft/)
        assert.match(detail.saveDiffText!, /AI suggestion/)
        return true
      })
    assert.equal(state.writes(), 1)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})
