import assert from 'node:assert/strict'
import test from 'node:test'
import { assertToolCursorIdentity, decodeToolCursor, encodeToolCursor,
  type ToolCursor } from '../../../src/modules/evidence/tool-cursor.ts'

const cursor: ToolCursor = { version: 1, kind: 'search', sessionId: 'session-1', documentId: 'doc-1',
  contentVersion: 'content-1', revision: 1, sourceDigest: 'sha256:source', queryHash: 'sha256:query', page: 2, offset: 3 }

test('tool cursors round trip canonical opaque strings without raw query text', () => {
  const token = encodeToolCursor(cursor)
  assert.deepEqual(decodeToolCursor(token), cursor)
  assert.equal(token.includes('Needle'), false)
  assert.doesNotThrow(() => assertToolCursorIdentity(decodeToolCursor(token), cursor))
})

test('tool cursor decoding rejects malformed, noncanonical, oversized and invalid payloads', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  for (const value of ['invalid', `${encodeToolCursor(cursor)}=`, 'a'.repeat(4097),
    encode(null), encode([]), encode({ ...cursor, version: 2 }), encode({ ...cursor, kind: 'annotation' }),
    encode({ ...cursor, page: 0 }), encode({ ...cursor, offset: -1 }), encode({ ...cursor, unknown: true }),
    encode({ ...cursor, kind: 'bookmarks' }), encode({ ...cursor, sessionId: '' }),
  ]) {
    assert.throws(() => decodeToolCursor(value), { code: 'pdf/invalid-window' })
  }
})

test('valid tool cursor with a different kind cannot splice another listing', () => {
  const bookmark: ToolCursor = { version: 1, kind: 'bookmarks', sessionId: cursor.sessionId,
    documentId: cursor.documentId, contentVersion: cursor.contentVersion, revision: cursor.revision,
    sourceDigest: cursor.sourceDigest, queryHash: cursor.queryHash, offset: 1 }
  assert.throws(() => assertToolCursorIdentity(decodeToolCursor(encodeToolCursor(bookmark)), cursor),
    { code: 'pdf/stale-reader' })
})
