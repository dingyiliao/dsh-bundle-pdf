import assert from 'node:assert/strict'
import test from 'node:test'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { startExperimentalPageWarmup, type PageWarmupProgress } from '../src/client/experiment/page-warmup.js'

function textContent(pageNumber: number) {
  return { items: [{ str: `Page ${pageNumber} text`, transform: [1, 0, 0, 1, 0, 0], width: 80, height: 10, hasEOL: false }] }
}

test('background warmup indexes every page, prioritizes a distant page and reports ready', async () => {
  const requested: number[] = []
  const cleaned: number[] = []
  const progress: PageWarmupProgress[] = []
  let disposals = 0
  const handle = startExperimentalPageWarmup({
    bytes: Uint8Array.of(1), pageCount: 7, initialPage: 1, startDelayMs: 0,
    renderPreviews: false, onProgress: value => progress.push(value),
    async openPdf() {
      return {
        document: { numPages: 7, async getPage(pageNumber: number) {
          requested.push(pageNumber)
          return {
            pageNumber,
            async getTextContent() { return textContent(pageNumber) },
            cleanup() { cleaned.push(pageNumber); return true },
          } as unknown as PDFPageProxy
        } } as PDFDocumentProxy,
        async dispose() { disposals++ },
      }
    },
  })
  handle.prioritize(7)
  const ready = await handle.done
  assert.deepEqual(requested, [7, 2, 3, 4, 5, 6, 1])
  assert.deepEqual(cleaned, requested)
  assert.equal(disposals, 1)
  assert.deepEqual({ state: ready.state, total: ready.total, processed: ready.processed,
    textIndexed: ready.textIndexed, errors: ready.errors },
  { state: 'complete', total: 7, processed: 7, textIndexed: 7, errors: 0 })
  assert.equal(handle.getText(1), 'Page 1 text')
  assert.equal(handle.getText(7), 'Page 7 text')
  assert.equal(progress.at(-1)?.state, 'complete')
})

test('cancelling in-flight warmup stops new pages and disposes its document', async () => {
  const requested: number[] = []
  let releaseText!: () => void
  const textGate = new Promise<void>(resolve => { releaseText = resolve })
  let enteredText!: () => void
  const textStarted = new Promise<void>(resolve => { enteredText = resolve })
  let disposals = 0
  const handle = startExperimentalPageWarmup({
    bytes: Uint8Array.of(1), pageCount: 10, startDelayMs: 0, renderPreviews: false,
    async openPdf() {
      return {
        document: { numPages: 10, async getPage(pageNumber: number) {
          requested.push(pageNumber)
          return {
            pageNumber,
            async getTextContent() { enteredText(); await textGate; return textContent(pageNumber) },
            cleanup() { return true },
          } as unknown as PDFPageProxy
        } } as PDFDocumentProxy,
        async dispose() { disposals++ },
      }
    },
  })
  await textStarted
  handle.cancel()
  releaseText()
  const result = await handle.done
  assert.equal(result.state, 'cancelled')
  assert.deepEqual(requested, [1])
  assert.equal(result.textIndexed, 0)
  assert.equal(handle.getText(1), undefined)
  assert.equal(disposals, 1)
})

test('paused warmup waits to open the document and keeps its text cache bounded', async () => {
  const requested: number[] = []
  let opens = 0
  const handle = startExperimentalPageWarmup({
    bytes: Uint8Array.of(1), pageCount: 3, startDelayMs: 0, renderPreviews: false,
    maxTextChars: 'Page 1 text'.length,
    async openPdf() {
      opens++
      return {
        document: { numPages: 3, async getPage(pageNumber: number) {
          requested.push(pageNumber)
          return {
            pageNumber,
            async getTextContent() { return textContent(pageNumber) },
            cleanup() { return true },
          } as unknown as PDFPageProxy
        } } as PDFDocumentProxy,
        async dispose() {},
      }
    },
  })
  handle.pause()
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  assert.equal(handle.getProgress().state, 'paused')
  assert.equal(opens, 0)
  handle.prioritize(3)
  handle.resume()
  const ready = await handle.done
  assert.equal(ready.state, 'complete')
  assert.deepEqual(requested, [3, 1, 2])
  assert.equal(ready.cachedTextPages, 1)
  assert.equal(handle.getText(3), undefined)
  assert.equal(handle.getText(2), 'Page 2 text')
})
