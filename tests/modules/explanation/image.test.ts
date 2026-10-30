import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeExplanationImageBytes, MAX_EXPLANATION_REGION_IMAGE_BYTES } from '../../../src/modules/explanation/index.ts'

test('explanation image encodes verified PNG bytes without changing the payload', () => {
  const bytes = Uint8Array.from({ length: 16_385 }, (_, index) => index & 0xff)
  const encoded = encodeExplanationImageBytes(bytes)
  assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(bytes))
})

test('Host-verified image bytes are size-checked before Base64 encoding', () => {
  assert.throws(() => encodeExplanationImageBytes(new Uint8Array()), RangeError)
  assert.throws(() => encodeExplanationImageBytes(new Uint8Array(MAX_EXPLANATION_REGION_IMAGE_BYTES + 1)), RangeError)
  assert.equal(encodeExplanationImageBytes(Uint8Array.of(1, 2, 3)), 'AQID')
})

test('explanation image rejects cancellation before encoding', () => {
  const before = new AbortController()
  before.abort()
  assert.throws(() => encodeExplanationImageBytes(Uint8Array.of(1), before.signal), {
    name: 'AbortError',
  })

})
