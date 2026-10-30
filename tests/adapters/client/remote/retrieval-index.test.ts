import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalIndexApi } from '../../../../src/adapters/client/remote/retrieval-index.ts'
import { retrievalRebuildRequestSchema } from '../../../../src/contracts/retrieval-index.ts'

test('index rebuild uses a connection-owned empty request without a document or Session', async () => {
  const requests: unknown[][] = []
  const api = createRetrievalIndexApi({ rpc: { async call(...input) {
    requests.push(input)
    return { ok: true, value: { status: 'invalidated' } }
  } } }, new AbortController().signal)
  await api.rebuild(new AbortController().signal)
  assert.deepEqual(requests[0]!.slice(0, 3), ['/api', 'pdf.retrieval.rebuild', {}])
  assert.ok(requests[0]![3] instanceof AbortSignal)
  assert.deepEqual(retrievalRebuildRequestSchema.parse({}), {})
  assert.equal(retrievalRebuildRequestSchema.safeParse({ documentId: 'another-file' }).success, false)
})

test('index rebuild reports Host failure and rejects malformed success responses', async () => {
  const api = (value: unknown) => createRetrievalIndexApi({ rpc: { async call() { return value } } }, new AbortController().signal)
  await assert.rejects(api({ ok: false, error: { code: 'pdf/index-unavailable', message: 'Try again' } })
    .rebuild(new AbortController().signal), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Try again')
      assert.equal((error as Error & { code?: string }).code, 'pdf/index-unavailable')
      return true
    })
  for (const value of [{ ok: true, value: { status: 'rebuilt' } }, { ok: true, value: { status: 'invalidated', path: '/unexpected' } }, {}]) {
    await assert.rejects(api(value).rebuild(new AbortController().signal))
  }
})

test('index rebuild respects caller and connection cancellation, including late non-cooperative responses', async () => {
  for (const owner of ['caller', 'connection'] as const) {
    const caller = new AbortController(), lifetime = new AbortController()
    const selected = owner === 'caller' ? caller : lifetime
    let requests = 0, active!: AbortSignal, finish!: (value: unknown) => void
    const result = new Promise<unknown>(resolve => { finish = resolve })
    const api = createRetrievalIndexApi({ rpc: { async call(_path, _method, _payload, signal) {
      requests++; active = signal!; return result
    } } }, lifetime.signal)
    const task = api.rebuild(caller.signal)
    selected.abort(new Error(`${owner} ended`))
    assert.equal(active.aborted, true)
    finish({ ok: true, value: { status: 'invalidated' } })
    await assert.rejects(task, new RegExp(`${owner} ended`))
    await assert.rejects(api.rebuild(caller.signal), new RegExp(`${owner} ended`))
    assert.equal(requests, 1)
  }
})
