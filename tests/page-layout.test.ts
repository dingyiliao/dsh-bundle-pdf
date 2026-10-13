import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfPageInfo } from '../src/core/pdf-types.js'
import {
  buildPageLayout, pagePixelToPdfPoint, PAGE_CHROME_HEIGHT, windowForViewport,
} from '../src/client/native/page-layout.js'

test('placeholder pixel points round-trip to PDF space at every right-angle rotation', () => {
  const page: PdfPageInfo = { page: 1, cropBox: [10, 20, 210, 420], rotation: 0, userUnit: 2 }
  const scale = 1.25
  assert.deepEqual(pagePixelToPdfPoint(page, scale, 0, 125, 300), [60, 300])
  assert.deepEqual(pagePixelToPdfPoint(page, scale, 90, 125, 300), [130, 70])
  assert.deepEqual(pagePixelToPdfPoint(page, scale, 180, 125, 300), [160, 140])
  assert.deepEqual(pagePixelToPdfPoint(page, scale, 270, 125, 300), [90, 370])
  assert.deepEqual(pagePixelToPdfPoint({ ...page, rotation: 90 }, scale, 90, 125, 300), [160, 140])
  assert.deepEqual(pagePixelToPdfPoint(page, scale, -90, 125, 300), [90, 370])
  // The middle of the stage maps to the middle of the crop box at any rotation.
  for (const angle of [0, 180]) assert.deepEqual(pagePixelToPdfPoint(page, scale, angle, 250, 500), [110, 220])
  for (const angle of [90, 270]) assert.deepEqual(pagePixelToPdfPoint(page, scale, angle, 500, 250), [110, 220])
})

test('virtual layout preserves mixed page geometry and rotation without loading pages', () => {
  const pages: PdfPageInfo[] = [
    { page: 1, cropBox: [10, 20, 210, 420], rotation: 0, userUnit: 1 },
    { page: 2, cropBox: [0, 0, 200, 400], rotation: 90, userUnit: 2 },
  ]
  const layout = buildPageLayout(pages, page => page.page === 1 ? 1.25 : 0.5, 0)
  assert.deepEqual(layout, [
    { page: 1, top: 0, width: 250, height: 500, outerHeight: 500 + PAGE_CHROME_HEIGHT, scale: 1.25 },
    { page: 2, top: 500 + PAGE_CHROME_HEIGHT, width: 400, height: 200,
      outerHeight: 200 + PAGE_CHROME_HEIGHT, scale: 0.5 },
  ])
  const rotated = buildPageLayout(pages, () => 1, 90)
  assert.deepEqual([rotated[0].width, rotated[0].height, rotated[1].width, rotated[1].height], [400, 200, 400, 800])
})

test('a 1001-page layout keeps distant viewport windows small and indexed correctly', () => {
  const pages: PdfPageInfo[] = Array.from({ length: 1001 }, (_, index) => ({
    page: index + 1, cropBox: [0, 0, 600, index % 2 === 0 ? 800 : 1151], rotation: 0, userUnit: 1,
  }))
  const layout = buildPageLayout(pages, () => 1, 0)
  const pairHeight = 800 + 1151 + 2 * PAGE_CHROME_HEIGHT
  assert.equal(layout.length, 1001)
  assert.equal(layout[1000].top, pairHeight * 500)
  assert.deepEqual(windowForViewport(layout, 0, 700), { start: 0, end: 2 })
  assert.deepEqual(windowForViewport(layout, layout[500].top, 700), { start: 499, end: 502 })
  assert.deepEqual(windowForViewport(layout, layout[1000].top, 700), { start: 999, end: 1001 })
  assert.deepEqual(windowForViewport(layout, Number.MAX_SAFE_INTEGER, 700), { start: 1000, end: 1001 })
  assert.deepEqual(windowForViewport([], 0, 700), { start: 0, end: 0 })
})
