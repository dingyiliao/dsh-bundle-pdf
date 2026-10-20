import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { explanationSourceIdentity, sameExplanationSource } from '../../../src/modules/explanation/index.ts'

const digest = `sha256:${'a'.repeat(64)}`
const snapshot = { id: 'pdf-1', path: '/book.pdf', sourceVersion: 'fs-1', contentVersion: 'content-1',
  revision: 4, conflict: false, reader: { bytesHash: digest } } as WorkspaceSnapshot

test('explanation source identity pins Session, document, filesystem version, baseline digest and revision', () => {
  const source = explanationSourceIdentity('session-1', snapshot)
  assert.ok(source)
  assert.equal(source.baselineDigest, digest)
  assert.equal(sameExplanationSource(source, 'session-1', snapshot), true)
  assert.equal(sameExplanationSource(source, 'session-2', snapshot), false)
  for (const changed of [
    { id: 'pdf-2' }, { path: '/other.pdf' }, { sourceVersion: 'fs-2' },
    { contentVersion: 'content-2' }, { revision: 5 },
    { reader: { ...snapshot.reader, bytesHash: `sha256:${'b'.repeat(64)}` } }, { conflict: true },
  ]) {
    assert.equal(sameExplanationSource(source, 'session-1', { ...snapshot, ...changed }), false)
  }
})

test('explanation source identity rejects snapshots without a verified PDF digest', () => {
  assert.equal(explanationSourceIdentity('session-1', null), null)
  assert.equal(explanationSourceIdentity('session-1', { ...snapshot, reader: { ...snapshot.reader, bytesHash: '' } }), null)
})
