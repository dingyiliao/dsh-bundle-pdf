import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { decodePdfBaseline, digestPdfBytes, encodePdfBaseline } from '../../../src/modules/document/index.ts'

test('V1 baseline codec retains the exact byte view and verifies source identity', () => {
  const backing = Uint8Array.from([255, 11, 22, 33, 44])
  const bytes = backing.subarray(1, 4)
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  assert.equal(digestPdfBytes(bytes), digest)
  assert.equal(encodePdfBaseline(bytes), Buffer.from([11, 22, 33]).toString('base64'))
  assert.deepEqual([...decodePdfBaseline(encodePdfBaseline(bytes), digest)], [...bytes])
  assert.throws(() => decodePdfBaseline(encodePdfBaseline(bytes), digestPdfBytes(backing)),
    { code: 'pdf/draft-damaged' })
  assert.throws(() => decodePdfBaseline('C', digest), { code: 'pdf/draft-damaged' })
})
