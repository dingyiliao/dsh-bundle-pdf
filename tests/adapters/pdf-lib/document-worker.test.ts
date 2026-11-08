import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { PDFDocument } from 'pdf-lib'
import { createPdfLibDocumentAdapter } from '../../../src/adapters/host/pdf-lib/document-adapter.ts'
import { applyPdfOperations, loadPdfDocument, PdfDocumentError, type PdfWorkingCopyOperation } from '../../../src/adapters/host/pdf-lib/pdf-document.ts'
import type { PdfDocumentWorkerReply, PdfDocumentWorkerRequest } from '../../../src/adapters/host/pdf-lib/document-worker-protocol.ts'

test('the built worker preserves inspection and materialization, source bytes, and index identities', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText('First indexed page')
  pdf.addPage().drawText('Second indexed page')
  const source = await pdf.save()
  // Use a view into a larger buffer to exercise the exact byte-range transfer.
  const padded = new Uint8Array(source.length + 8).fill(255)
  padded.set(source, 4)
  const view = padded.subarray(4, -4)
  const operations: PdfWorkingCopyOperation[] = [{ type: 'add', annotation: {
    id: 'worker-note', page: 2, subtype: 'Text', rect: [20, 20, 40, 40], contents: 'Index should still be reusable',
  } }]
  const dates = ['2026-11-01T00:00:00.000Z']
  const baseline = await loadPdfDocument(source)
  const expected = await applyPdfOperations(source, operations, dates)
  const adapter = createPdfLibDocumentAdapter()
  try {
    const [document, saved] = await Promise.all([adapter.inspect(view), adapter.materialize(view, operations, dates)])
    assert.deepEqual(document, baseline)
    assert.deepEqual(saved, expected)
    assert.deepEqual(view, source, 'the Host still owns the exact working-copy bytes')
    assert.equal(padded[0], 255)
    assert.ok(Object.isFrozen(document.indexPageDigests))
    assert.ok(Object.isFrozen(saved.document.indexPageDigests))
    const reopened = await adapter.inspect(saved.bytes)
    assert.equal(reopened.annotations[0]?.id, 'worker-note')
    assert.equal(reopened.indexContentDigest, baseline.indexContentDigest)
    assert.deepEqual(reopened.indexPageDigests, baseline.indexPageDigests)
  } finally { await adapter.dispose() }
})

test('a malformed PDF keeps its error code and does not poison later worker requests', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage()
  const source = await pdf.save()
  const adapter = createPdfLibDocumentAdapter()
  try {
    const rejected = assert.rejects(adapter.inspect(new Uint8Array([1, 2, 3])),
      error => error instanceof PdfDocumentError && error.code === 'invalid-pdf')
    const next = adapter.inspect(source)
    await rejected
    assert.equal((await next).pageCount, 1)
  } finally { await adapter.dispose() }
})

test('unloading a worker rejects its in-flight request and drains queued work', async () => {
  const url = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads'
    parentPort.on('message', () => {})
  `)}`)
  const adapter = createPdfLibDocumentAdapter(url)
  const source = Uint8Array.of(0)
  const pending = assert.rejects(adapter.inspect(source), { code: 'pdf/unavailable' })
  const queued = assert.rejects(adapter.inspect(source), { code: 'pdf/unavailable' })
  await new Promise<void>(resolve => setImmediate(resolve))
  const drain = adapter.dispose()
  assert.equal(adapter.dispose(), drain)
  await Promise.all([pending, queued, drain])
  await assert.rejects(adapter.inspect(source), { code: 'pdf/unavailable' })
})

test('a worker that exits while processing a request can be restarted for the next request', async () => {
  const url = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads'
    parentPort.on('message', ({ bytes }) => {
      if (bytes[0] === 0) process.exit(1)
      parentPort.postMessage({ ok: true, document: { pageCount: 1 } })
    })
  `)}`)
  const adapter = createPdfLibDocumentAdapter(url)
  try {
    const crashed = assert.rejects(adapter.inspect(Uint8Array.of(0)), { code: 'pdf/unavailable' })
    const recovered = adapter.inspect(Uint8Array.of(1))
    await crashed
    assert.equal((await recovered).pageCount, 1)
  } finally { await adapter.dispose() }
})

test('the Host reports worker startup and reply decoding failures as unavailable', async t => {
  const unsupported = createPdfLibDocumentAdapter(new URL('https://example.invalid/pdf-worker.mjs'))
  try { await assert.rejects(unsupported.inspect(Uint8Array.of(0)), { code: 'pdf/unavailable' }) }
  finally { await unsupported.dispose() }

  const malformedReply = new Error('Could not decode a worker reply')
  const port = t.mock.method(Worker.prototype, 'postMessage', function (this: Worker) {
    queueMicrotask(() => this.emit('messageerror', malformedReply))
  })
  const adapter = createPdfLibDocumentAdapter()
  try {
    await assert.rejects(adapter.inspect(Uint8Array.of(0)), { code: 'pdf/unavailable', cause: malformedReply })
    port.mock.restore()
    const pdf = await PDFDocument.create(); pdf.addPage()
    assert.equal((await adapter.inspect(await pdf.save())).pageCount, 1)
  } finally { await adapter.dispose() }
})

test('an operation that cannot be cloned does not hold the document worker queue', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage()
  const bytes = await pdf.save()
  const adapter = createPdfLibDocumentAdapter()
  const operation = { type: 'delete', id: 'note', unsafeCallback: () => {} } as const
  try {
    const rejected = assert.rejects(adapter.materialize(bytes, [operation], []), { name: 'DataCloneError' })
    const inspected = adapter.inspect(bytes)
    await rejected
    assert.equal((await inspected).pageCount, 1)
  } finally { await adapter.dispose() }
})

test('the worker entry registers its parent message protocol and transfers materialized bytes', async () => {
  const entry = new URL('../../../src/adapters/host/pdf-lib/document-worker.ts', import.meta.url)
  await assert.rejects(import(entry.href), /requires a parent port/)

  // The production worker also has end-to-end tests above. Exercise its source
  // listener in this test process so the Node line report can observe it.
  const threads = createRequire(import.meta.url)('node:worker_threads') as { parentPort: unknown }
  const originalPort = threads.parentPort
  const channel = new EventEmitter()
  const port = Object.assign(channel, { postMessage(reply: PdfDocumentWorkerReply, transfer?: ArrayBuffer[]) {
    channel.emit('reply', reply, transfer)
  } })
  threads.parentPort = port
  syncBuiltinESMExports()
  try { await import(`${entry.href}?parent-message-protocol`) }
  finally {
    threads.parentPort = originalPort
    syncBuiltinESMExports()
  }

  async function request(message: PdfDocumentWorkerRequest): Promise<[PdfDocumentWorkerReply, ArrayBuffer[]?]> {
    const reply = once(channel, 'reply')
    assert.equal(channel.emit('message', message), true)
    return await reply as [PdfDocumentWorkerReply, ArrayBuffer[]?]
  }

  const pdf = await PDFDocument.create(); pdf.addPage()
  const bytes = await pdf.save()
  const [inspected] = await request({ action: 'inspect', bytes })
  assert.ok(inspected.ok)
  assert.equal(inspected.document.pageCount, 1)
  const [saved, transfer] = await request({ action: 'materialize', bytes, operations: [{ type: 'add', annotation: {
    id: 'entry-note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20], contents: 'Protocol exercise',
  } }], operationDates: ['2026-11-01T00:00:00.000Z'] })
  assert.ok(saved.ok && saved.bytes)
  assert.deepEqual(transfer, [saved.bytes.buffer])
  assert.equal(saved.document.annotations[0]?.id, 'entry-note')
  const [invalid] = await request({ action: 'inspect', bytes: Uint8Array.of(1, 2, 3) })
  assert.ok(!invalid.ok)
  assert.equal(invalid.error.code, 'invalid-pdf')
})
