import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PDF_ENDPOINT, operationSchema, requestEnvelopeSchema, responseSchema, wireAnnotationSchema, wireSnapshotSchema,
} from '../../src/contracts/rpc/index.ts'

const annotation = { id: 'mark-1', page: 1, subtype: 'Highlight', flags: 4, supported: true, editable: true }
const status = {
  id: 'document-1', path: '/docs/reader.pdf', sourceVersion: 'v1', contentVersion: 'c1',
  revision: 2, dirty: true, canUndo: true, canRedo: false, conflict: false,
  reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
}

test('request envelope and response share the existing Connection RPC shape', () => {
  assert.equal(PDF_ENDPOINT, 'pdf.dispatch.v2')
  assert.deepEqual(requestEnvelopeSchema.parse({ type: 'client-request', rpcId: 'one', method: PDF_ENDPOINT,
    payload: { action: 'open' } }).payload, { action: 'open' })
  assert.equal(requestEnvelopeSchema.safeParse({ type: 'client-request', rpcId: '', method: PDF_ENDPOINT }).success, false)
  assert.equal(requestEnvelopeSchema.safeParse({ type: 'server-response', rpcId: 'one', method: PDF_ENDPOINT }).success, false)
  assert.deepEqual(responseSchema.parse({ ok: true, value: { id: 'document-1' } }),
    { ok: true, value: { id: 'document-1' } })
  assert.equal(responseSchema.safeParse({ ok: false, error: { code: 'pdf/invalid-page', message: 'Bad page' } }).success, true)
  assert.equal(responseSchema.safeParse({ ok: false, error: { code: 12 } }).success, false)
})

test('workspace wire contract accepts full snapshots and ordered annotation deltas', () => {
  assert.equal(wireAnnotationSchema.parse(annotation).id, 'mark-1')
  const full = wireSnapshotSchema.parse({ ...status, baselineAnnotations: [annotation], document: {
    pageCount: 1, signed: false, encrypted: false, readOnly: false,
    pages: [{ page: 1, cropBox: [0, 0, 400, 560], rotation: 0, userUnit: 1 }],
    annotations: [annotation],
  } })
  assert.equal(full.document?.annotations[0]?.id, 'mark-1')
  const delta = wireSnapshotSchema.parse({ ...status,
    annotationDelta: { fromRevision: 1, remove: ['old'], upsert: [annotation] },
  })
  assert.equal(delta.annotationDelta?.upsert.length, 1)
  assert.equal(delta.document, undefined)
  assert.equal(wireSnapshotSchema.safeParse({ ...status, reader: { ...status.reader, bytesHash: 'bad' } }).success, false)
})

test('annotation reply links survive snapshots and change-request validation', () => {
  const reply = { ...annotation, id: 'reply-1', subtype: 'Text', replyToId: annotation.id, replyType: 'R' }
  assert.equal(wireAnnotationSchema.parse(reply).replyToId, annotation.id)
  const add = { type: 'add', annotation: {
    id: 'reply-2', page: 1, subtype: 'Text', rect: [10, 20, 30, 40],
    replyToId: annotation.id, contents: 'A second comment',
  } }
  const parsed = operationSchema.parse(add)
  assert.equal(parsed.type, 'add')
  if (parsed.type !== 'add') throw new Error('Expected an add operation')
  assert.equal(parsed.annotation.replyToId, annotation.id)
  assert.equal(operationSchema.safeParse({ ...add, annotation: { ...add.annotation, replyToId: '' } }).success, false)
})
