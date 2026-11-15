import assert from 'node:assert/strict'
import test from 'node:test'
import { asBaselineId, contentSnapshotOf, operationSetOf, sourceVersionOf, type BaselineResource } from '../../../src/modules/working-copy/model.ts'
import { workspaceSnapshot } from '../../../src/modules/working-copy/state.ts'
import { requestSchema } from '../../../src/contracts/rpc/requests.ts'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import type { V1DraftPort } from '../../../src/modules/working-copy/index.ts'
import type { PdfDocumentInfo } from '../../../src/core/pdf-types.ts'

const document: PdfDocumentInfo = {
  pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
  annotations: [], signed: false, encrypted: false, readOnly: false,
}
const baseline: BaselineResource = {
  baselineId: asBaselineId('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  source: { path: '/tmp/test.pdf', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: 'fs-7', size: 3 },
  bytes: new Uint8Array([1, 2, 3]), document,
}

test('source versions keep byte digest and provider version distinct', () => {
  const value = sourceVersionOf({ path: '/tmp/test.pdf', version: 'sha256:abc', fsVersion: 'mtime-9', size: 3 })
  assert.deepEqual(value, { path: '/tmp/test.pdf', digest: 'sha256:abc', version: 'mtime-9', size: 3 })
})

test('operation sets bind legacy groups to their stored baseline hash', () => {
  const operations = operationSetOf({ baselineId: undefined, sourceHash: baseline.baselineId, groups: [[{ type: 'delete', id: 'a' }]],
    groupDates: ['2026-01-01T00:00:00.000Z'], cursor: 1, revision: 4 })
  assert.equal(operations.baselineId, baseline.baselineId)
  assert.equal(operations.groups[0]?.operations[0]?.type, 'delete')
  assert.equal(operations.revision, 4)
})

test('open requests carry an explicit baseline decision without requiring it', () => {
  const parsed = requestSchema.parse({ action: 'open', sessionId: 's', address: 'file:///tmp/test.pdf', owner: 'agent',
    password: 'secret', baselineChoice: 'adopt-current' })
  assert.equal(parsed.action, 'open')
  assert.equal(parsed.baselineChoice, 'adopt-current')
})

test('legacy V1 drafts hydrate baselineId from sourceHash', () => {
  const saved = { format: 1 as const, sessionId: 's', path: '/tmp/test.pdf', sourceHash: baseline.source.digest,
    sourceVersion: 'fs-7', contentVersion: 'content-1', original: 'encoded-baseline', revision: 0,
    groups: [], groupDates: [], cursor: 0 }
  const table = new Map<string, any>([['draft', saved]])
  const tablePort: V1DraftPort = { get: key => table.get(key), put: async () => {}, delete: async () => {} }
  const hydrated = createV1DraftRepository(tablePort).hydrate(saved)
  assert.equal(hydrated.baselineId, saved.sourceHash)
})

test('workspace snapshots expose a shared content fence and explicit mismatch choices', () => {
  const record = { format: 1 as const, sessionId: 's', path: baseline.source.path, sourceHash: baseline.source.digest,
    baselineId: baseline.baselineId, sourceVersion: baseline.source.version, contentVersion: 'content-1', revision: 2,
    groups: [], groupDates: [], cursor: 0 }
  const snapshot = workspaceSnapshot('doc', record, baseline, document, true, {
    operationsBaselineId: baseline.baselineId, currentBaselineId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    choices: ['adopt-current', 'retain-operations'],
  })
  assert.equal(snapshot.contentContext?.baselineId, baseline.baselineId)
  assert.equal(snapshot.contentContext?.sourceDigest, baseline.source.digest)
  assert.equal(snapshot.contentContext?.revision, 2)
  assert.deepEqual(snapshot.baselineMismatch?.choices, ['adopt-current', 'retain-operations'])
  const readerContent = contentSnapshotOf(snapshot.id, 'reader', snapshot.contentContext!, { pageCount: 1 })
  assert.equal(readerContent.baselineId, baseline.baselineId)
  assert.equal(readerContent.renderer, 'reader')
})
