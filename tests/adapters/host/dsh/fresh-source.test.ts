import assert from 'node:assert/strict'
import test from 'node:test'
import { freshSourceReader } from '../../../../src/adapters/host/dsh/fresh-source.ts'

test('fresh source reader rejects a request whose Session no longer matches its authorized agent', async () => {
  let reads = 0
  const reader = freshSourceReader({ async read() { reads++; return { path: '/paper.pdf', version: 'v1' } } } as never,
    { session: { id: 'session-a' } } as never)
  await assert.rejects(reader('session-b', { path: '/paper.pdf' } as never, new AbortController().signal),
    { code: 'pdf/session-mismatch' })
  assert.equal(reads, 0)
  assert.deepEqual(await reader('session-a', { path: '/paper.pdf' } as never, new AbortController().signal),
    { path: '/paper.pdf', digest: 'v1' })
})
