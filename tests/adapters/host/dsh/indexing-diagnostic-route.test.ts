import assert from 'node:assert/strict'
import test from 'node:test'
import { createIndexingDiagnosticRoute } from '../../../../src/adapters/host/dsh/indexing-diagnostic-route.ts'
import { createIndexingDiagnostics } from '../../../../src/adapters/host/dsh/indexing-diagnostics.ts'

const base = { sessionId: 'owner', documentId: 'document', occurrence: 1 }
function fixture() {
  const calls: string[] = []
  const diagnostics = createIndexingDiagnostics({ log: { directory: '/test/pdf-logs', append() {}, failureCode: () => undefined } })
  diagnostics.record({ ...base, event: 'started' })
  diagnostics.record({ ...base, event: 'failed', error: Object.assign(new Error('private'), { code: 'ECONNRESET' }) })
  const ports = {
    diagnostics, directory: '/test/pdf-logs', documents: () => [{ sessionId: 'owner', id: 'document' }],
    flush: async () => { calls.push('flush') },
    authorize: async () => { calls.push('authorize') },
    desktop: { canOpenWorkspacePath: () => true, async openWorkspacePath(request: { path: string }, signal: AbortSignal) {
      signal.throwIfAborted(); calls.push(request.path)
    } },
  }
  return { ports, calls, dispatch: createIndexingDiagnosticRoute(ports) }
}
test('diagnostics copy one authorized occurrence and open only the fixed Host directory after flushing', async () => {
  const f = fixture(), signal = new AbortController().signal
  const result = await f.dispatch('owner', { ...base, action: 'report' }, signal)
  assert.equal(result.directory, '/test/pdf-logs'); assert.equal(result.canOpen, true)
  assert.equal(JSON.parse(result.report).task.failure.code, 'ECONNRESET')
  assert.ok(!result.report.includes('private'))
  assert.deepEqual(f.calls, ['authorize'])
  await f.dispatch('owner', { ...base, action: 'open' }, signal)
  assert.deepEqual(f.calls, ['authorize', 'flush', 'authorize', '/test/pdf-logs', 'authorize'])
})
test('diagnostic routes reject foreign, closed, expired and injected-path requests without opening anything', async () => {
  const f = fixture(), signal = new AbortController().signal
  await assert.rejects(f.dispatch('other', { ...base, action: 'report' }, signal), { code: 'pdf/session-mismatch' })
  await assert.rejects(f.dispatch('owner', { ...base, documentId: 'closed', action: 'report' }, signal), { code: 'pdf/unknown-document' })
  await assert.rejects(f.dispatch('owner', { ...base, occurrence: 99, action: 'report' }, signal), { code: 'pdf/index-diagnostics-unavailable' })
  await assert.rejects(f.dispatch('owner', { ...base, action: 'open', path: '/arbitrary' }, signal))
  assert.deepEqual(f.calls, [])
})
test('Web deployments can copy diagnostics without a native opener', async () => {
  const f = fixture(), signal = new AbortController().signal
  const dispatch = createIndexingDiagnosticRoute({ ...f.ports, desktop: {} })
  assert.equal((await dispatch('owner', { ...base, action: 'report' }, signal)).canOpen, false)
  await assert.rejects(dispatch('owner', { ...base, action: 'open' }, signal), { code: 'pdf/log-directory-unavailable' })
  f.ports.desktop.canOpenWorkspacePath = () => false
  await assert.rejects(f.dispatch('owner', { ...base, action: 'open' }, signal), { code: 'pdf/log-directory-unavailable' })
})
test('an older evicted attempt can still open the persistent log directory', async () => {
  const f = fixture()
  await f.dispatch('owner', { ...base, occurrence: 999, action: 'open' }, new AbortController().signal)
  assert.ok(f.calls.includes('/test/pdf-logs'))
})
test('abort and Session retirement during flush cannot open the directory or publish stale diagnostics', async () => {
  const f = fixture(), controller = new AbortController()
  controller.abort(new Error('closed'))
  await assert.rejects(f.dispatch('owner', { ...base, action: 'report' }, controller.signal), /closed/)
  const active = new AbortController()
  f.ports.flush = async () => { active.abort(new Error('closing')) }
  await assert.rejects(f.dispatch('owner', { ...base, action: 'open' }, active.signal), /closing/)
  f.ports.flush = async () => {}
  f.ports.authorize = async () => { throw Object.assign(new Error('retired'), { code: 'pdf/session-mismatch' }) }
  await assert.rejects(f.dispatch('owner', { ...base, action: 'open' }, new AbortController().signal), { code: 'pdf/session-mismatch' })
  await assert.rejects(f.dispatch('owner', { ...base, action: 'report' }, new AbortController().signal), { code: 'pdf/session-mismatch' })
  assert.deepEqual(f.calls, [])
})
test('opener failures propagate and an abort after the native handoff suppresses the result', async () => {
  const f = fixture(), controller = new AbortController()
  f.ports.desktop.openWorkspacePath = async () => { throw new Error('desktop refused') }
  await assert.rejects(f.dispatch('owner', { ...base, action: 'open' }, controller.signal), /desktop refused/)
  f.ports.desktop.openWorkspacePath = async () => { controller.abort(new Error('closed after handoff')) }
  await assert.rejects(f.dispatch('owner', { ...base, action: 'open' }, controller.signal), /closed after handoff/)
})
