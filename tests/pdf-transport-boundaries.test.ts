import assert from 'node:assert/strict'
import test from 'node:test'
import { binaryResult, PDF_ENDPOINT, registerPdfTransport, type PdfDispatch } from '../src/host/transport.ts'

type Route = Parameters<Parameters<typeof registerPdfTransport>[0]['connection']['fetch']['register']>[0]
const envelope = (payload: unknown, method = PDF_ENDPOINT) => ({
  type: 'client-request', rpcId: 'rpc-1', method, payload,
})
const request = (value: unknown, headers: Record<string, string> = {}) => new Request(`https://example.test/api/${PDF_ENDPOINT}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
})
const install = (dispatch: PdfDispatch = async () => ({ ok: true }), resolveAgent?: (id: string) => Promise<unknown>) => {
  let route!: Route
  const resolver = resolveAgent ?? (async (sessionId: string) => ({ agent: { session: { id: sessionId, header: {} } } }))
  const unregister = registerPdfTransport({
    connection: { fetch: { register(value) { route = value; return async () => undefined } } },
    sessionController: { resolveAgent: resolver as never },
  }, dispatch)
  return { route, unregister }
}

test('PDF transport rejects unsupported media, invalid JSON, oversized bodies and malformed envelopes', async () => {
  const { route } = install()
  assert.equal((await route.fetch(new Request('https://example.test', { method: 'POST', body: '{}' }))).status, 415)
  assert.equal((await route.fetch(new Request('https://example.test', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{broken' }))).status, 400)
  assert.equal((await route.fetch(request(envelope({ sessionId: 's' }), { 'content-length': String(16 * 1024 * 1024 + 1) }))).status, 413)
  assert.equal((await route.fetch(request(envelope({ sessionId: 's' }), { 'content-length': 'invalid' }))).status, 413)
  for (const invalid of [null, [], { ...envelope({ sessionId: 's' }), method: 'pdf.other' },
    { ...envelope({ sessionId: 's' }), rpcId: '' }]) {
    assert.equal((await route.fetch(request(invalid))).status, 400)
  }
  assert.equal((await route.fetch(request(envelope({})))).status, 200)
  const rejected = await (await route.fetch(request(envelope({})))).json() as { result: { error: { code: string } } }
  assert.equal(rejected.result.error.code, 'pdf/invalid-request')
})

test('PDF transport enforces actual streamed body size and closes an errored reader', async () => {
  let route!: Route
  registerPdfTransport({
    connection: { fetch: { register(value) { route = value; return async () => undefined } } },
    sessionController: { async resolveAgent(sessionId) { return { agent: { session: { id: sessionId, header: {} } } } } },
  }, async () => 'ignored', { maxRequestBytes: 16 })
  assert.equal((await route.fetch(request(envelope({ sessionId: 's' })))).status, 413)
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('I/O error')) } })
  const incoming = new Request('https://example.test', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: broken, duplex: 'half' } as RequestInit)
  assert.equal((await route.fetch(incoming)).status, 400)
})

test('PDF transport binds an authenticated session before dispatch and returns error envelopes', async () => {
  let dispatched = 0
  const { route } = install(async () => { dispatched++; throw { code: 'pdf/custom' } }, async () => ({
    agent: { session: { id: 'other-session', header: {} } },
  }))
  const response = await route.fetch(request(envelope({ sessionId: 'session' })))
  const body = await response.json() as { result: { error: { code: string } } }
  assert.equal(body.result.error.code, 'pdf/session-mismatch')
  assert.equal(dispatched, 0)

  const missing = install(async () => { dispatched++; return 'never' }, async () => ({ error: new Error('No session') }))
  const missingBody = await (await missing.route.fetch(request(envelope({ sessionId: 's' })))).json() as {
    result: { error: { code: string; message: string } }
  }
  assert.equal(missingBody.result.error.code, 'pdf/internal')
  assert.equal(missingBody.result.error.message, 'No session')
  assert.equal(dispatched, 0)
})

test('PDF transport uses Connection multipart bytes for binary replies and preserves typed errors', async () => {
  const { route } = install(async (_id, input) => input.action === 'image'
    ? binaryResult({ id: 'page', bytes: new Uint8Array([99]) }, new Uint8Array([1, 2, 3]), 'image/png')
    : Promise.reject(Object.assign(new Error('Denied'), { code: 'pdf/denied' })))
  const response = await route.fetch(request(envelope({ sessionId: 's', action: 'image' })))
  assert.match(response.headers.get('content-type') ?? '', /^multipart\/form-data/)
  const form = await response.formData()
  const metadata = JSON.parse(String(form.get('metadata'))) as { result: { value: { bytes: null } } }
  assert.equal(metadata.result.value.bytes, null)
  assert.deepEqual(new Uint8Array(await (form.get('pdf-bytes') as Blob).arrayBuffer()), new Uint8Array([1, 2, 3]))
  const failure = await (await route.fetch(request(envelope({ sessionId: 's', action: 'error' })))).json() as {
    result: { error: { code: string; message: string } }
  }
  assert.deepEqual([failure.result.error.code, failure.result.error.message], ['pdf/denied', 'Denied'])
})
