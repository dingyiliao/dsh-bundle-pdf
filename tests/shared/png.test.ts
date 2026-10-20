import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectPng } from '../../src/shared/png.ts'

function png(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(57)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  view.setUint32(33, 0)
  bytes.set([73, 68, 65, 84], 37)
  view.setUint32(41, 0)
  view.setUint32(45, 0)
  bytes.set([73, 69, 78, 68], 49)
  view.setUint32(53, 0)
  return bytes
}

test('PNG inspection validates IHDR and image dimensions before accepting the container', () => {
  assert.throws(() => inspectPng(png().map((byte, index) => index === 15 ? 0 : byte), { maxBytes: 100 }),
    /IHDR/)
  assert.throws(() => inspectPng(png(0, 3), { maxBytes: 100 }), /dimensions/)
  assert.deepEqual(inspectPng(png(), { maxBytes: 100 }), { width: 2, height: 3 })
})
