import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const calls: unknown[] = []
let executablePath = process.execPath
const browser = { async newPage() { throw new Error('This policy test does not create pages') }, async close() {} }
const chromium = {
  executablePath: () => executablePath,
  async launch(options?: unknown) { calls.push(options); return { ...browser } },
}
const fixtureKey = '__pdfBrowserLaunchPolicy'
Object.defineProperty(globalThis, fixtureKey, { value: chromium, configurable: true })
const helperUrl = new URL('./browser/launch.ts', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'playwright' && context.parentURL === helperUrl) {
    return { url: `data:text/javascript,export const chromium = globalThis.${fixtureKey}`, shortCircuit: true }
  }
  return next(specifier, context)
} })
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, fixtureKey) })
const { launchPdfBrowser } = await import('./browser/launch.ts')

async function withEnvironment(run: () => Promise<void>) {
  const names = ['DSH_PDF_BROWSER_EXECUTABLE', 'PDF_BENCH_CHROMIUM', 'DSH_PDF_BROWSER_COVERAGE_DIR'] as const
  const previous = new Map(names.map(name => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  calls.length = 0
  try { await run() } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('ordinary and coverage browser launches share the installed headless default and system fallback', async () => {
  await withEnvironment(async () => {
    for (const installed of [true, false]) {
      calls.length = 0
      executablePath = installed ? process.execPath : join(tmpdir(), `missing-pdf-browser-${randomUUID()}`)
      delete process.env.DSH_PDF_BROWSER_COVERAGE_DIR
      await (await launchPdfBrowser()).close()
      process.env.DSH_PDF_BROWSER_COVERAGE_DIR = join(tmpdir(), 'pdf-unused-policy-artifacts')
      await (await launchPdfBrowser()).close()
      assert.deepEqual(calls, installed ? [undefined, undefined] : [{ channel: 'chrome' }, { channel: 'chrome' }])
    }
  })
})

test('the explicit shared browser override wins in ordinary and coverage launches', async () => {
  await withEnvironment(async () => {
    process.env.DSH_PDF_BROWSER_EXECUTABLE = '/configured/shared-browser'
    process.env.PDF_BENCH_CHROMIUM = '/configured/benchmark-browser'
    await (await launchPdfBrowser()).close()
    process.env.DSH_PDF_BROWSER_COVERAGE_DIR = join(tmpdir(), 'pdf-unused-policy-artifacts')
    await (await launchPdfBrowser()).close()
    assert.deepEqual(calls, [{ executablePath: '/configured/shared-browser' }, { executablePath: '/configured/shared-browser' }])
  })
})

test('the benchmark browser override remains supported when no shared override is configured', async () => {
  await withEnvironment(async () => {
    process.env.PDF_BENCH_CHROMIUM = '/configured/benchmark-browser'
    await (await launchPdfBrowser()).close()
    process.env.DSH_PDF_BROWSER_COVERAGE_DIR = join(tmpdir(), 'pdf-unused-policy-artifacts')
    await (await launchPdfBrowser()).close()
    assert.deepEqual(calls, [{ executablePath: '/configured/benchmark-browser' }, { executablePath: '/configured/benchmark-browser' }])
  })
})
