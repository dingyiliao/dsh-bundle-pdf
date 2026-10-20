import assert from 'node:assert/strict'
import test from 'node:test'
import { appendGroup, moveCursor, operationsThrough, projectedDocument,
  type WorkspaceRecord } from '../../../src/modules/working-copy/index.ts'
import type { PdfDocumentInfo } from '../../../src/core/pdf-types.ts'

const first = { type: 'delete' as const, id: 'one' }
const second = { type: 'delete' as const, id: 'two' }
const replacement = { type: 'delete' as const, id: 'replacement' }
const record: WorkspaceRecord = {
  format: 1, sessionId: 's', path: '/a.pdf', sourceHash: `sha256:${'1'.repeat(64)}`,
  sourceVersion: 'fs-1', contentVersion: 'logical-1', revision: 5,
  groups: [[first], [second]], groupDates: ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'], cursor: 1,
}

test('active prefix excludes redo groups and a new edit replaces their branch atomically', () => {
  assert.deepEqual(operationsThrough(record), { operations: [first], dates: [record.groupDates[0]] })
  const next = appendGroup(record, [replacement], '2026-10-03T00:00:00.000Z')
  assert.deepEqual(next.groups, [[first], [replacement]])
  assert.deepEqual(next.groupDates, [record.groupDates[0], '2026-10-03T00:00:00.000Z'])
  assert.equal(next.cursor, 2)
  assert.equal(next.revision, 6)
  assert.equal(record.groups.length, 2, 'history helpers never mutate the original record')
  assert.deepEqual(operationsThrough(moveCursor(next, 'undo')).operations, [first])
  assert.deepEqual(operationsThrough(moveCursor(moveCursor(next, 'undo'), 'redo')).operations, [first, replacement])
})

test('zero-cursor projection returns the exact immutable baseline object', () => {
  const baseline: PdfDocumentInfo = {
    pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 20, 20], rotation: 0, userUnit: 1 }],
    annotations: [], signed: false, encrypted: false, readOnly: false,
  }
  assert.equal(projectedDocument(baseline, { ...record, cursor: 0 }), baseline)
})
