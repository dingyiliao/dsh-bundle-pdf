import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPdfAgentNavigationApi } from '../../../../src/adapters/client/remote/pdf-api.ts'

const digest = `sha256:${'a'.repeat(64)}`
const request = { requestId: '4a0c121b-80b5-441b-91a0-0f3baf471e84', documentId: 'doc', page: 2, contentVersion: 'v',
  target: { kind: 'text', refId: 'ref', revision: 4, sourceDigest: digest, pageTextDigest: digest,
    startUtf16: 3, endUtf16: 7, textSha256: digest, rectPdf: [10, 20, 80, 30], quadPoints: [10, 30, 80, 30, 10, 20, 80, 20] } }
const context = { sessionId: 'session', tabId: 'tab', leaseId: 'lease', documentId: 'doc', contentVersion: 'v' }

test('navigation transport preserves the entire strict Host target and completion version proof', async () => {
  const calls: object[] = [], signal = new AbortController().signal
  const api = createPdfAgentNavigationApi({ rpc: { async call(_path, _method, payload) {
    calls.push(payload)
    return { ok: true, value: 'action' in payload && payload.action === 'complete' ? { accepted: true }
      : 'action' in payload && payload.action === 'watch-request' ? { active: false } : request }
  } } }, signal)
  assert.deepEqual(await api.wait(context, signal), request)
  assert.deepEqual(await api.watchRequest({ ...context, requestId: request.requestId }, signal), { active: false })
  await api.complete({ ...context, requestId: request.requestId, status: 'opened', targetRevision: 4, sourceDigest: digest }, signal)
  assert.deepEqual(calls[1], { action: 'watch-request', ...context, requestId: request.requestId })
  assert.deepEqual(calls[2], { action: 'complete', ...context, requestId: request.requestId, status: 'opened', targetRevision: 4, sourceDigest: digest })
})

test('navigation transport rejects malformed geometry, hashes, offsets and unrecognized target fields', async () => {
  const signal = new AbortController().signal
  for (const target of [{ ...request.target, rectPdf: [0, 0, 0, 2] }, { ...request.target, sourceDigest: 'bad' },
    { ...request.target, startUtf16: 8 }, { ...request.target, quadPoints: [1, 2] }, { ...request.target, modelCoordinates: true }]) {
    const api = createPdfAgentNavigationApi({ rpc: { async call() { return { ok: true, value: { ...request, target } } } } }, signal)
    await assert.rejects(api.wait(context, signal))
  }
})
