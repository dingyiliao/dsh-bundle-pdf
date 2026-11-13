import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixtureDocumentPort } from '../../fixtures/native-document.ts'
import { blankPdf, plainPdf } from '../../fixtures/plain-pdf.ts'

test('document IPC preserves the exact input view, geometry and fingerprint across a concurrent save and inspection', async t => {
  const source = plainPdf([
    { size: [200, 300], lines: [{ text: 'First indexed page', x: 20, y: 200, size: 12 }] },
    { size: [200, 300], lines: [{ text: 'Second indexed page', x: 20, y: 200, size: 12 }] },
  ])
  const padded = new Uint8Array(source.length + 8).fill(255)
  padded.set(source, 4)
  const view = padded.subarray(4, -4)
  const port = createFixtureDocumentPort()
  t.after(() => port.dispose())
  const [baseline, saved] = await Promise.all([
    port.inspect(view),
    port.materialize(view, [{ type: 'add', annotation: {
      id: 'worker-note', page: 2, subtype: 'Text', rect: [20, 20, 40, 40], contents: 'Still indexed',
    } }], ['2026-11-01T00:00:00Z']),
  ])
  assert.deepEqual(view, new Uint8Array(source))
  assert.equal(padded[0], 255)
  assert.equal(padded.at(-1), 255)
  assert.equal(baseline.pageCount, 2)
  assert.ok(baseline.indexContentDigest)
  assert.deepEqual(saved.document.indexPageDigests, baseline.indexPageDigests)
  const reopened = await port.inspect(saved.bytes.slice())
  assert.equal(reopened.annotations[0]?.id, 'worker-note')
  assert.equal(reopened.indexContentDigest, baseline.indexContentDigest)
})

test('malformed input preserves its error and does not poison the next queued PDF', async t => {
  const port = createFixtureDocumentPort()
  t.after(() => port.dispose())
  const rejected = assert.rejects(port.inspect(Uint8Array.of(1, 2, 3)), { code: 'invalid-pdf' })
  const next = port.inspect(blankPdf())
  await rejected
  assert.equal((await next).pageCount, 1)
})

test('unloading the native document port rejects pending and future inspections', async () => {
  const port = createFixtureDocumentPort()
  const source = blankPdf()
  const pending = assert.rejects(port.inspect(source), /unloading/)
  const queued = assert.rejects(port.inspect(source), /unloading/)
  const drain = port.dispose()
  assert.equal(port.dispose(), drain)
  await Promise.all([pending, queued, drain])
  await assert.rejects(port.inspect(source), /unloading/)
})
