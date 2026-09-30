import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareMarkdown, quantile, readRows } from '../bench/report.ts'
import { rowSchema, type BenchmarkRow } from '../bench/schema.ts'

function row(iteration = 0, overrides: Partial<BenchmarkRow> = {}): BenchmarkRow {
  return rowSchema.parse({ schemaVersion: 1, runId: `test-${iteration}`, iteration, repeatCount: 2, expectedRowCount: 2, suite: 'smoke', measurementKind: 'host-component',
    scenario: 'host.inspect', documentId: 'fixture', documentSha256: 'a'.repeat(64), pageCount: 12, annotationCount: 0,
    seed: 187, cacheState: 'fresh-process-input-bytes-ready', qualityMode: 'metadata-and-reopen-validation', status: 'ok', qualityPassed: true,
    metrics: { durationMs: 10, inputBytes: 100, hostEventLoopP99Ms: null }, error: null,
    environment: { platform: 'test', cpu: 'fixed' },
    source: { commit: 'base', dirty: false, treeSha256: 'b'.repeat(64), protocolSha256: 'e'.repeat(64), benchmarkVersion: 'm0-v1' }, stages: [], ...overrides })
}

test('nearest-rank quantiles retain missing data and reject invalid probability', () => {
  assert.equal(quantile([], 0.95), null)
  assert.equal(quantile([30, 10, 20], 0.5), 20)
  assert.equal(quantile([30, 10, 20], 0.95), 30)
  assert.throws(() => quantile([1], 1.01), /probability/)
})
test('comparison refuses incompatible environment, corpus, cache and iteration inventory', () => {
  const before = [row(0), row(1)]
  assert.throws(() => compareMarkdown(before, [row(0, { environment: { platform: 'another' } }), row(1)]), /Environment/)
  assert.throws(() => compareMarkdown(before, [row(0, { documentSha256: 'c'.repeat(64) }), row(1)]), /groups/)
  assert.throws(() => compareMarkdown(before, [row(0, { cacheState: 'warm' }), row(1)]), /groups/)
  assert.throws(() => compareMarkdown(before, [row(0)]), /inventory/)
  assert.throws(() => compareMarkdown(before, [row(0), row(0)]), /Duplicate iteration/)
})
test('comparison does not convert missing metrics, failures or counts into speed claims', () => {
  const oldRows = [row(0), row(1)]
  const newRows = [row(0, { metrics: { durationMs: 5, inputBytes: 50 } }), row(1, { metrics: { durationMs: 5, inputBytes: 50 } })]
  const report = compareMarkdown(oldRows, newRows)
  assert.match(report, /durationMs.*50\.0%/)
  assert.match(report, /inputBytes.*unavailable/)
  assert.match(report, /hostEventLoopP99Ms.*unavailable/)
  const missing = compareMarkdown(oldRows, [newRows[0], row(1, { metrics: { durationMs: null } })])
  assert.match(missing, /durationMs.*unavailable/)
  const failed = compareMarkdown(oldRows, [newRows[0], row(1, { status: 'timeout', qualityPassed: false, error: 'deadline' })])
  assert.match(failed, /durationMs.*unavailable/)
})
test('a result cannot silently mix source versions or benchmark suites', () => {
  assert.throws(() => compareMarkdown([row(0), row(1, { source: { ...row().source, treeSha256: 'd'.repeat(64) } })], [row(0), row(1)]), /Mixed source/)
  assert.throws(() => compareMarkdown([row(0)], [row(0, { suite: 'release' })]), /suites/)
  assert.throws(() => compareMarkdown([row(0)], [row(0, { source: { ...row().source, protocolSha256: 'f'.repeat(64) } })]), /protocol source/)
})
test('JSONL validation rejects duplicate runs and negative or fabricated nonfinite measurements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-bench-report-'))
  try {
    const path = join(directory, 'runs.jsonl')
    await writeFile(path, `${JSON.stringify(row())}\n${JSON.stringify(row())}\n`)
    await assert.rejects(readRows(path), /Duplicate runId/)
    await writeFile(path, `${JSON.stringify(row())}\n`)
    await assert.rejects(readRows(path), /Incomplete result inventory/)
    await writeFile(path, `${JSON.stringify(row())}\n${JSON.stringify(row(2))}\n`)
    await assert.rejects(readRows(path), /iteration inventory/)
    assert.equal(rowSchema.safeParse({ ...row(), metrics: { durationMs: -1 } }).success, false)
    assert.equal(rowSchema.safeParse({ ...row(), metrics: { durationMs: Infinity } }).success, false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
