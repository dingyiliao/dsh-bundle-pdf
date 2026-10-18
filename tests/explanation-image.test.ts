import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeExplanationImage, MAX_EXPLANATION_IMAGE_BYTES } from '../src/client/explanation-image.ts'

test('explanation image encodes PNG bytes without changing the payload', async () => {
  const bytes = Uint8Array.from({ length: 16_385 }, (_, index) => index & 0xff)
  const encoded = await encodeExplanationImage(new Blob([bytes], { type: 'image/png' }))
  assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(bytes))
})

test('explanation image rejects unsupported, empty and oversized blobs', async () => {
  await assert.rejects(encodeExplanationImage(new Blob(['x'], { type: 'image/jpeg' })), TypeError)
  await assert.rejects(encodeExplanationImage(new Blob([], { type: 'image/png' })), RangeError)
  await assert.rejects(encodeExplanationImage(new Blob([new Uint8Array(MAX_EXPLANATION_IMAGE_BYTES + 1)], {
    type: 'image/png',
  })), RangeError)
})

test('explanation image rejects cancellation before or during the byte read', async () => {
  const before = new AbortController()
  before.abort()
  await assert.rejects(encodeExplanationImage(new Blob(['x'], { type: 'image/png' }), before.signal), {
    name: 'AbortError',
  })

  const during = new AbortController()
  const blob = new Blob(['x'], { type: 'image/png' })
  blob.arrayBuffer = async () => {
    during.abort()
    return Uint8Array.of(1).buffer
  }
  await assert.rejects(encodeExplanationImage(blob, during.signal), { name: 'AbortError' })
})
