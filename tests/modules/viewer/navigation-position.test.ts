import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfPageInfo } from '../../../src/core/pdf-types.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { NativeDocument } from '../../../src/modules/viewer/index.ts'
import { setWindowLayout } from '../../../src/modules/viewer/index.ts'
import { captureReaderPosition, readerPageScale, resolvePdfDestination } from '../../../src/modules/viewer/index.ts'

const pages: PdfPageInfo[] = [1, 2].map(page => ({ page, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }))
const snapshot = { contentVersion: 'content-1', document: { pages } } as WorkspaceSnapshot

test('page scale uses viewport fit modes without mutating custom zoom', () => {
  const state = { fit: 'width' as const, zoom: 2, size: { width: 432, height: 450 } }
  assert.equal(readerPageScale(pages[0], state), 1)
  assert.equal(readerPageScale(pages[0], state, 'page'), Math.max(0.1, (450 - 72 - 16) / 600))
  assert.equal(readerPageScale(pages[0], state, 'custom', 1.75), 1.75)
})

test('capture chooses distant numeric layout while its PageView is still unmounted', () => {
  const root = { scrollTop: 700, scrollLeft: 0, scrollWidth: 400, clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }),
  } as unknown as HTMLDivElement
  setWindowLayout(root, [
    { page: 1, top: 72, width: 400, height: 600, outerHeight: 616, scale: 1 },
    { page: 2, top: 688, width: 400, height: 600, outerHeight: 616, scale: 1 },
  ])
  const captured = captureReaderPosition({ snapshot, scrollRoot: root, fit: 'width', zoom: 1,
    size: { width: 432, height: 700 }, currentPage: 1 }, new Map(), 'not ready')
  assert.equal(captured.page, 2)
  assert.equal(captured.documentVersion, 'content-1')
  assert.equal(captured.x, 0)
  assert.ok(captured.y < 600 && captured.y > 400)
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
  await assert.rejects(resolvePdfDestination(document, snapshot, size, 'missing', 'invalid'), /invalid/)
})
