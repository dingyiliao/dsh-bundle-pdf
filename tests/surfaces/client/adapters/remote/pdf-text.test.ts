import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfApi, type PdfConnection } from '../../../../../src/surfaces/client/adapters/remote/pdf-api.ts'
import type { NativeTextContent, ReaderDescriptor } from '../../../../../src/shared/native.ts'

const reader: ReaderDescriptor = { bytesHash: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, generation: 1 }
const raw: NativeTextContent = { items: [{ str: 'Native text', transform: [10, 0, 0, 10, 30, 40], width: 50,
  height: 10, dir: 'ltr', fontName: 'native', hasEOL: false, glyphs: [[30, 40, 5]] }],
  styles: { native: { fontFamily: 'Native font', ascent: 1, descent: 0, vertical: false } }, lang: null,
  quality: { unmappedCharacters: 3 }, warnings: ['Native mapping is incomplete'] }

test('remote text reads native page text and preserves quality and warning provenance', async () => {
  const calls: unknown[][] = []
  const connection: PdfConnection = { rpc: { async call(...args) {
    calls.push(args)
    return { ok: true, value: raw }
  } } }
  const lifetime = new AbortController(), operation = new AbortController(), api = createPdfApi(connection, lifetime.signal)
  try {
    assert.deepEqual(await api.native.text('session-1', 'document-1', reader, 4, operation.signal), raw)
    assert.deepEqual(calls[0]?.slice(0, 3), ['/api', 'pdf.native', {
      action: 'text', sessionId: 'session-1', id: 'document-1', bytesHash: reader.bytesHash, page: 4,
    }])
    assert.ok(calls[0]?.[3] instanceof AbortSignal)
  } finally { lifetime.abort() }
})

test('invalid text provenance is rejected instead of being stripped before native validation', async () => {
  for (const invalid of [{ quality: { unmappedCharacters: -1 } },
    { quality: { unmappedCharacters: 1.5 } }, { warnings: [42] }]) {
    const lifetime = new AbortController()
    const api = createPdfApi({ rpc: { async call() { return { ok: true, value: { ...raw, ...invalid } } } } }, lifetime.signal)
    try { await assert.rejects(api.native.text('session-1', 'document-1', reader, 1)) }
    finally { lifetime.abort() }
  }
})
