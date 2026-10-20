import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createPdfApi } from '../src/adapters/client/remote/pdf-api.ts'

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

test('the reading-position API sends only the stored shape and reports staleness', async () => {
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  const position = { page: 3, x: 12, y: 34, scale: 1.25, fit: 'custom' as const, viewportAnchor: { x: 0.5, y: 0 } }
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if ((payload as { action: string }).action === 'get') {
      return { ok: true, value: { position: { position, stale: 'content-changed', updatedAt: '2026-10-16T00:00:00.000Z' } } }
    }
    return { ok: true, value: { stored: true } }
  } } }, new AbortController().signal)

  // `documentVersion` belongs to one open document and must not be stored.
  await api.positions.set('session', 'doc-1', { ...position })
  assert.deepEqual(calls[0], { method: 'pdf.position',
    payload: { action: 'set', sessionId: 'session', id: 'doc-1', position } })
  assert.equal('documentVersion' in (calls[0]!.payload.position as object), false)

  const stored = await api.positions.get('session', 'doc-1')
  assert.equal(stored?.stale, 'content-changed')
  assert.deepEqual(stored?.position, position)
  assert.equal(stored?.updatedAt, '2026-10-16T00:00:00.000Z')
  assert.deepEqual(calls[1], { method: 'pdf.position', payload: { action: 'get', sessionId: 'session', id: 'doc-1' } })
})

test('an absent reading position reads as null rather than an error', async () => {
  const api = createPdfApi({ rpc: { async call() { return { ok: true, value: { position: null } } } } }, new AbortController().signal)
  assert.equal(await api.positions.get('session', 'doc-1'), null)
})
