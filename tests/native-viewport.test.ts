import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeViewport } from '../src/client/native/viewport.ts'
import { loadPdfDocument } from '../src/core/pdf-document.ts'
import { nativeFixture } from './native-fixture.ts'

test('native UI viewports match PDF.js for crop, UserUnit, rotation, offsets and dontFlip', async () => {
  const bytes = await nativeFixture(), info = await loadPdfDocument(bytes)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false })
  try {
    const reference = await task.promise
    for (const geometry of info.pages) {
      const page = await reference.getPage(geometry.page)
      for (const rotation of [0, 90, 180, 270]) for (const dontFlip of [false, true]) {
        const options = { scale: 1.25, rotation, offsetX: 17, offsetY: -9, dontFlip }
        const native = new NativeViewport(geometry, options.scale, rotation, options.offsetX, options.offsetY, dontFlip)
        const viewport = page.getViewport(options)
        assert.deepEqual(native.transform, viewport.transform)
        assert.equal(native.width, viewport.width); assert.equal(native.height, viewport.height)
        for (const point of [[40, 50], [210, 270]]) assert.deepEqual(native.convertToViewportPoint(...point as [number, number]), viewport.convertToViewportPoint(...point as [number, number]))
      }
    }
  } finally { await task.destroy() }
})
