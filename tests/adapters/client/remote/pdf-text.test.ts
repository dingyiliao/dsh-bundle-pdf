import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfApi, type PdfConnection } from '../../../../src/adapters/client/remote/pdf-api.ts'
import type { NativeTextContent, ReaderDescriptor } from '../../../../src/shared/native.ts'

const reader: ReaderDescriptor = { bytesHash: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, generation: 1 }
const raw: NativeTextContent = { items: [{ str: 'Native text', transform: [10, 0, 0, 10, 30, 40], width: 50,
  height: 10, dir: 'ltr', fontName: 'native', hasEOL: false, glyphs: [[30, 40, 5]] }],
  styles: { native: { fontFamily: 'Native font', ascent: 1, descent: 0, vertical: false } }, lang: null,
  quality: { unmappedCharacters: 3 }, warnings: ['Native mapping is incomplete'] }
const repaired: NativeTextContent = { ...raw, items: raw.items.map(({ glyphs: _glyphs, ...item }) => ({ ...item, str: 'Recognized text' })),
  extraction: 'local-ocr', warnings: ['Local OCR positions are approximate'] }

test('remote text forwards recover only when requested and preserves extraction, quality and warning provenance', async () => {
  const calls: unknown[][] = []
  const connection: PdfConnection = { rpc: { async call(...args) {
    calls.push(args)
    const request = args[2] as { recover?: boolean }
    return { ok: true, value: request.recover === false ? raw : repaired }
  } } }
  const lifetime = new AbortController(), operation = new AbortController(), api = createPdfApi(connection, lifetime.signal)
  try {
    assert.deepEqual(await api.native.text('session-1', 'document-1', reader, 4, operation.signal), repaired)
    assert.deepEqual(await api.native.text('session-1', 'document-1', reader, 4, operation.signal, { recover: false }), raw)
    assert.deepEqual(await api.native.text('session-1', 'document-1', reader, 4, operation.signal, { recover: true }), repaired)
    for (const [index, recover] of [undefined, false, true].entries()) {
      assert.deepEqual(calls[index]?.slice(0, 3), ['/api', 'pdf.native', {
        action: 'text', sessionId: 'session-1', id: 'document-1', bytesHash: reader.bytesHash, page: 4,
        ...(recover === undefined ? {} : { recover }),
      }])
      assert.ok(calls[index]?.[3] instanceof AbortSignal)
    }
  } finally { lifetime.abort() }
})

test('invalid text provenance is rejected instead of being stripped before native validation', async () => {
  for (const invalid of [{ extraction: 'unknown-producer' }, { quality: { unmappedCharacters: -1 } },
    { quality: { unmappedCharacters: 1.5 } }, { warnings: [42] }]) {
    const lifetime = new AbortController()
    const api = createPdfApi({ rpc: { async call() { return { ok: true, value: { ...raw, ...invalid } } } } }, lifetime.signal)
    try { await assert.rejects(api.native.text('session-1', 'document-1', reader, 1)) }
    finally { lifetime.abort() }
  }
})
