import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { EngineCatalog, EngineDirectory, type EngineDescriptor } from '../../src/modules/engines/index.ts'
import { createAgentNavigation, createReaderContexts } from '../../src/modules/navigation/index.ts'
import { createPdfIndexing } from '../../src/adapters/host/dsh/indexing.ts'
import { createRetrievalPrefetch } from '../../src/adapters/host/dsh/retrieval-prefetch.ts'
import { memoryWorkspace, nativeFixture } from '../native-fixture.ts'

async function fixture() {
  const { workspaces } = memoryWorkspace(await nativeFixture())
  const sessionId = 'passive-poll-session', signal = new AbortController().signal
  const agent = { session: { id: sessionId, header: {} } }
  const opened = await workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('document' in opened)
  const contexts = createReaderContexts(workspaces), navigation = createAgentNavigation(workspaces, contexts)
  const lease = (tabId: string) => ({ sessionId, tabId, leaseId: `lease-${tabId}`,
    documentId: opened.id, contentVersion: opened.contentVersion })
  for (const tabId of ['waiting', 'navigating']) contexts.update(sessionId,
    { action: 'set', ...lease(tabId), sequence: 1, page: 1 })
  const caller = new AbortController()
  let toolSettled = false
  const tool = navigation.navigate(sessionId, { documentId: opened.id, contentVersion: opened.contentVersion,
    page: 2, tabId: 'navigating' }, caller.signal).then(value => { toolSettled = true; return value }, () => {
    toolSettled = true; return null
  })
  const request = await navigation.dispatch(sessionId, { action: 'wait', ...lease('navigating') }, signal) as { requestId: string }
  const catalog = new EngineCatalog()
  const prefetch = createRetrievalPrefetch({ documents: () => [], selection: () => undefined,
    async prepare() { assert.fail('Passive subscriptions must not start indexing') } })
  let enabled = false
  const indexing = createPdfIndexing(prefetch, { documents: () => [], enabled: () => enabled })
  return {
    catalog, indexing, navigation, workspaces, tool, toolSettled: () => toolSettled,
    begin(signal: AbortSignal) {
      return [catalog.wait(catalog.read().revision, signal),
        workspaces.waitForRevision(sessionId, opened.id, workspaces.readSnapshot(sessionId, opened.id).revision, signal),
        indexing.dispatch(sessionId, { action: 'status', sessionId, revision: indexing.snapshot(sessionId).revision }, signal),
        navigation.dispatch(sessionId, { action: 'wait', ...lease('waiting') }, signal),
        navigation.dispatch(sessionId, { action: 'watch-request', ...lease('navigating'), requestId: request.requestId }, signal)]
    },
    async change() {
      catalog.attach('translation', new EngineDirectory((value: { descriptor: EngineDescriptor }) => value.descriptor))
      const current = workspaces.readSnapshot(sessionId, opened.id)
      await workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: current.revision,
        operations: [{ type: 'add', annotation: { id: 'note', page: 1, subtype: 'Text', rect: [50, 50, 60, 60] } }] }, agent, signal)
      enabled = true; indexing.changed()
      // Dispose the navigation handoff to wake both navigation subscriptions.
      navigation.dispose()
    },
    async dispose() {
      catalog.dispose(); indexing.dispose(); navigation.dispose(); contexts.dispose()
      caller.abort(); await tool
      await prefetch.dispose(); await workspaces.dispose()
    },
  }
}

test('all passive PDF subscriptions yield within five seconds, including disabled indexing and active-navigation observation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), controller = new AbortController()
  try {
    const settled = new Set<number>()
    const waits = f.begin(controller.signal).map((task, index) => task.then(value => { settled.add(index); return value }))
    assert.equal(getEventListeners(controller.signal, 'abort').length, 5)
    t.mock.timers.tick(4999)
    await Promise.resolve()
    assert.equal(settled.size, 0)
    t.mock.timers.tick(1)
    const results = await Promise.all(waits)
    assert.equal(settled.size, 5, 'a Desktop admission lock can drain every idle observer before its 10-second deadline')
    assert.deepEqual(results[0], f.catalog.read())
    assert.equal(results[1], 0)
    assert.equal((results[2] as { enabled: boolean }).enabled, false)
    assert.equal(results[3], null)
    assert.deepEqual(results[4], { active: true })
    assert.equal(f.toolSettled(), false, 'the observation budget must not time out real navigation work')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  } finally { await f.dispose() }
})

test('cancelling passive subscriptions releases their abort listeners and new subscriptions still receive immediate events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), cancelled = new AbortController(), next = new AbortController()
  try {
    const waits = f.begin(cancelled.signal).map(task => assert.rejects(task, /observer stopped/))
    cancelled.abort(new Error('observer stopped'))
    await Promise.all(waits)
    assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0)
    assert.equal(f.toolSettled(), false)
    const renewed = f.begin(next.signal)
    await f.change()
    const results = await Promise.all(renewed)
    assert.equal(results[1], 1, 'a durable edit wakes the renewed document subscription without waiting for its deadline')
    assert.equal((results[2] as { enabled: boolean }).enabled, true)
    assert.equal(results[3], null)
    assert.deepEqual(results[4], { active: false })
    assert.equal(getEventListeners(next.signal, 'abort').length, 0)
  } finally { await f.dispose() }
})
