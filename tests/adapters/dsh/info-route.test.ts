import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfInfoRoute } from '../../../src/adapters/host/dsh/info-route.ts'

const settings = { namespace: 'pdf', settingsNamespace: 'profile/pdf', settings: { maxBytes: 42 },
  translationEngines: ['session'] }

function request(body: BodyInit | null, headers: HeadersInit = { 'content-type': 'application/json' },
  signal?: AbortSignal): Request {
  return new Request('https://example.test/api/pdf.info', { method: 'POST', body, headers, signal })
}

test('info route preserves the payload-free V1 bootstrap envelope and does not expose mutable settings', async () => {
  let reads = 0
  const route = createPdfInfoRoute(() => { reads++; return settings })
  assert.equal(route.path, '/api/pdf.info')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'streaming')
  const response = await route.fetch(request(JSON.stringify({ type: 'client-request', method: 'pdf.info', rpcId: 'r1' }),
    { 'content-type': 'Application/JSON; charset=utf-8' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'r1',
    result: { ok: true, value: settings } })
  assert.equal(reads, 1)
})

test('info route rejects malformed, oversized, cancelled and unrelated RPC input before reading settings', async () => {
  let reads = 0
  const route = createPdfInfoRoute(() => { reads++; return settings })
  const invalid = [
    [request('{}', { 'content-type': 'text/plain' }), 415],
    [request('{'), 400],
    [request(null), 400],
    [request('{}', { 'content-type': 'application/json', 'content-length': 'garbage' }), 413],
    [request('{}', { 'content-type': 'application/json', 'content-length': '4097' }), 413],
    [request(' '.repeat(4097)), 413],
    [request(new Uint8Array([0xff])), 400],
    [request(JSON.stringify({ type: 'client-request', method: 'pdf.read', rpcId: 'r1' })), 400],
    [request(JSON.stringify({ type: 'client-request', method: 'pdf.info', rpcId: '' })), 400],
  ] as const
  for (const [input, status] of invalid) assert.equal((await route.fetch(input)).status, status)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await route.fetch(request('{}', undefined, controller.signal))).status, 499)
  assert.equal(reads, 0)
})
