import assert from 'node:assert/strict'
import test from 'node:test'
import { invalidDocumentIdentity } from '../../../src/modules/retrieval/identity.ts'
import type { RetrievalEmbedding } from '../../../src/modules/retrieval/types.ts'

const provider = (documentFingerprint?: unknown): RetrievalEmbedding => ({
  fingerprint: 'engine', dimensions: 8, maxBatchSize: 8, embed: async () => [],
  ...(documentFingerprint === undefined ? {} : { documentFingerprint }),
}) as RetrievalEmbedding

test('document identity rejects only malformed explicit fingerprints', () => {
  assert.equal(invalidDocumentIdentity(provider()), false)
  assert.equal(invalidDocumentIdentity(provider('model-v1')), false)
  assert.equal(invalidDocumentIdentity(provider('')), true)
  assert.equal(invalidDocumentIdentity(provider(42)), true)
  assert.equal(invalidDocumentIdentity(provider('x'.repeat(513))), true)
})
