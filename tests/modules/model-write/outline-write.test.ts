import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { createModelWriteService, modelOutlineEditSchema } from '../../../src/modules/model-write/index.ts'
import { loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { memoryWorkspace } from '../../native-fixture.ts'
import { recoverableOutlineFixture } from '../../fixtures/recoverable-outline.ts'

const sessionId = 'outline-model'
const agent = { session: { id: sessionId, header: {} } }
const signal = new AbortController().signal

async function fixture() {
  const pdf = await PDFDocument.create()
  for (let page = 0; page < 3; page++) pdf.addPage([300, 400])
  const source = new Uint8Array(await pdf.save())
  const state = memoryWorkspace(source)
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const writes = createModelWriteService(state.workspaces)
  return { source, state, opened, writes }
}

test('model edits can create children in a recoverable imported outline without changing the source', async () => {
  const source = await recoverableOutlineFixture()
  const state = memoryWorkspace(source)
  const writes = createModelWriteService(state.workspaces)
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
    assert.ok('bytes' in opened)
    const chapter = opened.document.outline![0]
    const result = await writes.editOutline(sessionId, { documentId: opened.id, expectedRevision: opened.revision,
      operations: [{ type: 'outline-add', id: 'model-child', title: 'Created by model', page: 2, parentId: chapter.id }] }, agent, signal)
    assert.equal(result.savedToFile, false)
    const updated = state.workspaces.readSnapshot(sessionId, opened.id)
    assert.equal(updated.document.outlineReadOnlyReason, undefined)
    assert.deepEqual(updated.document.outline![0].children.map(item => item.id), [chapter.children[0].id, 'model-child'])
    assert.equal(updated.dirty, true)
    assert.equal(state.writes(), 0)
    assert.deepEqual(state.current(), source)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model outline edits are atomic undoable drafts; only approved save serializes the reviewed complete tree', async () => {
  const { source, state, opened, writes } = await fixture()
  try {
    const edited = await writes.editOutline(sessionId, { documentId: opened.id, expectedRevision: opened.revision, operations: [
      { type: 'outline-add', id: 'chapter-one', title: '第一章', page: 1 },
      { type: 'outline-add', id: 'chapter-two', title: '第二章', page: 2 },
      { type: 'outline-add', id: 'section', title: 'Section', page: 1, parentId: 'chapter-one' },
      { type: 'outline-update', id: 'section', patch: { title: '附录', page: 3 } },
      { type: 'outline-move', id: 'chapter-two', parentId: 'chapter-one', index: 0 },
    ] }, agent, signal)
    assert.equal(edited.savedToFile, false)
    assert.equal(edited.operationCount, 5)
    assert.equal(edited.revision, opened.revision + 1)
    assert.deepEqual(edited.outlineIds, ['chapter-one', 'chapter-two', 'section'])
    assert.deepEqual(state.current(), source)
    assert.equal(state.writes(), 0)
    const draft = state.workspaces.readSnapshot(sessionId, opened.id)
    assert.deepEqual(draft.document.outline?.[0].children.map(item => item.id), ['chapter-two', 'section'])
    const undone = await state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: opened.id, revision: edited.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.deepEqual(undone.document.outline, [])
    const redone = await state.workspaces.execute(sessionId, { action: 'redo', sessionId,
      id: opened.id, revision: undone.revision }, agent, signal)
    assert.ok('bytes' in redone)
    let reviews = 0
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: redone.revision },
      agent, signal, async detail => {
        reviews++
        assert.equal(detail.saveChangeCount, 3)
        assert.match(detail.saveDiffText!, /新增PDF内置书签/)
        assert.match(detail.saveDiffText!, /第一章/)
        assert.match(detail.saveDiffText!, /附录/)
        assert.match(detail.saveDiffText!, /父书签/)
        return false
      }), { code: 'pdf/approval-rejected' })
    assert.equal(reviews, 1)
    assert.equal(state.writes(), 0)
    const saved = await writes.save(sessionId, { documentId: opened.id, expectedRevision: redone.revision },
      agent, signal, async () => true)
    assert.equal(saved.status, 'saved')
    assert.equal(saved.dirty, false)
    assert.equal(state.writes(), 1)
    const reloaded = await loadPdfDocument(state.current())
    assert.equal(reloaded.outline?.[0].title, '第一章')
    assert.deepEqual(reloaded.outline?.[0].children.map(item => [item.id, item.title, item.page]), [
      ['chapter-two', '第二章', 2], ['section', '附录', 3],
    ])
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model outline mutations reject stale revision, session, source, invalid batches and read-only trees', async () => {
  const { state, opened, writes } = await fixture()
  const input = { documentId: opened.id, expectedRevision: opened.revision,
    operations: [{ type: 'outline-add' as const, id: 'chapter', title: 'Chapter', page: 1 }] }
  try {
    await assert.rejects(writes.editOutline('another-session', input, agent, signal), /session|belong/i)
    await assert.rejects(writes.editOutline(sessionId, { ...input, operations: [input.operations[0],
      { type: 'outline-move', id: 'chapter', parentId: 'chapter', index: 0 }] }, agent, signal),
    { code: 'invalid-operation' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.deepEqual(state.workspaces.readSnapshot(sessionId, opened.id).document.outline, [])
    const restricted = createModelWriteService({
      readSnapshot(owner, id) {
        const snapshot = state.workspaces.readSnapshot(owner, id)
        return { ...snapshot, document: { ...snapshot.document, outlineReadOnlyReason: 'Damaged source outline' } }
      }, execute: state.workspaces.execute,
    })
    try {
      await assert.rejects(restricted.editOutline(sessionId, input, agent, signal), { code: 'outline-read-only' })
    } finally { restricted.dispose() }
    const staleSource = createModelWriteService({
      readSnapshot: state.workspaces.readSnapshot,
      async execute(owner, request, caller, abort) {
        return request.action === 'inspectTarget' ? { version: `sha256:${'0'.repeat(64)}` }
          : state.workspaces.execute(owner, request, caller, abort)
      },
    })
    try {
      await assert.rejects(staleSource.editOutline(sessionId, input, agent, signal), { code: 'pdf/source-conflict' })
    } finally { staleSource.dispose() }
    const changed = await writes.editOutline(sessionId, input, agent, signal)
    await assert.rejects(writes.editOutline(sessionId, input, agent, signal), { code: 'pdf/stale-revision' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, changed.revision)
    assert.equal(state.writes(), 0)
    assert.equal(modelOutlineEditSchema.safeParse({ ...input, confirmed: true }).success, false)
    assert.equal(modelOutlineEditSchema.safeParse({ ...input, operations: Array.from({ length: 101 }, () => input.operations[0]) }).success, false)
    writes.dispose()
    await assert.rejects(writes.editOutline(sessionId, input, agent, signal), { code: 'pdf/write-unavailable' })
  } finally { writes.dispose(); await state.workspaces.dispose() }
})
