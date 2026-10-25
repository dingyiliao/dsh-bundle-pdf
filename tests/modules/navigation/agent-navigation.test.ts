import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentNavigation, createReaderContexts } from '../../../src/modules/navigation/index.ts'
import { evidenceSha256 } from '../../../src/modules/evidence/index.ts'
import type { TextNavigationTarget } from '../../../src/contracts/navigation.ts'

const signal = new AbortController().signal
const sessionId = 'session-a', documentId = 'document-a', contentVersion = 'version-a'
const workspaces = { readSnapshot(caller: string, id: string) {
  if (caller !== sessionId || id !== documentId) throw Object.assign(new Error('Access denied'), { code: 'pdf/session-mismatch' })
  return { id: documentId, contentVersion, document: { pageCount: 8 } }
} }

function setup(timeoutMs = 1000) {
  const contexts = createReaderContexts(workspaces as never)
  const service = createAgentNavigation(workspaces as never, contexts, timeoutMs)
  const lease = { sessionId, tabId: 'tab-a', leaseId: 'lease-a', documentId, contentVersion }
  contexts.update(sessionId, { action: 'set', ...lease, sequence: 1, page: 2 })
  return { contexts, service, lease }
}

test('agent navigation reaches the visible Reader and returns its completed jump', async () => {
  const { service, contexts, lease } = setup()
  try {
    const result = service.navigate(sessionId, { documentId, contentVersion, page: 6 }, signal)
    const request = await service.dispatch(sessionId, { action: 'wait', ...lease }, signal) as {
      requestId: string; page: number
    }
    assert.equal(request.page, 6)
    assert.deepEqual(await service.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, status: 'opened' }, signal), { accepted: true })
    assert.equal((await result).status, 'opened')
    assert.equal(await service.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, status: 'opened' }, signal).then(value => (value as { accepted: boolean }).accepted), false)
  } finally { service.dispose(); contexts.dispose() }
})

test('navigation refuses foreign leases, ambiguous tabs, stale versions and invisible Readers', async () => {
  const { service, contexts, lease } = setup(20)
  try {
    await assert.rejects(service.dispatch(sessionId, { action: 'wait', ...lease, leaseId: 'wrong' }, signal),
      { code: 'pdf/stale-reader' })
    await assert.rejects(service.dispatch('other-session', { action: 'wait', ...lease }, signal),
      { code: 'pdf/session-mismatch' })
    await assert.rejects(service.navigate(sessionId, { documentId, contentVersion: 'old', page: 4 }, signal),
      { code: 'pdf/stale-reader' })
    contexts.update(sessionId, { action: 'set', ...lease, tabId: 'tab-b', leaseId: 'lease-b', sequence: 2, page: 3 })
    const ambiguous = await service.navigate(sessionId, { documentId, contentVersion, page: 4 }, signal)
    assert.equal(ambiguous.status, 'ambiguous')
    const timedOut = await service.navigate(sessionId, { documentId, contentVersion, page: 4, tabId: 'tab-a' }, signal)
    assert.equal(timedOut.status, 'unavailable')
    contexts.update(sessionId, { action: 'clear', sessionId, tabId: 'tab-a', leaseId: 'lease-a', sequence: 3 })
    contexts.update(sessionId, { action: 'clear', sessionId, tabId: 'tab-b', leaseId: 'lease-b', sequence: 4 })
    const invisible = await service.navigate(sessionId, { documentId, contentVersion, page: 4 }, signal)
    assert.equal(invisible.status, 'unavailable')
  } finally { service.dispose(); contexts.dispose() }
})

test('navigation rejects invalid pages and serializes jumps to one Reader', async () => {
  const { service, contexts, lease } = setup()
  const controller = new AbortController()
  try {
    await assert.rejects(service.navigate(sessionId, { documentId, contentVersion, page: 9 }, signal),
      { code: 'pdf/invalid-page' })
    const first = service.navigate(sessionId, { documentId, contentVersion, page: 3 }, controller.signal)
    const busy = await service.navigate(sessionId, { documentId, contentVersion, page: 4 }, signal)
    assert.equal(busy.status, 'busy')
    controller.abort(new Error('cancelled by caller'))
    await assert.rejects(first, /cancelled by caller/)
    const replacement = service.navigate(sessionId, { documentId, contentVersion, page: 5 }, signal)
    const request = await service.dispatch(sessionId, { action: 'wait', ...lease }, signal) as { requestId: string }
    assert.deepEqual(await service.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, status: 'stale' }, signal), { accepted: true })
    assert.equal((await replacement).status, 'stale')
  } finally { service.dispose(); contexts.dispose() }
})

test('an outdated exact target is rejected before delivery and does not block a fresh jump', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const current = { ...workspaces, readSnapshot(caller: string, id: string) {
    return { ...workspaces.readSnapshot(caller, id), revision: 2, bytes }
  } }
  const contexts = createReaderContexts(current as never)
  const service = createAgentNavigation(current as never, contexts)
  const lease = { sessionId, tabId: 'tab-a', leaseId: 'lease-a', documentId, contentVersion }
  contexts.update(sessionId, { action: 'set', ...lease, sequence: 1, page: 2 })
  const target: TextNavigationTarget = { kind: 'text', refId: 'exact-target', revision: 1,
    sourceDigest: evidenceSha256(bytes), pageTextDigest: evidenceSha256('quote'),
    textSha256: evidenceSha256('quote'), startUtf16: 0, endUtf16: 5,
    rectPdf: [10, 10, 50, 20], quadPoints: [10, 20, 50, 20, 10, 10, 50, 10] }
  try {
    await assert.rejects(service.navigate(sessionId, { documentId, contentVersion, page: 3, target }, signal),
      { code: 'pdf/stale-reader', message: 'PDF changed after resolving the evidence; locate it again' })
    const freshTarget = { ...target, revision: 2 }
    const navigation = service.navigate(sessionId, { documentId, contentVersion, page: 3, target: freshTarget }, signal)
    const delivered = await service.dispatch(sessionId, { action: 'wait', ...lease }, signal) as {
      requestId: string; target: TextNavigationTarget
    }
    assert.deepEqual(delivered.target, freshTarget)
    assert.deepEqual(await service.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: delivered.requestId, targetRevision: 2, sourceDigest: target.sourceDigest, status: 'opened' }, signal),
    { accepted: true })
    assert.equal((await navigation).status, 'opened')
  } finally { service.dispose(); contexts.dispose() }
})

test('waiting Reader receives later navigation, and cancellation and disposal wake the waiter', async () => {
  const { service, contexts, lease } = setup()
  try {
    const waiting = service.dispatch(sessionId, { action: 'wait', ...lease }, signal)
    const navigation = service.navigate(sessionId, { documentId, contentVersion, page: 7 }, signal)
    const request = await waiting as { requestId: string; page: number }
    assert.equal(request.page, 7)
    service.dispose()
    assert.equal((await navigation).status, 'unavailable')
    assert.deepEqual(await service.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, status: 'opened' }, signal), { accepted: false })
    assert.equal(await service.dispatch(sessionId, { action: 'wait', ...lease }, signal), null)
    await assert.rejects(service.navigate(sessionId, { documentId, contentVersion, page: 1 }, signal),
      /PDF navigation has stopped/)
  } finally { service.dispose(); contexts.dispose() }

  const second = setup()
  try {
    const controller = new AbortController()
    const waiting = second.service.dispatch(sessionId, { action: 'wait', ...second.lease }, controller.signal)
    controller.abort(new Error('cancelled Reader wait'))
    await assert.rejects(waiting, /cancelled Reader wait/)
    const afterCancel = second.service.navigate(sessionId,
      { documentId, contentVersion, page: 3 }, signal)
    const request = await second.service.dispatch(sessionId, { action: 'wait', ...second.lease }, signal) as { requestId: string }
    await second.service.dispatch(sessionId, { action: 'complete', ...second.lease,
      requestId: request.requestId, status: 'opened' }, signal)
    assert.equal((await afterCancel).status, 'opened')
    const waitingOnDispose = second.service.dispatch(sessionId, { action: 'wait', ...second.lease }, signal)
    second.service.dispose()
    assert.equal(await waitingOnDispose, null)
  } finally { second.service.dispose(); second.contexts.dispose() }
})

test('request watchers propagate caller cancellation and do not accept a late Reader completion', async () => {
  const { service, contexts, lease } = setup()
  const caller = new AbortController()
  try {
    const navigation = service.navigate(sessionId, { documentId, contentVersion, page: 4 }, caller.signal)
    const rejected = assert.rejects(navigation, /caller cancelled/)
    const request = await service.dispatch(sessionId, { action: 'wait', ...lease }, signal) as { requestId: string }
    const watch = { action: 'watch-request', ...lease, requestId: request.requestId }
    assert.deepEqual(await service.dispatch(sessionId, { ...watch, leaseId: 'wrong' }, signal), { active: false })
    await assert.rejects(service.dispatch('another-session', watch, signal), { code: 'pdf/session-mismatch' })
    const watching = service.dispatch(sessionId, watch, signal)
    caller.abort(new Error('caller cancelled'))
    assert.deepEqual(await watching, { active: false })
    await rejected
    assert.deepEqual(await service.dispatch(sessionId, { action: 'complete', ...lease,
      requestId: request.requestId, status: 'opened' }, signal), { accepted: false })
  } finally { service.dispose(); contexts.dispose() }
})

test('request watchers release on tool timeout, UI abort, completion and service disposal', async () => {
  for (const reason of ['timeout', 'ui-abort', 'completed', 'disposed'] as const) {
    const { service, contexts, lease } = setup(reason === 'timeout' ? 20 : 1000)
    try {
      const navigation = service.navigate(sessionId, { documentId, contentVersion, page: 4 }, signal)
      const request = await service.dispatch(sessionId, { action: 'wait', ...lease }, signal) as { requestId: string }
      const controller = new AbortController()
      const watching = service.dispatch(sessionId, { action: 'watch-request', ...lease,
        requestId: request.requestId }, controller.signal)
      if (reason === 'ui-abort') {
        const rejected = assert.rejects(watching, /UI watch cancelled/)
        controller.abort(new Error('UI watch cancelled'))
        await rejected
        await service.dispatch(sessionId, { action: 'complete', ...lease,
          requestId: request.requestId, status: 'opened' }, signal)
      } else if (reason === 'completed') {
        await service.dispatch(sessionId, { action: 'complete', ...lease,
          requestId: request.requestId, status: 'opened' }, signal)
      } else if (reason === 'disposed') service.dispose()
      if (reason !== 'ui-abort') assert.deepEqual(await watching, { active: false })
      assert.equal((await navigation).status, reason === 'completed' || reason === 'ui-abort' ? 'opened' : 'unavailable')
    } finally { service.dispose(); contexts.dispose() }
  }
})
