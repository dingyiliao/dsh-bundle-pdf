/** One fresh process per host component run; input read and setup are outside durationMs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { loadPdfDocument, applyPdfOperations } from '../src/core/pdf-document.ts'
import { projectPdfOperations } from '../src/core/pdf-operation-projection.ts'
import type { PdfAnnotationOperation, PdfDocumentInfo } from '../src/core/pdf-types.ts'
import { observePdfPerformance, type PdfPerformanceEvent } from '../src/shared/performance.ts'
import { FIXED_DATE } from './corpus.ts'
import { sha256 } from './metadata.ts'

const [file, scenario, expectedHash, expectedPages, expectedAnnotations] = process.argv.slice(2)
const stages: PdfPerformanceEvent[] = []
const metrics: Record<string, number | null> = {}
let qualityPassed = false
let status = 'ok', error: string | null = null
try {
  const bytes = new Uint8Array(await readFile(file))
  assert.equal(sha256(bytes), expectedHash, 'corpus digest changed')
  let document: PdfDocumentInfo | undefined
  if (scenario !== 'host.inspect') document = await loadPdfDocument(bytes)
  const operations: PdfAnnotationOperation[] = Array.from({ length: scenario === 'host.history-replay' ? 100 : 1 }, (_, i) => ({
    type: 'add', annotation: { id: `bench-added-${i}`, page: 1, subtype: 'Text', rect: [80, 80, 98, 98], contents: 'benchmark note' },
  }))
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable()
  // Arm the diagnostic timer. Short runs will not have enough samples for p99.
  await delay(12)
  const stop = observePdfPerformance(event => stages.push(event))
  const cpu = process.cpuUsage(), start = performance.now()
  let result: PdfDocumentInfo, saved: Uint8Array | undefined
  try {
    if (scenario === 'host.inspect') result = await loadPdfDocument(bytes)
    else if (scenario === 'host.project' || scenario === 'host.history-replay') result = projectPdfOperations(document!, operations, FIXED_DATE)
    else if (scenario === 'host.materialize') { const value = await applyPdfOperations(bytes, operations, operations.map(() => FIXED_DATE)); result = value.document; saved = value.bytes }
    else throw new Error('Unknown benchmark scenario')
    metrics.durationMs = performance.now() - start
    const cpuDelta = process.cpuUsage(cpu)
    metrics.cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
    stop() // Correctness reopens must not appear as measured operation stages.
    eventLoop.disable()
    metrics.hostEventLoopSampleCount = eventLoop.count
    metrics.hostEventLoopP99Ms = eventLoop.count >= 100 ? eventLoop.percentile(99) / 1e6 : null
    metrics.inputBytes = bytes.byteLength
    metrics.jsonMetadataBytes = Buffer.byteLength(JSON.stringify(result))
    metrics.outputBytes = saved?.byteLength ?? null
    assert.equal(result.pageCount, Number(expectedPages), 'page count differs from corpus manifest')
    assert.equal(result.annotations.length, Number(expectedAnnotations) + (scenario === 'host.inspect' ? 0 : operations.length), 'annotation count differs from corpus manifest')
    if (document) assert.equal(result.annotations.filter(x => x.id.startsWith('bench-added-')).length, operations.length)
    if (saved) {
      const reopened = await loadPdfDocument(saved)
      assert.equal(reopened.pageCount, result.pageCount)
      assert.equal(reopened.annotations.filter(x => x.id.startsWith('bench-added-')).length, operations.length)
    }
    qualityPassed = true
  } finally { stop(); eventLoop.disable() }
  metrics.hostMaxRssMiB = process.resourceUsage().maxRSS / 1024 // Includes process startup/setup/validation.
  metrics.heapUsedMiB = process.memoryUsage().heapUsed / 1048576
} catch (failure) {
  status = 'error'
  error = failure instanceof Error ? failure.message.slice(0, 200) : 'unknown benchmark failure'
}
// Parent process envelopes this payload with environment/source/corpus/run metadata.
process.stdout.write(`${JSON.stringify({ status, error, qualityPassed, metrics, stages })}\n`)
