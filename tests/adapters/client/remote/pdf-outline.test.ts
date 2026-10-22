import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfApi, type PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'
import type { ReaderDescriptor } from '../../../../src/shared/native.ts'

const reader: ReaderDescriptor = { bytesHash: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, generation: 1 }

test('remote outline reads retain editable identities at every level and preserve exact navigation targets', async () => {
  const value = [{ id: 'pdf-outline:17:0', title: 'Chapter', dest: [0, { name: 'XYZ' }, 12, 540, 1.5], items: [
    { id: 'named-section', title: 'Named section', dest: 'section-destination', items: [] },
    { id: 'external-reference', title: 'External reference', url: 'https://example.com/reference', items: [] },
  ] }]
  const calls: unknown[][] = []
  const connection: PdfConnection = { rpc: { async call(...args) {
    calls.push(args)
    return { ok: true, value }
  } } }
  const lifetime = new AbortController()
  const operation = new AbortController()
  const api = createPdfApi(connection, lifetime.signal)
  try {
    const outline = await api.native.outline('session-1', 'document-1', reader, operation.signal)
    assert.deepEqual(outline, value)
    assert.deepEqual(calls[0]?.slice(0, 3), ['/api', 'pdf.native', {
      action: 'outline', sessionId: 'session-1', id: 'document-1', bytesHash: reader.bytesHash,
    }])
    assert.ok(calls[0]?.[3] instanceof AbortSignal)
  } finally { lifetime.abort() }
})

test('remote outline reads still accept native read-only items without editable identities and empty outlines', async () => {
  for (const value of [null, [{ title: 'Read-only native chapter', dest: [0, { name: 'Fit' }], items: [] }]]) {
    const lifetime = new AbortController()
    const api = createPdfApi({ rpc: { async call() { return { ok: true, value } } } }, lifetime.signal)
    try {
      assert.deepEqual(await api.native.outline('session-1', 'document-1', reader, new AbortController().signal), value)
    } finally { lifetime.abort() }
  }
})

test('remote outline reads validate nested editable identities instead of silently dropping invalid IDs', async () => {
  const lifetime = new AbortController()
  const api = createPdfApi({ rpc: { async call() { return { ok: true, value: [{
    id: 'chapter', title: 'Chapter', items: [{ id: 'x'.repeat(513), title: 'Invalid child', items: [] }],
  }] } } } }, lifetime.signal)
  try {
    await assert.rejects(api.native.outline('session-1', 'document-1', reader, new AbortController().signal))
  } finally { lifetime.abort() }
})
