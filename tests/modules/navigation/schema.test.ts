import assert from 'node:assert/strict'
import test from 'node:test'
import { readingPositionRecordSchema } from '../../../src/modules/navigation/index.ts'
import { readingPositionSchema } from '../../../src/contracts/rpc/index.ts'

test('reading-position V1 records preserve the existing strict location schema', () => {
  const position = { page: 2, x: 12, y: 34, scale: 1.5, fit: 'width' as const,
    viewportAnchor: { x: 0.25, y: 0.75 } }
  const sourceHash = `sha256:${'0'.repeat(64)}`
  const updatedAt = '2026-10-18T00:00:00.000Z'
  const readingPosition = readingPositionRecordSchema.parse({ format: 1, path: '/sample.pdf',
    sourceHash, position, updatedAt })
  assert.deepEqual(position, readingPosition.position)
  assert.equal(readingPositionSchema.safeParse({ ...position, extra: true }).success, false)
})
