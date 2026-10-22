import assert from 'node:assert/strict'
import test from 'node:test'
import { appendGroup, moveCursor, operationsThrough, projectedDocument, projectFormOperations, draftSchema,
  type WorkspaceRecord } from '../../../src/modules/working-copy/index.ts'
import { projectWorkingCopyOperations } from '../../../src/modules/working-copy/history.ts'
import type { PdfDocumentInfo, PdfWorkingCopyOperation } from '../../../src/core/pdf-types.ts'

const baseline: PdfDocumentInfo = {
  pageCount: 2, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false, outline: [],
  formKind: 'acroform', formFields: [{ name: 'name', type: 'text', value: '', widgets: [], readOnly: false, required: false }],
}
const record: WorkspaceRecord = {
  format: 1, sessionId: 's', path: '/book.pdf', sourceHash: `sha256:${'1'.repeat(64)}`,
  sourceVersion: 'fs-1', contentVersion: 'content-1', original: 'baseline', revision: 0,
  groups: [], groupDates: [], cursor: 0,
}

test('outline drafts survive wire persistence and undo/redo without changing form or annotation dates', () => {
  const firstDate = '2026-10-22T00:00:00.000Z'
  const secondDate = '2026-10-22T01:00:00.000Z'
  const group: PdfWorkingCopyOperation[] = [
    { type: 'outline-add', id: 'chapter', title: 'Chapter', page: 1 },
    { type: 'set-field', name: 'name', value: 'reader' },
    { type: 'add', annotation: { id: 'note', page: 1, subtype: 'Text', rect: [0, 0, 10, 10], contents: 'Note' } },
  ]
  const first = appendGroup(record, group, firstDate)
  const next = appendGroup(first, [
    { type: 'outline-update', id: 'chapter', patch: { title: 'Renamed', page: 2 } },
    { type: 'update', id: 'note', patch: { contents: 'Edited note' } },
  ], secondDate)
  const restored = draftSchema.parse(JSON.parse(JSON.stringify(next))) as WorkspaceRecord
  assert.equal(restored.format, 1)
  assert.deepEqual(operationsThrough(restored).dates, [firstDate, firstDate, firstDate, secondDate, secondDate])
  const projection = projectedDocument(baseline, restored)
  assert.deepEqual(projection.outline, [{ id: 'chapter', title: 'Renamed', page: 2, targetChanged: true, children: [] }])
  assert.equal(projection.formFields?.[0].value, 'reader')
  assert.equal(projection.annotations[0].createdAt, 'D:20261022000000Z')
  assert.equal(projection.annotations[0].modifiedAt, 'D:20261022010000Z')
  const undone = moveCursor(restored, 'undo')
  assert.equal(projectedDocument(baseline, undone).outline?.[0].title, 'Chapter')
  assert.equal(projectedDocument(baseline, undone).annotations[0].contents, 'Note')
  assert.deepEqual(projectedDocument(baseline, moveCursor(undone, 'redo')), projection)
  assert.equal(projectedDocument(baseline, moveCursor(undone, 'undo')), baseline)
  const branch = appendGroup(undone, [{ type: 'outline-delete', id: 'chapter' }], secondDate)
  assert.deepEqual(projectedDocument(baseline, branch).outline, [])
  assert.equal(branch.groups.length, 2)
  assert.equal(branch.cursor, 2)
  assert.equal(baseline.outline?.length, 0)
  assert.equal(baseline.formFields?.[0].value, '')
})

test('mixed operation dates remain aligned with annotations and locked forms reject edits', () => {
  const date = '2026-10-22T03:00:00.000Z'
  const projected = projectWorkingCopyOperations(baseline, [
    { type: 'set-field', name: 'name', value: 'reader' },
    { type: 'outline-add', id: 'chapter', title: 'Chapter', page: 1 },
    { type: 'add', annotation: { id: 'dated-note', page: 1, subtype: 'Text', rect: [0, 0, 10, 10] } },
  ], ['2026-10-22T01:00:00.000Z', '2026-10-22T02:00:00.000Z', date])
  assert.equal(projected.annotations[0].createdAt, 'D:20261022030000Z')
  for (const document of [{ ...baseline, readOnly: true }, { ...baseline, formKind: undefined },
    { ...baseline, formFields: undefined }]) {
    assert.throws(() => projectFormOperations(document, [{ type: 'set-field', name: 'name', value: 'no' }]),
      { code: 'read-only' })
  }
  assert.equal(baseline.formFields?.[0].value, '')
})
