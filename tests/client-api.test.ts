import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfApi } from '../src/client/api.ts'

test('accepts encrypted read-only snapshots without inventing an unavailable MediaBox', async () => {
  const bytes = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55])
  const api = createPdfApi({ rpc: { async call() {
    return { ok: true, value: {
      id: 'encrypted-pdf', path: 'D:/workspace/encrypted.pdf', sourceVersion: 'source', contentVersion: 'content',
      revision: 0, dirty: false, canUndo: false, canRedo: false, conflict: false,
      bytes: Buffer.from(bytes).toString('base64'),
      document: {
        pageCount: 1, signed: false, encrypted: true, readOnly: true, readOnlyReason: 'encrypted-document',
        pages: [{ page: 1, cropBox: [0, 0, 200, 300], rotation: 0, userUnit: 1 }],
        annotations: [{ id: 'native-highlight', page: 1, subtype: 'Highlight', flags: 4,
          supported: true, editable: false, readOnlyReason: 'encrypted-document' }],
      },
    } }
  } } }, new AbortController().signal)
  const snapshot = await api.open('test-session', 'dsh-resource://file/session/test-session/D%3A/workspace/encrypted.pdf')
  assert.deepEqual(snapshot.bytes, bytes)
  assert.equal(snapshot.document.encrypted, true)
  assert.equal(snapshot.document.readOnly, true)
  assert.equal(snapshot.document.pages[0].mediaBox, undefined)
  assert.equal(snapshot.document.annotations[0].editable, false)
})
