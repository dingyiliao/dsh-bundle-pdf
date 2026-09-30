import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { ensureCorpus } from './corpus.ts'
import { ROOT, sourceMetadata, environmentMetadata, sha256 } from './metadata.ts'
import { startServer } from './server.ts'
import { rowSchema, type BenchmarkRow } from './schema.ts'
import { summaryMarkdown } from './report.ts'
import { finalizeRows } from './persist.ts'

const { values } = parseArgs({ options: { suite: { type: 'string', default: 'smoke' },
  out: { type: 'string', default: 'bench-results/reader-smoke' }, corpus: { type: 'string', default: 'bench/.generated' },
  repeats: { type: 'string' }, timeout: { type: 'string', default: '60000' }, document: { type: 'string' }, scenario: { type: 'string' },
  engine: { type: 'string', default: 'legacy' } } })
if (!['legacy', 'pdfjs', 'native'].includes(values.engine!)) throw new Error('engine must be legacy, pdfjs or native')
const engine = values.engine as 'legacy' | 'pdfjs' | 'native'
if (!['smoke', 'release'].includes(values.suite!)) throw new Error('suite must be smoke or release')
const suite = values.suite as 'smoke' | 'release', repeats = Number(values.repeats ?? (suite === 'smoke' ? 3 : 20)), timeout = Number(values.timeout)
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(timeout) || timeout < 100) throw new Error('Invalid repeats/timeout')
const out = resolve(values.out!), corpusDirectory = resolve(values.corpus!)
await mkdir(out, { recursive: true })
const output = join(out, 'runs.jsonl'); await writeFile(output, '', { flag: 'wx' })
const corpus = await ensureCorpus(corpusDirectory)
const documents = values.document ? corpus.documents.filter(document => document.id === values.document) : corpus.documents
if (!documents.length) throw new Error('Unknown document ID')
const require = createRequire(import.meta.url), pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const assets: Record<string, Record<string, string>> = {}
for (const [kind, directory] of [['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'], ['wasmUrl', 'wasm']]) {
  const files = (await readdir(join(pdfRoot, directory), { withFileTypes: true })).filter(file => file.isFile() && !file.name.startsWith('LICENSE')).sort((a, b) => a.name.localeCompare(b.name))
  assets[kind] = Object.fromEntries(await Promise.all(files.map(async file => [file.name, (await readFile(join(pdfRoot, directory, file.name))).toString('base64')])))
}
// Match the shipped Reader's embedded worker/assets rather than substituting a lighter test renderer.
const worker = await readFile(join(pdfRoot, 'build/pdf.worker.min.mjs'), 'utf8')
await mkdir(join(ROOT, 'bench/.web-build'), { recursive: true })
await build({ absWorkingDir: ROOT, entryPoints: ['bench/web-entry.tsx'], outfile: 'bench/.web-build/app.js', bundle: true,
  minify: false, sourcemap: false, platform: 'browser', format: 'iife', target: ['chrome120'], mainFields: ['browser', 'module', 'main'],
  jsx: 'automatic', loader: { '.css': 'text' }, logOverride: { 'empty-import-meta': 'silent' },
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __PDF_PLUGIN_WORKER_SOURCE__: JSON.stringify(worker), __PDF_PLUGIN_BINARY_ASSETS__: JSON.stringify(assets) } })
const bundle = await readFile(join(ROOT, 'bench/.web-build/app.js')), source = await sourceMetadata()
const browser = await chromium.launch({ headless: true, ...(process.env.PDF_BENCH_CHROMIUM ? { executablePath: process.env.PDF_BENCH_CHROMIUM } : { channel: 'chromium' }) })
const environment = { ...environmentMetadata(), chromium: browser.version(), browserChannel: 'chromium-new-headless', headless: true, viewportWidth: 1200, viewportHeight: 900, dpr: 2,
  appBundleIncludedInTiming: false, browserLaunchIncludedInTiming: false, hostAdapter: 'synthetic-memory-files-and-drafts', scrollProtocol: '8000-csspx-over-1500ms',
  readerEngine: engine, pdfiumBuild: engine === 'native' ? '156.0.8076.0' : 'unused', rpcByteScope: 'scenario-context-including-setup' }
const rows: BenchmarkRow[] = []
let failures = 0
try {
  for (let iteration = 0; iteration < repeats; iteration++) {
    const scenarios = values.scenario ? ['reader.open', 'reader.scroll', 'reader.zoom4x'].filter(scenario => scenario === values.scenario)
      : ['reader.open', 'reader.scroll', 'reader.zoom4x']
    if (!scenarios.length) throw new Error('Unknown Reader scenario')
    if (iteration % 2) scenarios.reverse()
    for (const document of documents) for (const scenario of scenarios) {
      const bytes = new Uint8Array(await readFile(join(corpusDirectory, document.file)))
      if (sha256(bytes) !== document.sha256) throw new Error('Corpus digest changed')
      const server = await startServer(bundle, bytes, document.pages, document.annotations, engine)
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
      const page = await context.newPage(); page.setDefaultTimeout(timeout)
      let payload: object = {}, timer: ReturnType<typeof setTimeout> | undefined
      const errors: string[] = []
      let nativeStats = server.diagnostics()
      let browserFailure!: (error: Error) => void
      const failed = new Promise<never>((_, reject) => { browserFailure = reject })
      void failed.catch(() => undefined)
      try {
        page.on('pageerror', error => { errors.push(error.message.slice(0, 200)); browserFailure(new Error(`Browser error: ${error.message}`)) })
        page.on('console', message => { if (message.type() === 'error') { errors.push(message.text().slice(0, 200)); browserFailure(new Error(`Browser console error: ${message.text()}`)) } })
        await page.goto(server.url, { waitUntil: 'load' }); await page.waitForFunction(() => !!(window as any).__PDF_BENCH__)
        const supported = await page.evaluate(() => typeof (Map.prototype as any).getOrInsertComputed === 'function' && typeof (Uint8Array.prototype as any).toHex === 'function')
        if (!supported) throw new Error('This PDF.js modern build requires Map.getOrInsertComputed and Uint8Array.toHex; use the pinned Chromium version')
        const result = await Promise.race([
          page.evaluate(({ scenario, timeout }) => (window as any).__PDF_BENCH__.run(scenario, timeout), { scenario, timeout }),
          failed,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Reader benchmark timeout'), { name: 'TimeoutError' })), timeout) }),
        ])
        if (errors.length) throw new Error(`Browser error: ${errors.join('; ')}`)
        payload = { ...result, status: 'ok', error: null }
        if (iteration === 0) await page.screenshot({ path: join(out, `${document.id}-${scenario.replace('.', '-')}.png`) })
        await page.evaluate(() => (window as any).__PDF_BENCH__.dispose())
      } catch (error) {
        payload = { status: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error', qualityPassed: false,
          metrics: {}, stages: [], error: error instanceof Error ? error.message.slice(0, 400) : 'unknown Reader failure' }
        try {
          const state = await page.evaluate(() => (window as any).__PDF_BENCH__?.snapshot())
          await writeFile(join(out, `${document.id}-${scenario.replace('.', '-')}-${iteration}-failure.json`), JSON.stringify({ state, errors }, null, 2))
          await page.screenshot({ path: join(out, `${document.id}-${scenario.replace('.', '-')}-${iteration}-failure.png`), timeout: 5000 })
        } catch { /* Retain the failure row even if evidence capture also fails. */ }
      } finally {
        if (timer) clearTimeout(timer)
        nativeStats = server.diagnostics()
        await context.close(); await server.close()
      }
      const row = rowSchema.parse({ schemaVersion: 1, runId: randomUUID(), iteration, suite, measurementKind: 'reader-component', scenario,
        repeatCount: repeats, expectedRowCount: repeats * documents.length * scenarios.length,
        documentId: document.id, documentSha256: document.sha256, pageCount: document.pages, annotationCount: document.annotations, seed: corpus.seed,
        cacheState: 'fresh-browser-context-host-workspace-app-bundle-ready', qualityMode: 'completed-raster-visible-area-and-sampling-with-text-ink-validation',
        environment, source, ...payload })
      Object.assign(row.metrics, { rpcRequestCount: server.traffic.requests, rpcRequestBytes: server.traffic.requestBytes, rpcResponseBytes: server.traffic.responseBytes,
        nativeTileCacheBytes: nativeStats.tileCacheBytes, nativeDocumentBytes: nativeStats.documentBytes })
      // Preserve separate Host/Client clock domains; startMs must not be subtracted across them.
      row.stages.push(...server.stages)
      rows.push(row); await appendFile(output, `${JSON.stringify(row)}\n`)
      if (row.status !== 'ok' || !row.qualityPassed) failures++
      console.log(`${scenario} ${document.id} iteration=${iteration} status=${row.status} targetMs=${row.metrics.targetQualityProxyMs?.toFixed(2) ?? 'unavailable'}${row.error ? ` error=${row.error}` : ''}`)
    }
  }
} finally { await browser.close() }
await finalizeRows(output, rows)
await writeFile(join(out, 'summary.md'), summaryMarkdown(rows))
console.log(JSON.stringify({ rows: rows.length, failures, results: output, summary: join(out, 'summary.md') }))
if (failures) process.exitCode = 1
