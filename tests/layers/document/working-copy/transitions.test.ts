import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkingCopyTransitions } from '../../../../src/layers/document/working-copy/transitions.ts'
import { asBaselineId } from '../../../../src/layers/document/working-copy/model.ts'
import type { WorkingCopyState } from '../../../../src/layers/document/working-copy/state.ts'
import type { WorkingCopyDraftPort, WorkingCopyFileRead } from '../../../../src/layers/document/working-copy/ports.ts'

const document = { pageCount: 1, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false }
const source: WorkingCopyFileRead = { path: '/book.pdf', version: 'new-hash', fsVersion: 'fs-2', size: 3,
  bytes: new Uint8Array([1, 2, 3]) }
const record = { format: 1 as const, sessionId: 'session', path: '/book.pdf', sourceHash: 'old-hash',
  sourceVersion: 'fs-1', contentVersion: 'content', revision: 2, groups: [], groupDates: [], cursor: 0 }
const baseline = { baselineId: asBaselineId('old-hash'), source: { path: '/book.pdf', digest: 'old-hash',
  version: 'fs-1', size: 1 }, bytes: new Uint8Array([0]), document }

function copy(): WorkingCopyState {
  return { id: 'doc', record, baseline, snapshot: { id: 'doc', path: '/book.pdf', sourceVersion: 'fs-1',
    contentVersion: 'content', revision: 2, dirty: false, canUndo: false, canRedo: false, conflict: false,
    document, bytes: baseline.bytes } }
}

test('transition refresh adopts a clean changed source as one aggregate update', async () => {
  let persisted = 0
  const drafts = { key() { return 'key' }, async persist(next: typeof record) { persisted++; return { ...next } },
    async delete() {}, async deleteBaseline() {} } as unknown as WorkingCopyDraftPort
  const transitions = createWorkingCopyTransitions({ drafts, async sourceBaseline(next) {
    return { baselineId: asBaselineId(next.version), source: { path: next.path, digest: next.version,
      version: next.fsVersion, size: next.size }, bytes: next.bytes, document }
  } })
  const state = copy()
  const snapshot = await transitions.refresh(state, source, new AbortController().signal)
  assert.equal(snapshot.conflict, false)
  assert.equal(state.record.sourceHash, source.version)
  assert.equal(state.baseline.baselineId, source.version)
  assert.equal(state.snapshot, snapshot)
  assert.equal(persisted, 1)
})

test('transition refresh preserves dirty operations and exposes a baseline decision', async () => {
  const state = copy()
  state.record = { ...record, groups: [[{ type: 'add', annotation: { id: 'note', page: 1,
    subtype: 'Text', rect: [1, 1, 2, 2] } }]], groupDates: ['2026-11-15T00:00:00Z'], cursor: 1 }
  state.snapshot = { ...state.snapshot, dirty: true }
  const transitions = createWorkingCopyTransitions({ drafts: {} as WorkingCopyDraftPort,
    async sourceBaseline() { throw new Error('must not adopt') } })
  const snapshot = await transitions.refresh(state, source, new AbortController().signal)
  assert.equal(snapshot.conflict, true)
  assert.deepEqual(snapshot.baselineMismatch, { operationsBaselineId: 'old-hash',
    currentBaselineId: 'new-hash', choices: ['adopt-current', 'retain-operations'] })
  assert.equal(state.record.sourceHash, 'old-hash')
})
