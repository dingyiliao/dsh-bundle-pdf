import assert from 'node:assert/strict'
import test from 'node:test'
import { operationSchema, requestSchema } from '../../src/contracts/rpc/index.ts'

const digest = `sha256:${'a'.repeat(64)}`

test('working-copy RPC validates one-based annotations and strict request envelopes', () => {
  const operation = { type: 'add', annotation: { id: 'mark-1', page: 1, subtype: 'Highlight',
    rect: [1, 2, 3, 4], quadPoints: [1, 4, 3, 4, 1, 2, 3, 2] } }
  const parsed = operationSchema.parse(operation)
  assert.equal(parsed.type === 'add' && parsed.annotation.page, 1)
  assert.equal(requestSchema.parse({ action: 'change', sessionId: 's', id: 'd', revision: 0,
    operations: [operation] }).action, 'change')
  assert.equal(operationSchema.safeParse({ ...operation, annotation: { ...operation.annotation, page: 0 } }).success, false)
  assert.equal(requestSchema.safeParse({ action: 'change', sessionId: 's', id: 'd', revision: 0,
    operations: [operation], unexpected: true }).success, false)
  assert.equal(operationSchema.safeParse({ type: 'update', id: 'note-1', patch: { rect: [10, 20, 30, 40] } }).success, true)
  assert.equal(operationSchema.safeParse({ type: 'update', id: 'note-1', patch: { rect: [10, 20, 10, 40] } }).success, false)
  assert.equal(operationSchema.safeParse({ type: 'update', id: 'mark-1', patch: { commentPosition: [120, 240] } }).success, true)
  assert.equal(operationSchema.safeParse({ type: 'update', id: 'mark-1', patch: { commentPosition: [120, Number.NaN] } }).success, false)
})

test('save request preserves explicit compare-and-swap and overwrite intent', () => {
  const save = requestSchema.parse({ action: 'save', sessionId: 's', id: 'd', revision: 3,
    options: { path: '/docs/book.pdf', overwrite: true, expectedTargetVersion: digest } })
  assert.equal(save.action, 'save')
  if (save.action === 'save') assert.equal(save.options.expectedTargetVersion, digest)
  assert.equal(requestSchema.safeParse({ action: 'save', sessionId: 's', id: 'd', revision: 3,
    options: { expectedTargetVersion: 'not-a-digest' } }).success, false)
})
