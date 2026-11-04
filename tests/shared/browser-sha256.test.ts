import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { browserSha256 } from '../../src/shared/browser-sha256.ts'

const expected = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`

test('browser digests agree for UTF-8 text and bounded attachment views', async () => {
  const text = 'PDF 文字 📝'
  assert.equal(await browserSha256(text), expected(text))
  const bytes = new Uint8Array([9, 1, 2, 3, 8]), view = bytes.subarray(1, 4)
  assert.equal(await browserSha256(view), expected(new Uint8Array([1, 2, 3])), 'adjacent backing bytes are not evidence')
  assert.deepEqual([...bytes], [9, 1, 2, 3, 8], 'digesting does not mutate the supplied attachment')
  const shared = new Uint8Array(new SharedArrayBuffer(3))
  shared.set([1, 2, 3])
  assert.equal(await browserSha256(shared), expected(new Uint8Array([1, 2, 3])), 'shared attachment buffers use the same digest contract')
})
