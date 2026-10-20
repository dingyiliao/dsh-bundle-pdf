import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadingContextReporter } from '../src/adapters/client/remote/pdf-api.ts'

test('active reading context sends only session-owned document and page metadata in order', async () => {
  const requests: Array<{ path: string; method: string; payload: Record<string, unknown> }> = []
  const reporter = createReadingContextReporter({ rpc: { async call(path, method, payload) {
    requests.push({ path, method, payload: payload as Record<string, unknown> })
    return { ok: true, value: { ok: true } }
  } } }, new AbortController().signal)

  await reporter({ action: 'set', sessionId: 's1', tabId: 'tab-1', leaseId: 'lease-1',
    documentId: 'pdf-1', contentVersion: 'v1', page: 3 })
  await reporter({ action: 'set', sessionId: 's1', tabId: 'tab-1', leaseId: 'lease-1',
    documentId: 'pdf-1', contentVersion: 'v1', page: 4 })
  await reporter({ action: 'clear', sessionId: 's1', tabId: 'tab-1', leaseId: 'lease-1' })

  assert.deepEqual(requests.map(request => [request.path, request.method]),
    [['/api', 'pdf.readercontext'], ['/api', 'pdf.readercontext'], ['/api', 'pdf.readercontext']])
  assert.deepEqual(requests.map(request => [request.payload.action, request.payload.page]),
    [['set', 3], ['set', 4], ['clear', undefined]])
  const sequences = requests.map(request => request.payload.sequence as number)
  assert.ok(sequences.every(Number.isSafeInteger))
  assert.ok(sequences[0]! < sequences[1]! && sequences[1]! < sequences[2]!)
  assert.ok(requests.every(request => !('text' in request.payload) && !('selection' in request.payload)))
})

test('active reading context reports rejected RPCs and respects client disposal', async () => {
  const lifetime = new AbortController()
  let calls = 0
  const reporter = createReadingContextReporter({ rpc: { async call() {
    calls++
    return { ok: false, error: { code: 'pdf/invalid-request', message: 'Invalid page' } }
  } } }, lifetime.signal)
  const update = { action: 'set' as const, sessionId: 's1', tabId: 'tab-1', leaseId: 'lease-1',
    documentId: 'pdf-1', contentVersion: 'v1', page: 999 }
  await assert.rejects(reporter(update), (error: Error & { code?: string }) =>
    error.message === 'Invalid page' && error.code === 'pdf/invalid-request')
  lifetime.abort()
  await assert.rejects(reporter(update), { name: 'AbortError' })
  assert.equal(calls, 1)
})
