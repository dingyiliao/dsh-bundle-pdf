import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeViewport } from '../src/client/native/viewport.ts'
import { loadPdfDocument } from '../src/core/pdf-document.ts'
import { nativeFixture } from './native-fixture.ts'

test('native UI viewports apply crop, UserUnit, rotation, offsets and dontFlip', async () => {
  const bytes = await nativeFixture(), info = await loadPdfDocument(bytes)
  const transforms: Record<number, number[]> = {
    0: [1, 0, 0, -1, -30, 360],
    90: [0, 1, 1, 0, -40, -30],
    180: [-1, 0, 0, 1, 280, -40],
    270: [0, -1, -1, 0, 360, 280],
  }
  const unflipped: Record<number, number[]> = {
    0: [1, 0, 0, 1, -30, -40],
    90: [0, 1, -1, 0, 360, -30],
    180: [-1, 0, 0, -1, 280, 360],
    270: [0, -1, 1, 0, -40, 280],
  }
  for (const geometry of info.pages) {
    assert.deepEqual(geometry.cropBox, [30, 40, 280, 360])
    for (const rotation of [0, 90, 180, 270]) for (const dontFlip of [false, true]) {
      const scale = 1.25, offsetX = 17, offsetY = -9, factor = scale * geometry.userUnit
      const viewport = new NativeViewport(geometry, scale, rotation, offsetX, offsetY, dontFlip)
      const expected = (dontFlip ? unflipped : transforms)[rotation].map((value, index) => value * factor + (index === 4 ? offsetX : index === 5 ? offsetY : 0))
      assert.equal(viewport.transform.length, expected.length)
      for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(viewport.transform[index] - expected[index]) < 1e-9)
      assert.equal(viewport.width, (rotation % 180 ? 320 : 250) * factor)
      assert.equal(viewport.height, (rotation % 180 ? 250 : 320) * factor)
      for (const [x, y] of [[40, 50], [210, 270]]) {
        const point: [number, number] = [expected[0] * x + expected[2] * y + expected[4], expected[1] * x + expected[3] * y + expected[5]]
        assert.deepEqual(viewport.convertToViewportPoint(x, y), point)
        const roundTrip = viewport.convertToPdfPoint(...point)
        assert.ok(Math.abs(roundTrip[0] - x) < 1e-9 && Math.abs(roundTrip[1] - y) < 1e-9)
      }
    }
  }
})
