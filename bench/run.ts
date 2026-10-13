import { execFile } from 'node:child_process'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { ensureCorpus } from './corpus.ts'
import { ROOT, sourceMetadata, environmentMetadata } from './metadata.ts'
import { rowSchema, type BenchmarkRow } from './schema.ts'
import { summaryMarkdown } from './report.ts'
import { finalizeRows } from './persist.ts'

const { values } = parseArgs({ options: {
  suite: { type: 'string', default: 'smoke' }, out: { type: 'string', default: 'bench-results/host-smoke' },
  corpus: { type: 'string', default: 'bench/.generated' }, repeats: { type: 'string' }, timeout: { type: 'string', default: '60000' },
} })
if (!['smoke', 'release'].includes(values.suite!)) throw new Error('suite must be smoke or release')
const suite = values.suite as 'smoke' | 'release'
const repeats = Number(values.repeats ?? (suite === 'smoke' ? 3 : 20)), timeout = Number(values.timeout)
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(timeout) || timeout < 100) throw new Error('Invalid repeats/timeout')
const out = resolve(values.out!), directory = resolve(values.corpus!)
await mkdir(out, { recursive: true })
const output = join(out, 'runs.jsonl')
// Exclusive creation prevents accidental overwriting a previous baseline.
await writeFile(output, '', { flag: 'wx' })
const corpus = await ensureCorpus(directory), source = await sourceMetadata(), environment = environmentMetadata()
const execute = promisify(execFile), rows: BenchmarkRow[] = []
let failures = 0
for (let iteration = 0; iteration < repeats; iteration++) {
  // Alternating scenario order reduces a systematic warm-up/thermal ordering effect.
  const scenarios = ['host.inspect', 'host.project', 'host.history-replay', 'host.materialize']
  if (iteration % 2) scenarios.reverse()
  for (const document of corpus.documents) for (const scenario of scenarios) {
    let payload: object
    try {
      const result = await execute(process.execPath, ['--import', 'tsx', join(ROOT, 'bench/worker.ts'), join(directory, document.file), scenario, document.sha256, String(document.pages), String(document.annotations)],
        { cwd: ROOT, timeout, maxBuffer: 4 * 1024 * 1024 })
      payload = JSON.parse(result.stdout.trim())
    } catch (error) {
      payload = { status: (error as { killed?: boolean }).killed ? 'timeout' : 'error', qualityPassed: false,
        metrics: {}, stages: [], error: error instanceof Error ? error.message.slice(0, 200) : 'child failure' }
    }
    const row = rowSchema.parse({ schemaVersion: 1, runId: randomUUID(), iteration, suite,
      repeatCount: repeats, expectedRowCount: repeats * corpus.documents.length * 4,
      measurementKind: 'host-component', scenario, documentId: document.id, documentSha256: document.sha256,
      pageCount: document.pages, annotationCount: document.annotations, seed: corpus.seed,
      cacheState: 'fresh-process-input-bytes-ready', qualityMode: 'metadata-and-reopen-validation', environment, source, ...payload })
    rows.push(row); await appendFile(output, `${JSON.stringify(row)}\n`)
    if (row.status !== 'ok' || !row.qualityPassed) failures++
    console.log(`${scenario} ${document.id} iteration=${iteration} status=${row.status} ms=${row.metrics.durationMs?.toFixed(2) ?? 'unavailable'}`)
  }
}
await finalizeRows(output, rows)
await writeFile(join(out, 'summary.md'), summaryMarkdown(rows))
console.log(JSON.stringify({ rows: rows.length, failures, results: output, summary: join(out, 'summary.md') }))
if (failures) process.exitCode = 1
