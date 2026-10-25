import assert from 'node:assert/strict'
import test from 'node:test'
import { retainPdfDocument } from '../../../../src/adapters/host/dsh/transport.ts'

const agent = { session: { id: 'session', header: {} } }

test('document RPC retains through asynchronous dispatch and always releases on success, failure or cancellation', async () => {
  let pins = 0
  const acquire = async (session: string, id: string, caller: typeof agent, signal: AbortSignal) => {
    assert.equal(session, 'session'); assert.equal(id, 'document'); assert.equal(caller, agent)
    signal.throwIfAborted(); pins++
    return () => { pins-- }
  }
  const abort = new AbortController()
  const dispatch = retainPdfDocument(async (_session, input, _agent, signal) => {
    assert.equal(pins, 1)
    await Promise.resolve()
    if (input.cancel) abort.abort(new Error('cancelled RPC'))
    signal.throwIfAborted()
    if (input.fail) throw new Error('operation failed')
    return { ok: true }
  }, acquire)
  assert.deepEqual(await dispatch('session', { documentId: 'document' }, agent, abort.signal), { ok: true })
  assert.equal(pins, 0)
  await assert.rejects(dispatch('session', { id: 'document', fail: true }, agent, abort.signal), /operation failed/)
  assert.equal(pins, 0)
  await assert.rejects(dispatch('session', { id: 'document', cancel: true }, agent, abort.signal), /cancelled RPC/)
  assert.equal(pins, 0)
})

test('view release and unbound requests do not acquire a document they are closing', async () => {
  const dispatch = retainPdfDocument(async () => 'handled', async () => { throw new Error('must not acquire') })
  for (const input of [{ action: 'release', id: 'document' }, { action: 'open' }, { documentId: 1 }, { id: '' }]) {
    assert.equal(await dispatch('session', input, agent, new AbortController().signal), 'handled')
  }
})
