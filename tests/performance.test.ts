import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { loadPdfDocument, applyPdfOperations } from '../src/core/pdf-document.ts'
import { beginPdfSpan, measurePdfAsync, measurePdfSync, observePdfPerformance, type PdfPerformanceEvent } from '../src/shared/performance.ts'

test('observers cannot break PDF operations and disposal suppresses late events', async () => {
  const events: PdfPerformanceEvent[] = []
  const dispose = observePdfPerformance(event => { events.push(event); throw new Error('collector failure') })
  try {
    assert.equal(measurePdfSync('host.project', {}, () => 42), 42)
    assert.equal(await measurePdfAsync('host.inspect', {}, async () => 7), 7)
    const span = beginPdfSpan('client.raster')
    dispose(); span.end()
    assert.equal(events.length, 2)
    assert.ok(events.every(event => event.durationMs >= 0 && event.status === 'ok'))
  } finally { dispose() }
})

test('error and cancellation timings retain original exceptions and end only once', async () => {
  const events: PdfPerformanceEvent[] = []
  const stop = observePdfPerformance(event => events.push(event))
  const error = new Error('expected failure')
  try {
    assert.throws(() => measurePdfSync('host.project', {}, () => { throw error }), value => value === error)
    await assert.rejects(measurePdfAsync('client.rpc', {}, async () => { throw new DOMException('cancelled', 'AbortError') }))
    const span = beginPdfSpan('client.raster'); span.end('cancelled'); span.end('ok')
    assert.deepEqual(events.map(event => event.status), ['error', 'cancelled', 'cancelled'])
  } finally { stop() }
})

test('public document functions emit opt-in spans without changing parse and materialization', async () => {
  const source = await PDFDocument.create(); source.addPage([300, 400])
  const bytes = await source.save()
  const events: PdfPerformanceEvent[] = []
  const stop = observePdfPerformance(event => events.push(event))
  try {
    assert.equal((await loadPdfDocument(bytes)).pageCount, 1)
    const output = await applyPdfOperations(bytes, [{ type: 'add', annotation: {
      id: 'perf-test-note', page: 1, subtype: 'Text', rect: [40, 40, 60, 60], contents: 'not logged',
    } }])
    assert.equal(output.document.annotations.length, 1)
    assert.deepEqual(events.map(event => event.name), ['host.inspect', 'host.materialize'])
    assert.equal(JSON.stringify(events).includes('not logged'), false)
  } finally { stop() }
})
