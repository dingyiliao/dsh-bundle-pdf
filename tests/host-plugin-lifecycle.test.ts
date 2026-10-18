import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { apply, inject, name } from '../src/host/index.ts'
import { Config, type HostConfig } from '../src/host/config.ts'
import { defaultSettings } from '../src/shared/contracts.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

type Route = Parameters<Parameters<typeof apply>[0]['connection']['fetch']['register']>[0]
type HostContext = Parameters<typeof apply>[0]

async function assetFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-plugin-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'ocr'))
  const bytes = Buffer.from('export const bridge = true\n')
  await writeFile(join(root, 'ocr', 'bridge.js'), bytes)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, files: [{
    path: 'ocr/bridge.js', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'text/javascript; charset=utf-8',
  }] }))
  return root
}

function host(options: { namespace?: string; failOpenAt?: number; failRegistration?: string;
  failDisposal?: string; failDomainClose?: number; failProvideKey?: string; agentSessionId?: string } = {}) {
  const routes = new Map<string, Route>()
  const registrations: string[] = []
  const releases: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  const tools: string[] = []
  const provided: string[] = []
  const injections: string[][] = []
  const effects: { label: string; dispose?: () => void | Promise<void> }[] = []
  const ctx = {
    loader: { locate: () => options.namespace ?? 'entry/pdf',
      resolve: (id: string) => ({ options: { id: id === 'entry/pdf' ? 'pdf-reader-entry' : id } }) },
    fs: {}, sandboxPolicy: {}, pdfNative: { executable: '/unused/pdfium-worker' }, subprocess: nativeTestSubprocess,
    sessionController: { async resolveAgent() {
      return options.agentSessionId
        ? { agent: { session: { id: options.agentSessionId, header: {} } } }
        : { error: new Error('No active agent') }
    } },
    get() { return undefined },
    storageDomain: { async open(definition: { name: string }) {
      if (opened.length + 1 === options.failOpenAt) throw new Error('Domain open failed')
      opened.push(definition.name)
      const values = new Map<string, unknown>()
      return {
        table() { return {
          get: (key: string) => values.get(key),
          put: async (key: string, value: unknown) => { values.set(key, value) },
          delete: async (key: string) => { values.delete(key) },
        } },
        async close() {
          closed.push(definition.name)
          if (opened.indexOf(definition.name) + 1 === options.failDomainClose) throw new Error('Domain close failed')
        },
      }
    } },
    connection: { fetch: { register(route: Route) {
      if (route.path === options.failRegistration) throw new Error('Route registration failed')
      assert.equal(routes.has(route.path), false, `Duplicate PDF route: ${route.path}`)
      routes.set(route.path, route)
      registrations.push(route.path)
      return async () => {
        routes.delete(route.path)
        releases.push(route.path)
        if (route.path === options.failDisposal) throw new Error('Route disposal failed')
      }
    } } },
    tools: { register(tool: { name: string }) { tools.push(tool.name) } },
    reflect: { provide(key: string) {
      if (key === options.failProvideKey) throw new Error('Service provision failed')
      provided.push(key)
      return () => undefined
    } },
    inject(names: string[]) { injections.push(names); return { async dispose() {} } },
    effect(callback: () => void | (() => void | Promise<void>), label: string) {
      const dispose = callback()
      effects.push({ label, dispose: dispose ?? undefined })
    },
  }
  const config = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({})
  async function disposeEffects() {
    for (const effect of [...effects].reverse()) await effect.dispose?.()
  }
  return { ctx: ctx as unknown as HostContext, config, routes, registrations, releases, opened, closed,
    tools, provided, injections, effects, disposeEffects }
}

function infoRequest(payload: unknown, init: RequestInit = {}) {
  return new Request('https://example.test/api/pdf.info', {
    method: 'POST', headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(payload), ...init,
  })
}

test('Host plugin installs its authenticated routes, tools, services and three separate domains', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host()
  assert.equal(name, 'pdf-reader')
  assert.deepEqual(inject, ['connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain',
    'loader', 'tools', 'pdfNative', 'subprocess'])
  await apply(runtime.ctx, runtime.config, assets)
  try {
    assert.equal(runtime.routes.size, 9)
    assert.deepEqual(runtime.registrations, [
      '/api/pdf.dispatch.v2', '/api/pdf.native', '/api/pdf.bookmarks', '/api/pdf.position',
      '/api/pdf.translation', '/api/pdf.ocr', '/api/pdf.readercontext', '/api/pdf-assets/ocr/bridge.js', '/api/pdf.info',
    ])
    assert.deepEqual(runtime.opened.map(domain => domain.split('_').slice(0, 2).join('_')),
      ['pdf_drafts', 'pdf_bookmarks', 'pdf_positions'])
    assert.deepEqual(runtime.provided, ['pdfTranslation', 'pdf'])
    assert.ok(runtime.tools.includes('pdf_open'))
    assert.ok(runtime.tools.includes('pdf_read_page'))
    assert.deepEqual(runtime.injections, [['systemPrompt']])
    assert.equal(runtime.effects.length, 5)

    const info = runtime.routes.get('/api/pdf.info')!
    assert.deepEqual(info.methods, ['POST'])
    assert.equal(info.requestBody, 'streaming')
    const response = await info.fetch(infoRequest({ type: 'client-request', method: 'pdf.info', rpcId: 'test-1' }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json() as { rpcId: string; result: { value: {
      namespace: string; settingsNamespace: string; settings: unknown; translationEngines: unknown[]
    } } }
    assert.equal(body.rpcId, 'test-1')
    assert.equal(body.result.value.namespace, 'entry/pdf')
    assert.equal(body.result.value.settingsNamespace, 'pdf-reader-entry')
    assert.deepEqual(body.result.value.settings, defaultSettings)
    assert.equal(body.result.value.translationEngines.length, 1)
  } finally { await runtime.disposeEffects() }
  assert.equal(runtime.routes.size, 0)
  assert.deepEqual(runtime.releases, [...runtime.registrations].reverse())
  assert.deepEqual(runtime.closed, [...runtime.opened].reverse())
})

test('Host info route rejects wrong content type, malformed and oversized requests without revealing settings', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host()
  await apply(runtime.ctx, runtime.config, assets)
  try {
    const route = runtime.routes.get('/api/pdf.info')!
    const wrongType = await route.fetch(new Request('https://example.test', { method: 'POST', body: '{}',
      headers: { 'content-type': 'text/plain' } }))
    assert.equal(wrongType.status, 415)
    const invalidJson = await route.fetch(new Request('https://example.test', { method: 'POST', body: '{',
      headers: { 'content-type': 'application/json' } }))
    assert.equal(invalidJson.status, 400)
    for (const payload of [{}, [], { type: 'client-request', method: 'pdf.info', rpcId: '' },
      { type: 'client-request', method: 'other', rpcId: 'ok' }]) {
      const invalid = await route.fetch(infoRequest(payload))
      assert.equal(invalid.status, 400)
    }
    const oversized = await route.fetch(new Request('https://example.test', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: 'x'.repeat(4097) }))
    assert.equal(oversized.status, 413)
    const declaredOversized = await route.fetch(new Request('https://example.test', { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '4097' }, body: '{}' }))
    assert.equal(declaredOversized.status, 413)
    const invalidLength = await route.fetch(new Request('https://example.test', { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 'unknown' }, body: '{}' }))
    assert.equal(invalidLength.status, 413)
    const noBody = await route.fetch(new Request('https://example.test', { method: 'POST',
      headers: { 'content-type': 'application/json' } }))
    assert.equal(noBody.status, 400)
    const invalidUtf8 = await route.fetch(new Request('https://example.test', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xff]) }))
    assert.equal(invalidUtf8.status, 400)
    const uncooperativeOverflow = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4097)) },
      cancel() { throw new Error('Source cancellation failed') },
    })
    const overflowReply = await route.fetch(new Request('https://example.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: uncooperativeOverflow,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }))
    assert.equal(overflowReply.status, 413)
    const controller = new AbortController()
    const cancelledRequest = infoRequest({}, { signal: controller.signal })
    controller.abort()
    const cancelled = await route.fetch(cancelledRequest)
    assert.equal(cancelled.status, 499)

    let streamCancelled = false
    const blockedStream = new ReadableStream<Uint8Array>({
      cancel() { streamCancelled = true; throw new Error('Source cancellation failed') },
    })
    const inFlight = new AbortController()
    const streamingRequest = new Request('https://example.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: blockedStream,
      signal: inFlight.signal, duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const waiting = route.fetch(streamingRequest)
    inFlight.abort()
    const stopped = await waiting
    assert.equal(stopped.status, 499)
    assert.equal(streamCancelled, true)
  } finally { await runtime.disposeEffects() }
})

test('Host routes retain one Session identity for reader hints and translation requests', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host({ agentSessionId: 'session-a' })
  await apply(runtime.ctx, runtime.config, assets)
  try {
    const reader = runtime.routes.get('/api/pdf.readercontext')!
    const readerReply = await reader.fetch(infoRequest({ type: 'client-request', method: 'pdf.readercontext', rpcId: 'reader',
      payload: { action: 'clear', sessionId: 'session-a', tabId: 'tab-a', leaseId: 'lease-a', sequence: 0 } }))
    assert.equal(readerReply.status, 200)
    assert.deepEqual((await readerReply.json() as { result: { value: unknown } }).result.value, { ok: true })

    const translation = runtime.routes.get('/api/pdf.translation')!
    const translated = await translation.fetch(infoRequest({ type: 'client-request', method: 'pdf.translation', rpcId: 'translation',
      payload: { sessionId: 'session-a', engineId: 'dsh-model', text: 'Hello', sourceLanguage: 'auto',
        targetLanguage: 'zh', timeoutMs: 30000 } }))
    assert.equal(translated.status, 200)
    const result = await translated.json() as { result: { ok: boolean; error: { code: string } } }
    assert.equal(result.result.ok, false)
    assert.equal(result.result.error.code, 'not-configured')
  } finally { await runtime.disposeEffects() }
})

test('Host bootstrap closes earlier domains when opening bookmarks or positions fails', async (t) => {
  const assets = await assetFixture(t)
  for (const failOpenAt of [2, 3]) {
    const runtime = host({ failOpenAt })
    await assert.rejects(apply(runtime.ctx, runtime.config, assets), /Domain open failed/)
    assert.equal(runtime.effects.length, 0)
    assert.equal(runtime.routes.size, 0)
    assert.equal(runtime.opened.length, failOpenAt - 1)
    assert.deepEqual(runtime.closed, [...runtime.opened].reverse())
  }
})

test('Host plugin must be loaded from a configured Loader entry', async () => {
  const runtime = host({ namespace: '' })
  await assert.rejects(apply(runtime.ctx, runtime.config), /configured plugin entry/)
  assert.equal(runtime.opened.length, 0)
  assert.equal(runtime.routes.size, 0)
})

test('Host bootstrap rolls back all earlier routes and domains when a late registration fails', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host({ failRegistration: '/api/pdf.info' })
  await assert.rejects(apply(runtime.ctx, runtime.config, assets), /Route registration failed/)
  assert.equal(runtime.routes.size, 0)
  assert.deepEqual(runtime.releases, [...runtime.registrations].reverse())
  assert.deepEqual(runtime.closed, [...runtime.opened].reverse())
})

test('Host bootstrap retains its original error even when cleanup also fails', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host({ failProvideKey: 'pdf', failDomainClose: 2 })
  await assert.rejects(apply(runtime.ctx, runtime.config, assets), /Service provision failed/)
  assert.equal(runtime.routes.size, 0)
  assert.deepEqual(runtime.closed, [...runtime.opened].reverse())
})

test('Host teardown closes every domain even when one route disposal rejects', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host({ failDisposal: '/api/pdf.position' })
  await apply(runtime.ctx, runtime.config, assets)
  const routeEffect = runtime.effects.find(effect => effect.label.startsWith('pdf: routes'))
  const dispose = routeEffect?.dispose
  assert.ok(dispose)
  await assert.rejects(async () => { await dispose() }, (error: unknown) => error instanceof AggregateError
    && error.message === 'Could not fully dispose PDF routes and resources'
    && error.errors.some(cause => cause instanceof Error && cause.message === 'Route disposal failed'))
  assert.equal(runtime.routes.size, 0)
  assert.deepEqual(runtime.closed, [...runtime.opened].reverse())
  await assert.rejects(async () => { await dispose() }, AggregateError)
  assert.equal(runtime.closed.length, 3, 'a second teardown must not close domains twice')
  await runtime.disposeEffects().catch(() => undefined)
})
