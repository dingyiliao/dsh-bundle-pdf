import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelOptionsStore } from '../../../../src/adapters/client/remote/model-options.ts'

const catalog = { groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'vision', name: 'Vision',
  reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }], failures: [] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

test('model options are lazy and share concurrent reads without selecting any conversation model', async () => {
  const pending = deferred<unknown>(), calls: unknown[] = []
  const lifetime = new AbortController()
  const store = createModelOptionsStore({ rpc: { async call(...args) { calls.push(args); return pending.promise } } }, lifetime.signal)
  const seen: string[] = [], stop = store.subscribe(() => { seen.push(store.getSnapshot().status) })
  try {
    assert.equal(calls.length, 0, 'follow-session settings do not fetch model options')
    assert.equal(store.getSnapshot().status, 'idle')
    const first = store.load(), second = store.refresh()
    await Promise.resolve()
    assert.equal(calls.length, 1)
    const call = calls[0] as unknown[]
    assert.deepEqual(call.slice(0, 3), ['/api', 'pdf.model-options', {}])
    assert.ok(call[3] instanceof AbortSignal)
    pending.resolve({ ok: true, value: catalog })
    await Promise.all([first, second])
    assert.deepEqual(store.getSnapshot(), { status: 'ready', catalog })
    assert.deepEqual(seen, ['loading', 'ready'])
    await store.load()
    assert.equal(calls.length, 1, 'a ready read uses the current snapshot until explicitly refreshed')
  } finally { stop(); store.dispose(); lifetime.abort() }
})

test('refresh retains selected-model data during errors, then publishes replacement provider groups', async () => {
  const lifetime = new AbortController()
  let response: unknown = { ok: true, value: catalog }
  const store = createModelOptionsStore({ rpc: { async call() { return response } } }, lifetime.signal)
  const stop = store.subscribe(() => {})
  try {
    await store.load()
    response = { ok: false, error: { message: 'Catalog is disconnected' } }
    await store.refresh()
    assert.equal(store.getSnapshot().status, 'error')
    assert.equal(store.getSnapshot().error, 'Catalog is disconnected')
    assert.deepEqual(store.getSnapshot().catalog, catalog)
    response = { ok: true, value: { groups: [], failures: [{ id: 'provider', name: 'Provider', message: 'Unavailable' }] } }
    await store.refresh()
    assert.equal(store.getSnapshot().status, 'ready')
    assert.deepEqual(store.getSnapshot().catalog?.groups, [])
    assert.equal(store.getSnapshot().catalog?.failures[0]?.id, 'provider')
    response = { ok: true, value: { groups: [{ id: 'bad', name: 'Bad', models: [{ id: 'bad' }] }], failures: [] } }
    await store.refresh()
    assert.equal(store.getSnapshot().status, 'error', 'malformed catalog data never enters selectable choices')
    assert.deepEqual(store.getSnapshot().catalog?.groups, [])
  } finally { stop(); store.dispose(); lifetime.abort() }
})

for (const action of ['unsubscribe', 'dispose', 'lifetime'] as const) {
  test(`model option ${action} cancels pending I/O and ignores a late reply`, async () => {
    const pending = deferred<unknown>(), lifetime = new AbortController()
    let signal: AbortSignal | undefined, events = 0
    const store = createModelOptionsStore({ rpc: { async call(_path, _method, _payload, inputSignal) {
      signal = inputSignal; return pending.promise
    } } }, lifetime.signal)
    const stop = store.subscribe(() => { events++ })
    const load = store.load()
    await Promise.resolve()
    assert.equal(signal?.aborted, false)
    if (action === 'unsubscribe') stop()
    else if (action === 'dispose') store.dispose()
    else lifetime.abort()
    await load
    const atCancel = store.getSnapshot(), atEvents = events
    assert.equal(signal?.aborted, true)
    pending.resolve({ ok: true, value: catalog })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(store.getSnapshot(), atCancel)
    assert.equal(events, atEvents)
    if (action === 'unsubscribe') {
      // A later settings view may start fresh; no stale response is treated as a load.
      const again = store.subscribe(() => {})
      assert.equal(store.getSnapshot().status, 'idle')
      again()
    }
    stop(); store.dispose(); lifetime.abort()
  })
}

test('an already disposed model directory performs no requests', async () => {
  const lifetime = new AbortController()
  const store = createModelOptionsStore({ rpc: { async call() { assert.fail('disposed directory cannot fetch') } } }, lifetime.signal)
  store.dispose()
  await store.load(); await store.refresh()
  store.subscribe(() => assert.fail('disposed directory cannot publish'))()
})
