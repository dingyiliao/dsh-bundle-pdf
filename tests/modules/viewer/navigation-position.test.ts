import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfPageInfo } from '../../../src/core/pdf-types.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { NativeDocument, PageView } from '../../../src/modules/viewer/index.ts'
import { NativeViewport, setWindowLayout } from '../../../src/modules/viewer/index.ts'
import { captureReaderPosition, readerPageScale, resolvePdfDestination } from '../../../src/modules/viewer/index.ts'

const pages: PdfPageInfo[] = [1, 2].map(page => ({ page, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }))
const snapshot = { contentVersion: 'content-1', document: { pages } } as WorkspaceSnapshot

test('page scale uses viewport fit modes without mutating custom zoom', () => {
  const state = { fit: 'width' as const, zoom: 2, size: { width: 432, height: 450 } }
  assert.equal(readerPageScale(pages[0], state), 1)
  assert.equal(readerPageScale(pages[0], state, 'page'), (450 - 16 - 16) / 600)
  assert.equal(readerPageScale(pages[0], state, 'custom', 1.75), 1.75)
})

test('capture chooses distant numeric layout while its PageView is still unmounted', () => {
  const root = { scrollTop: 700, scrollLeft: 0, scrollWidth: 400, clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }),
  } as unknown as HTMLDivElement
  setWindowLayout(root, [
    { page: 1, top: 16, width: 400, height: 600, outerHeight: 616, scale: 1 },
    { page: 2, top: 632, width: 400, height: 600, outerHeight: 616, scale: 1 },
  ])
  const captured = captureReaderPosition({ snapshot, scrollRoot: root, fit: 'width', zoom: 1,
    size: { width: 432, height: 700 }, currentPage: 1 }, new Map(), 'not ready')
  assert.equal(captured.page, 2)
  assert.equal(captured.documentVersion, 'content-1')
  assert.equal(captured.x, 0)
  assert.ok(captured.y < 600 && captured.y > 400)
})

test('history captures the explicitly current visible page when the last-page jump is scroll-clamped', () => {
  const bounds = (top: number, height: number) => ({ left: 0, top, right: 400,
    bottom: top + height, width: 400, height } as DOMRect)
  const root = { scrollTop: 348, scrollLeft: 0, scrollWidth: 400, clientHeight: 900,
    getBoundingClientRect: () => bounds(0, 900),
  } as unknown as HTMLDivElement
  const numeric = [
    { page: 1, top: 16, width: 400, height: 600, outerHeight: 616, scale: 1 },
    { page: 2, top: 632, width: 400, height: 600, outerHeight: 616, scale: 1 },
  ]
  setWindowLayout(root, numeric)
  const loaded = new Map<number, PageView>(numeric.map(item => [item.page, {
    element: { getBoundingClientRect: () => bounds(item.top - root.scrollTop, item.height) } as HTMLElement,
    viewport: new NativeViewport(pages[item.page - 1], 1, 0),
  } as PageView]))
  const state = { snapshot, scrollRoot: root, fit: 'width' as const, zoom: 1,
    size: { width: 432, height: 900 }, currentPage: 2 }
  for (const views of [loaded, new Map<number, PageView>()]) {
    const position = captureReaderPosition(state, views, 'not ready')
    assert.equal(position.page, 2)
    assert.equal(position.y, 600)
    assert.equal(position.viewportAnchor?.y, 284 / 900,
      'restoring this point must retain the same clamped scroll position and selected page')
  }
})

test('PDF destinations remain one-based and reject invalid targets before navigation', async () => {
  const document = { async getDestination(name: string) {
    return name === 'chapter' ? [0, { name: 'XYZ' }, 10, 20, 2] : [5, { name: 'Fit' }]
  }, async getPageIndex() { return 1 }, async getPage() { return {
    getViewport() { return { height: 600,
      convertToViewportPoint: (x: number, y: number) => [x, 600 - y],
      convertToPdfPoint: (x: number, y: number) => [x, 600 - y] } },
  } } } as unknown as NativeDocument
  const size = { width: 500, height: 700 }
  assert.deepEqual(await resolvePdfDestination(document, snapshot, size, 'chapter', 'invalid'),
    { page: 1, options: { x: 10, y: 20, scale: 2, fit: 'custom' } })
  assert.deepEqual(await resolvePdfDestination(document, snapshot, size, [1, { name: 'FitH' }, 250], 'invalid'),
    { page: 2, options: { fit: 'width', y: 250 } })
  assert.deepEqual(await resolvePdfDestination(document, snapshot, size, [1, { name: 'FitV' }, 10], 'invalid'),
    { page: 2, options: { fit: 'custom', scale: (700 - 16 - 16) / 600, x: 10 } })
  assert.deepEqual(await resolvePdfDestination(document, snapshot, size, [1, { name: 'FitR' }, 0, 0, 400, 600], 'invalid'),
    { page: 2, options: { fit: 'custom', scale: (700 - 16 - 16) / 600, x: 0, y: 600 } })
  await assert.rejects(resolvePdfDestination(document, snapshot, size, 'missing', 'invalid'), /invalid/)
})
