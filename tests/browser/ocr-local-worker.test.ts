import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'

const browserExecutable = process.env.DSH_PDF_BROWSER_EXECUTABLE ?? chromium.executablePath()
if (process.env.DSH_PDF_REQUIRE_BROWSER_TESTS === '1' && !existsSync(browserExecutable)) {
  throw new Error(`OCR browser tests require an installed Chromium executable at ${browserExecutable}`)
}

test('built LocalOCR module starts in a browser Worker and returns a structured failure',
  { skip: !existsSync(browserExecutable) }, async () => {
    const bridge = await readFile(resolve('dist/assets/ocr/bridge.js'), 'utf8')
    const server = createServer((request, response) => {
      response.setHeader('content-type', request.url === '/bridge.js' ? 'text/javascript' : 'text/html')
      response.end(request.url === '/bridge.js' ? bridge : '<html></html>')
    })
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      browser = await chromium.launch({ executablePath: browserExecutable, headless: true })
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/`)
      const message = await page.evaluate(async () => {
        const worker = new Worker('/bridge.js', { type: 'module' })
        try {
          return await new Promise<unknown>((resolveMessage, rejectMessage) => {
            const timeout = setTimeout(() => rejectMessage(new Error('OCR Worker did not respond')), 5_000)
            worker.onmessage = event => { clearTimeout(timeout); resolveMessage(event.data) }
            worker.onerror = event => { clearTimeout(timeout); rejectMessage(new Error(event.message)) }
            // Invalid language metadata exercises the shipped bundle's error wire
            // without downloading or starting the nested Tesseract runtime.
            worker.postMessage({
              request: { image: new Uint8Array(), width: 1, height: 1, languages: null, timeoutMs: 1_000 },
              assets: { workerPath: '/ocr/worker.js', corePath: '/ocr/core', langPath: '/ocr/lang', gzip: true },
            })
          })
        } finally { worker.terminate() }
      })
      assert.deepEqual(message, { type: 'error', error: {
        code: 'recognition-failed',
        message: 'LocalOCR failed; check that its worker, core and language assets are installed.',
      } })
    } finally {
      await browser?.close()
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
    }
  })
