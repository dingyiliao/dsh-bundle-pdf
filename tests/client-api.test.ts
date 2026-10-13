import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createPdfApi } from '../src/client/api.ts'

test('accepts native snapshots without transferring PDF bytes or inventing a MediaBox', async () => {
  const bytesHash = `sha256:${createHash('sha256').update('native snapshot').digest('hex')}`
  const api = createPdfApi({ rpc: { async call(path, method) {
    assert.equal(path, '/api')
    assert.equal(method, 'pdf.dispatch.v2')
    return { ok: true, value: {
      id: 'native-pdf', path: 'D:/workspace/document.pdf', sourceVersion: 'source', contentVersion: 'content',
      revision: 0, dirty: false, canUndo: false, canRedo: false, conflict: false,
      reader: { bytesHash, generation: 1, protocolVersion: 1 },
      document: {
        pageCount: 1, signed: false, encrypted: false, readOnly: false,
        pages: [{ page: 1, cropBox: [0, 0, 200, 300], rotation: 0, userUnit: 1 }],
        annotations: [{ id: 'native-highlight', page: 1, subtype: 'Highlight', flags: 4,
          supported: true, editable: true }],
      },
    } }
  } } }, new AbortController().signal)
  const snapshot = await api.open('test-session', 'dsh-resource://file/session/test-session/D%3A/workspace/document.pdf')
  assert.equal('bytes' in snapshot, false)
  assert.equal(snapshot.reader.generation, 1)
  assert.equal(snapshot.document.encrypted, false)
  assert.equal(snapshot.document.readOnly, false)
  assert.equal(snapshot.document.pages[0].mediaBox, undefined)
  assert.equal(snapshot.document.annotations[0].editable, true)
})
