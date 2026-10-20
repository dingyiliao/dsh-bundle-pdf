import assert from 'node:assert/strict'
import test from 'node:test'
import { capturePdfRegion } from '../../../src/modules/viewer/rendering/reader-screenshot.ts'
import type { ReaderDocument, ReaderPage, ReaderRenderOptions, ReaderRenderTask } from '../../../src/modules/viewer/ports/reader-document.ts'
import type { NativeViewport } from '../../../src/modules/viewer/index.ts'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'

function fakePage(render: (options: ReaderRenderOptions) => ReaderRenderTask, view = [0, 0, 100, 100]): ReaderPage {
  return {
    pageNumber: 1, rotate: 0, userUnit: 1, view,
    getViewport: ({ scale }) => ({
      convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
      width: (view[2] - view[0]) * scale,
      height: (view[3] - view[1]) * scale,
    }) as unknown as NativeViewport,
    render,
  } as ReaderPage
}

function fakeDocument(page: ReaderPage, getPage = async () => page): ReaderDocument {
  return { numPages: 1, getPage } as unknown as ReaderDocument
}

async function withCanvas<T>(encode: (callback: BlobCallback) => void, run: (canvases: HTMLCanvasElement[]) => Promise<T>,
  context?: CanvasRenderingContext2D): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const canvases: HTMLCanvasElement[] = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: (tag: string) => {
      assert.equal(tag, 'canvas')
      const canvas = { width: 0, height: 0, toBlob: encode, getContext: () => context } as unknown as HTMLCanvasElement
      canvases.push(canvas)
      return canvas
    },
  } })
  try { return await run(canvases) } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  }
}

test('region screenshots reject invalid pages, coordinates, rotation, scale and off-page regions', async () => {
  const page = fakePage(() => ({ promise: Promise.resolve(), cancel() {} }))
  const pdf = fakeDocument(page)
  await assert.rejects(capturePdfRegion(pdf, 0, [0, 0, 1, 1]), /outside the PDF/)
  await assert.rejects(capturePdfRegion(pdf, 2, [0, 0, 1, 1]), /outside the PDF/)
  await assert.rejects(capturePdfRegion(pdf, 1, [0, 0, Number.NaN, 1]), /four finite coordinates/)
  await assert.rejects(capturePdfRegion(pdf, 1, [0, 0, 1] as unknown as [number, number, number, number]), /four finite coordinates/)
  await assert.rejects(capturePdfRegion(pdf, 1, [0, 0, 1, 1], { rotation: 45 }), /multiple of 90/)
  await assert.rejects(capturePdfRegion(pdf, 1, [0, 0, 1, 1], { scale: 0 }), /positive and finite/)
  await assert.rejects(capturePdfRegion(pdf, 1, [120, 120, 130, 130]), /does not intersect/)
})

test('region screenshot clips reversed PDF coordinates, caps scale and releases the canvas', async () => {
  const calls: ReaderRenderOptions[] = []
  const page = fakePage(options => { calls.push(options); return { promise: Promise.resolve(), cancel() {} } })
  const png = new Blob(['png'], { type: 'image/png' })
  await withCanvas(callback => callback(png), async canvases => {
    const result = await capturePdfRegion(fakeDocument(page), 1, [120, 120, 90, 90], { rotation: -90, scale: 100 })
    assert.equal(result.blob, png)
    assert.deepEqual([result.width, result.height], [20, 20])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].annotations, true)
    assert.deepEqual(calls[0].transform, [1, 0, 0, 1, -180, -180])
    assert.deepEqual([canvases[0].width, canvases[0].height], [0, 0])
  })
})

test('screenshot cancellation does not dispose the shared PDF document', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled by reader')
  const page = fakePage(() => ({ promise: Promise.resolve(), cancel() {} }))
  const pending = capturePdfRegion(fakeDocument(page, () => new Promise<ReaderPage>(() => {})), 1, [0, 0, 10, 10], { signal: controller.signal })
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)

  let rejectRender!: (reason: Error) => void
  let cancelled = 0
  const renderPage = fakePage(() => ({
    promise: new Promise<void>((_, reject) => { rejectRender = reject }),
    cancel() { cancelled++; rejectRender(new Error('native render cancelled')) },
  }))
  await withCanvas(() => {}, async canvases => {
    const nextController = new AbortController()
    const screenshot = capturePdfRegion(fakeDocument(renderPage), 1, [0, 0, 10, 10], { signal: nextController.signal })
    await new Promise(resolve => setImmediate(resolve))
    nextController.abort(reason)
    await assert.rejects(screenshot, error => error === reason)
    assert.equal(cancelled, 1)
    assert.deepEqual([canvases[0].width, canvases[0].height], [0, 0])
  })
})

test('screenshot forwards page-load failures and rejects a non-finite viewport', async () => {
  const signal = new AbortController().signal
  const failed = fakeDocument(fakePage(() => ({ promise: Promise.resolve(), cancel() {} })),
    async () => { throw new Error('PDF page loading failed') })
  await assert.rejects(capturePdfRegion(failed, 1, [0, 0, 10, 10], { signal }), /page loading failed/)

  const page = fakePage(() => ({ promise: Promise.resolve(), cancel() {} }))
  page.getViewport = () => ({
    convertToViewportPoint: () => [Number.NaN, Number.NaN],
  }) as unknown as NativeViewport
  await assert.rejects(capturePdfRegion(fakeDocument(page), 1, [0, 0, 10, 10]), /invalid dimensions/)
})

test('PNG encoding failure is surfaced and still frees the canvas', async () => {
  const page = fakePage(() => ({ promise: Promise.resolve(), cancel() {} }))
  await withCanvas(callback => callback(null), async canvases => {
    await assert.rejects(capturePdfRegion(fakeDocument(page), 1, [0, 0, 5, 5]), /could not be encoded/)
    assert.deepEqual([canvases[0].width, canvases[0].height], [0, 0])
  })
})

test('huge region screenshot respects both canvas dimension and total pixel limits', async () => {
  const page = fakePage(() => ({ promise: Promise.resolve(), cancel() {} }), [0, 0, 50_000, 50_000])
  const png = new Blob(['png'], { type: 'image/png' })
  await withCanvas(callback => callback(png), async () => {
    const { width, height } = await capturePdfRegion(fakeDocument(page), 1, [0, 0, 50_000, 50_000])
    assert.ok(width <= 32_767 && height <= 32_767)
    assert.ok(width * height <= 16_000_000)
    assert.ok(width > 0 && height > 0)
  })
})

test('region screenshot repairs removed native markup and composes adjacent marks and notes', async () => {
  const draws: unknown[][] = []
  const operations: string[] = []
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, key) => (...args: unknown[]) => {
      operations.push(String(key))
      if (key === 'drawImage') draws.push(args)
    },
    set: () => true,
  })
  const annotation = (id: string, subtype: string, rect: [number, number, number, number]): PdfAnnotation =>
    ({ id, page: 1, subtype, rect, flags: 0, supported: true, editable: true })
  const removed = annotation('removed', 'Highlight', [10, 10, 20, 20])
  const retained = annotation('retained', 'Highlight', [15, 15, 19, 19])
  const existingNote = annotation('existing-note', 'Text', [16, 16, 20, 20])
  const newMark = annotation('new-mark', 'Underline', [30, 30, 35, 35])
  const newNote = annotation('new-note', 'Text', [40, 40, 45, 45])
  const sourceAnnotations = [removed, retained, existingNote]
  const annotations = [retained, existingNote, newMark, newNote]
  const calls: ReaderRenderOptions[] = []
  let cancelCount = 0
  const page = fakePage(options => {
    calls.push(options)
    return { promise: Promise.resolve(), cancel: () => { cancelCount++ } }
  })
  const png = new Blob(['png'], { type: 'image/png' })
  await withCanvas(callback => callback(png), async canvases => {
    const result = await capturePdfRegion(fakeDocument(page), 1, [0, 0, 50, 50], { annotations, sourceAnnotations })
    assert.equal(result.blob, png)
    assert.deepEqual(calls.map(call => call.annotations), [true, false])
    assert.equal(draws.length, 1)
    assert.ok(operations.includes('fill'))
    assert.ok(operations.includes('stroke'))
    assert.ok(operations.includes('fillText'))
    assert.equal(cancelCount, 1)
    assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[0, 0], [0, 0]])
  }, context)
})
