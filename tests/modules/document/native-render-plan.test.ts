import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfPageInfo } from '../../../src/core/pdf-types.ts'
import { ocrRegionRenderPlan, pageRenderPlan } from '../../../src/modules/document/index.ts'

const page: PdfPageInfo = { page: 1, cropBox: [20, 40, 220, 440], rotation: 0, userUnit: 1 }

test('whole-page render plan fits crop dimensions and applies quarter-turn rotation', () => {
  assert.deepEqual(pageRenderPlan(page, 800), {
    rasterWidth: 400, rasterHeight: 800, x: 0, y: 0, width: 400, height: 800,
  })
  assert.deepEqual(pageRenderPlan({ ...page, rotation: 90, userUnit: 2 }, 800), {
    rasterWidth: 800, rasterHeight: 400, x: 0, y: 0, width: 800, height: 400,
  })
  assert.throws(() => pageRenderPlan(page, 255), { code: 'pdf/invalid-render-size' })
  assert.throws(() => pageRenderPlan({ ...page, userUnit: 0 }, 512), { code: 'pdf/invalid-page' })
})

test('OCR plan keeps PDF-space region and bounds the native crop', () => {
  const full = ocrRegionRenderPlan(page, undefined, 800)
  assert.deepEqual(full.pdfRegion, page.cropBox)
  assert.equal(full.width, 400)
  assert.equal(full.height, 800)

  const cropped = ocrRegionRenderPlan(page, [100, 120, 180, 240], 800)
  assert.deepEqual(cropped.pdfRegion, [100, 120, 180, 240])
  assert.ok(cropped.width > 0 && cropped.height > 0)
  assert.ok(cropped.x + cropped.width <= cropped.rasterWidth)
  assert.ok(cropped.y + cropped.height <= cropped.rasterHeight)
  assert.deepEqual(ocrRegionRenderPlan({ ...page, rotation: 90 }, [100, 120, 180, 240], 800).pdfRegion,
    [100, 120, 180, 240])
})

test('OCR plan rejects malformed, outside and unrenderable regions before native allocation', () => {
  assert.throws(() => ocrRegionRenderPlan(page, undefined, 1025), { code: 'pdf/invalid-render-size' })
  assert.throws(() => ocrRegionRenderPlan(page, [1, 2, 3], 512), { code: 'pdf/invalid-region' })
  assert.throws(() => ocrRegionRenderPlan(page, [100, 120, Number.NaN, 240], 512), { code: 'pdf/invalid-region' })
  assert.throws(() => ocrRegionRenderPlan(page, [180, 120, 100, 240], 512), { code: 'pdf/invalid-region' })
  assert.throws(() => ocrRegionRenderPlan(page, [300, 500, 400, 600], 512), { code: 'pdf/invalid-region' })
  assert.throws(() => ocrRegionRenderPlan({ ...page, userUnit: 0 }, undefined, 512), { code: 'pdf/invalid-page' })
  assert.throws(() => ocrRegionRenderPlan({ ...page, cropBox: [0, 0, 13, 3000] },
    [12.999999999999998, 0, 13, 3000], 1024), { code: 'pdf/invalid-region' })
})
