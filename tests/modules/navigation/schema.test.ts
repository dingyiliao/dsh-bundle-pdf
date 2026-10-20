import assert from 'node:assert/strict'
import test from 'node:test'
import { bookmarkPositionSchema, bookmarkRecordSchema, readingPositionRecordSchema } from '../../../src/modules/navigation/index.ts'

test('bookmark and reading-position V1 records share the existing strict location schema', () => {
  const position = { page: 2, x: 12, y: 34, scale: 1.5, fit: 'width' as const,
    viewportAnchor: { x: 0.25, y: 0.75 } }
  const sourceHash = `sha256:${'0'.repeat(64)}`
  const updatedAt = '2026-10-18T00:00:00.000Z'
  const bookmark = bookmarkRecordSchema.parse({ format: 1, path: '/sample.pdf', entries: [{
    id: '00000000-0000-4000-8000-000000000000', title: 'Second page', position,
    sourceHash, createdAt: updatedAt, updatedAt,
  }] })
  const readingPosition = readingPositionRecordSchema.parse({ format: 1, path: '/sample.pdf',
    sourceHash, position, updatedAt })
  assert.deepEqual(bookmark.entries[0].position, readingPosition.position)
  assert.equal(bookmarkPositionSchema.safeParse({ ...position, extra: true }).success, false)
})
