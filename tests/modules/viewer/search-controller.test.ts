import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfPageInfo } from '../../../src/core/pdf-types.ts'
import type { NativeDocument } from '../../../src/modules/viewer/index.ts'
import type { OcrPage } from '../../../src/modules/viewer/controllers/reader-lifetime.ts'
import { ReaderSearchController, type ReaderSearchHit } from '../../../src/modules/viewer/index.ts'

const pages: PdfPageInfo[] = [1, 2].map(page => ({ page, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }))

function documentWithText(text: readonly string[], onRead?: (page: number) => void): NativeDocument {
  return { numPages: text.length,
    async getPage(number: number) {
      onRead?.(number)
      return { async getTextContent() { return { items: [{ str: text[number - 1], transform: [1, 0, 0, 1, 18, 42],
        width: 80, height: 12, hasEOL: false }] } } }
    },
  } as unknown as NativeDocument
}

test('search controller keeps UI semantics: case-insensitive native hits and page-only OCR', async () => {
  const controller = new ReaderSearchController()
  const progress: ReaderSearchHit[][] = []
  const completions: ReaderSearchHit[][] = []
  let settled = 0
  const ocrPages = new Map<number, OcrPage>([[2, { text: 'ELepHant diagram', words: [], engine: 'test', warnings: [] }]])
  await controller.run({ document: documentWithText(['An elephant walks', 'no native hit']), pages,
    ocrPages, query: 'Elephant', signal: new AbortController().signal,
    onProgress: hits => progress.push(hits), onComplete: hits => completions.push(hits),
    onError: error => { throw error }, onSettled: () => { settled++ } })
  assert.equal(settled, 1)
  assert.equal(completions.length, 1)
  assert.deepEqual(completions[0].map(hit => [hit.page, hit.source]), [[1, 'native'], [2, 'ocr']])
  assert.equal(completions[0][0].x, 18)
  assert.equal(completions[0][0].y, 42)
  assert.equal(completions[0][1].x, undefined, 'OCR transcripts must not fabricate word coordinates')
  assert.ok(progress.length <= 1, 'a small search should not flood incremental updates')
})

test('search controller reuses same-document text summaries and invalidates them on document switch', async () => {
  const controller = new ReaderSearchController()
  let reads = 0
  const first = documentWithText(['alpha', 'beta'], () => { reads++ })
  const second = documentWithText(['alpha', 'beta'], () => { reads++ })
  const request = (document: NativeDocument) => ({ document, pages, ocrPages: new Map<number, OcrPage>(), query: 'missing',
    signal: new AbortController().signal, onProgress() {}, onComplete() {}, onError(error: unknown) { throw error }, onSettled() {} })
  await controller.run(request(first))
  assert.equal(reads, 2)
  await controller.run(request(first))
  assert.equal(reads, 2, 'known misses should not reread the same document')
  await controller.run(request(second))
  assert.equal(reads, 4, 'a new native document has a separate text index')
})

test('a cancelled search never publishes late hits or clears a newer task', async () => {
  const controller = new ReaderSearchController()
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const document = { numPages: 1, async getPage() {
    return { async getTextContent() { await gate; return { items: [{ str: 'target', transform: [1, 0, 0, 1, 0, 0],
      width: 60, height: 10, hasEOL: false }] } } }
  } } as unknown as NativeDocument
  const events: string[] = []
  const pending = controller.run({ document, pages: pages.slice(0, 1), ocrPages: new Map(), query: 'target',
    signal: new AbortController().signal, onProgress: () => events.push('progress'),
    onComplete: () => events.push('complete'), onError: () => events.push('error'),
    onSettled: () => events.push('settled') })
  await Promise.resolve()
  controller.cancel()
  release!()
  await pending
  assert.deepEqual(events, [])
})

test('a native page-read failure is reported once and still settles the search', async () => {
  const controller = new ReaderSearchController()
  const failure = new Error('native text extraction failed')
  const document = { numPages: 1, async getPage() { throw failure } } as unknown as NativeDocument
  const errors: unknown[] = []
  const events: string[] = []
  await controller.run({ document, pages: pages.slice(0, 1), ocrPages: new Map(), query: 'target',
    signal: new AbortController().signal, onProgress: () => events.push('progress'),
    onComplete: () => events.push('complete'), onError: error => { errors.push(error) },
    onSettled: () => events.push('settled') })
  assert.deepEqual(errors, [failure])
  assert.deepEqual(events, ['settled'])
})
