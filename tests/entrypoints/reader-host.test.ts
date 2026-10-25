import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { apply, inject, name } from '../../src/entrypoints/reader-host.ts'
import { Config, type HostConfig } from '../../src/entrypoints/reader-host-config.ts'
import { defaultSettings } from '../../src/shared/contracts.ts'
import { evidenceSha256 } from '../../src/modules/evidence/index.ts'
import { nativeTestSubprocess } from '../native-test-subprocess.ts'

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
  failDisposal?: string; failDomainClose?: number; failProvideKey?: string; agentSessionId?: string;
  resolvedAgentId?: string; attachments?: unknown } = {}) {
  const routes = new Map<string, Route>()
  const registrations: string[] = []
  const releases: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  const tools: string[] = []
  const provided: string[] = []
  const services = new Map<string, unknown>()
  const injections: string[][] = []
  const effects: { label: string; dispose?: () => void | Promise<void> }[] = []
  const ctx = {
    loader: { locate: () => options.namespace ?? 'entry/pdf',
      resolve: (id: string) => ({ options: { id: id === 'entry/pdf' ? 'pdf-reader-entry' : id } }) },
    fs: {}, sandboxPolicy: {}, pdfNative: { executable: '/unused/pdfium-worker' }, subprocess: nativeTestSubprocess,
    sessionController: { async resolveAgent() {
      return options.agentSessionId
        ? { agent: { session: { id: options.resolvedAgentId ?? options.agentSessionId, header: {} } } }
        : { error: new Error('No active agent') }
    } },
    get(name: string) { return name === 'attachments' ? options.attachments : services.get(name) },
    storageDomain: { async open(definition: { name: string }) {
      if (opened.length + 1 === options.failOpenAt) throw new Error('Domain open failed')
      opened.push(definition.name)
      const values = new Map<string, unknown>()
      return {
        table() { return {
          get: (key: string) => values.get(key),
          put: async (key: string, value: unknown) => { values.set(key, value) },
          delete: async (key: string) => { values.delete(key) },
          entries: () => values.entries(),
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
    reflect: { provide(key: string, value: unknown) {
      if (key === options.failProvideKey) throw new Error('Service provision failed')
      provided.push(key)
      services.set(key, value)
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
    tools, provided, services, injections, effects, disposeEffects }
}

function infoRequest(payload: unknown, init: RequestInit = {}) {
  return new Request('https://example.test/api/pdf.info', {
    method: 'POST', headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(payload), ...init,
  })
}

test('Host plugin installs its authenticated routes, tools, services and isolated domains', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host()
  assert.equal(name, 'pdf-reader')
  assert.deepEqual(inject, ['connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain',
    'loader', 'tools', 'pdfNative', 'subprocess'])
  await apply(runtime.ctx, runtime.config, assets)
  try {
    assert.equal(runtime.routes.size, 14)
    assert.deepEqual(runtime.registrations, [
      '/api/pdf.dispatch.v2', '/api/pdf.watch', '/api/pdf.native', '/api/pdf.position',
      '/api/pdf.translation', '/api/pdf.ocr', '/api/pdf.region', '/api/pdf.selection',
      '/api/pdf.readercontext', '/api/pdf.navigation', '/api/pdf.evidence',
      '/api/pdf-assets/ocr/bridge.js', '/api/pdf.info', '/api/pdf.engines',
    ])
    assert.deepEqual(runtime.opened.map(domain => domain.split('_').slice(0, 2).join('_')),
      ['pdf_drafts', 'pdf_positions', 'pdf_evidence', 'pdf_retrieval'])
    assert.deepEqual(runtime.provided, ['pdfTranslation', 'pdfEmbedding', 'pdfAiSettings', 'pdfCapabilities', 'pdf', 'pdfImageEvidence'])
    assert.ok(runtime.tools.includes('pdf_open'))
    assert.ok(runtime.tools.includes('pdf_read_page'))
    assert.ok(runtime.tools.includes('pdf_find_related'))
    assert.ok(runtime.tools.includes('pdf_navigate'))
    assert.deepEqual(runtime.injections, [['ocr'], ['imageUnderstanding'], ['systemPrompt']])
    assert.equal(runtime.effects.length, 10)

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

test('Host settings bootstrap reads a profile with retired form configuration without reviving that engine', async t => {
  const assets = await assetFixture(t), runtime = host()
  const active = { ocr: { 'fixture.ocr': { language: 'auto' } },
    image: { 'fixture.image': { model: 'fixture-vision' } },
    translation: { 'fixture.translation': { language: 'zh' } } }
  const config = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({
    engineConfigurations: { ...active, form: { 'fixture.forms': { model: 'retired' } } },
  })
  await apply(runtime.ctx, config, assets)
  try {
    const response = await runtime.routes.get('/api/pdf.info')!.fetch(infoRequest({
      type: 'client-request', method: 'pdf.info', rpcId: 'retired-form-settings',
    }))
    const body = await response.json() as { result: { ok: boolean; value: {
      settings: { engineConfigurations: unknown }; engineCatalog: { engines: Record<string, unknown> }
    } } }
    assert.equal(body.result.ok, true)
    assert.deepEqual(body.result.value.settings.engineConfigurations, active)
    assert.equal('form' in body.result.value.engineCatalog.engines, false)
    assert.equal(runtime.services.has('formUnderstanding'), false)
  } finally { await runtime.disposeEffects() }
})

test('Host watch endpoint validates document and revision before waiting for a working copy', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host({ agentSessionId: 'watch-session' })
  await apply(runtime.ctx, runtime.config, assets)
  try {
    const route = runtime.routes.get('/api/pdf.watch')!
    async function watch(payload: Record<string, unknown>) {
      const response = await route.fetch(infoRequest({ type: 'client-request', method: 'pdf.watch',
        rpcId: 'watch-test', payload }))
      return (await response.json() as { result: { ok: boolean; error?: { code: string } } }).result
    }
    for (const payload of [
      { sessionId: 'watch-session', id: '', knownRevision: 0 },
      { sessionId: 'watch-session', id: 'missing', knownRevision: -1 },
      { sessionId: 'watch-session', id: 'missing', knownRevision: 1.5 },
    ]) {
      assert.deepEqual((await watch(payload)).error?.code, 'pdf/invalid-request')
    }
    const missing = await watch({ sessionId: 'watch-session', id: 'missing', knownRevision: 0 })
    assert.equal(missing.ok, false)
  } finally { await runtime.disposeEffects() }
})

test('engine catalog metadata needs no resource session and rejects malformed revisions or cancelled watches', async t => {
  const assets = await assetFixture(t), runtime = host()
  await apply(runtime.ctx, runtime.config, assets)
  const route = runtime.routes.get('/api/pdf.engines')!
  const read = (payload?: unknown, signal?: AbortSignal) => route.fetch(infoRequest({
    type: 'client-request', method: 'pdf.engines', rpcId: 'engine-catalog-test',
    ...(payload === undefined ? {} : { payload }),
  }, { signal }))
  try {
    const response = await read()
    const initial = await response.json() as { result: { ok: boolean; value: { revision: string; engines: { translation: unknown[] } } } }
    assert.equal(initial.result.ok, true)
    assert.equal(initial.result.value.engines.translation.length, 1)
    for (const input of [null, 'invalid', [], { extra: true }, { revision: 1 }, { revision: 'x'.repeat(129) }]) {
      const rejected = await read(input)
      assert.equal((await rejected.json() as { result: { ok: boolean } }).result.ok, false)
    }
    const controller = new AbortController(), pending = read({ revision: initial.result.value.revision }, controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    assert.equal((await pending).status, 499)
  } finally { await runtime.disposeEffects() }
})

test('Reader OCR route binds its configured engine rather than borrowing the generic service default', async t => {
  const assets = await assetFixture(t), runtime = host({ agentSessionId: 'engine-session' })
  await apply(runtime.ctx, runtime.config, assets)
  let observed: unknown
  runtime.services.set('ocr', {
    async availability(_session: string, _signal: AbortSignal, binding: unknown) {
      observed = binding; return { status: 'available' }
    },
    selectedDescriptor() { return undefined },
  })
  try {
    const route = runtime.routes.get('/api/pdf.ocr')!
    const response = await route.fetch(infoRequest({ type: 'client-request', method: 'pdf.ocr', rpcId: 'engine-ocr',
      payload: { action: 'availability', sessionId: 'engine-session' } }))
    assert.equal((await response.json() as { result: { ok: boolean } }).result.ok, true)
    assert.deepEqual(observed, { engineId: 'session-llm', config: {} })
  } finally { await runtime.disposeEffects() }
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

    const evidence = runtime.routes.get('/api/pdf.evidence')!
    const crossSession = await evidence.fetch(infoRequest({ type: 'client-request', method: 'pdf.evidence', rpcId: 'evidence',
      payload: { action: 'revalidate', sessionId: 'session-b' } }))
    const crossSessionResult = await crossSession.json() as { result: { ok: boolean; error: { code: string } } }
    assert.equal(crossSessionResult.result.ok, false)
    assert.equal(crossSessionResult.result.error.code, 'pdf/session-mismatch')

    const excerpt = '中文'.repeat(4_000)
    const replay = { type: 'client-request', method: 'pdf.evidence', rpcId: 'multibyte-replay',
      payload: { action: 'revalidate', sessionId: 'session-a', documentId: 'missing-document',
        sourcePathDigest: evidenceSha256('/paper.pdf'), page: 1,
        pageTextDigest: evidenceSha256(excerpt), startUtf16: 0, endUtf16: excerpt.length,
        excerpt, excerptSha256: evidenceSha256(excerpt) } }
    assert.ok(Buffer.byteLength(JSON.stringify(replay), 'utf8') > 16 * 1024)
    const replayResponse = await evidence.fetch(infoRequest(replay))
    assert.equal(replayResponse.status, 200, 'a valid 8,000-character Chinese excerpt must reach Host validation')
    const replayResult = await replayResponse.json() as { result: { ok: boolean; error: { code: string } } }
    assert.equal(replayResult.result.ok, false)
    assert.equal(replayResult.result.error.code, 'pdf/unknown-document',
      'a missing document is rejected by authorization, not by the HTTP byte limit')
    const tooLarge = await evidence.fetch(infoRequest(replay, { headers: {
      'content-type': 'application/json', 'content-length': String(64 * 1024 + 1),
    } }))
    assert.equal(tooLarge.status, 413, 'the enlarged route still enforces a finite request budget')
  } finally { await runtime.disposeEffects() }
})

test('Host image evidence resolver binds each request to a live matching Session and attachment service', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host()
  await apply(runtime.ctx, runtime.config, assets)
  try {
    const resolver = runtime.services.get('pdfImageEvidence') as {
      resolve(sessionId: string, documentId: string, refId: string, signal: AbortSignal): Promise<unknown>
    }
    assert.ok(resolver)
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(resolver.resolve('session-a', 'doc-a', 'pdfref_00000000-0000-4000-8000-000000000000',
      cancelled.signal), /abort/i)
    await assert.rejects(resolver.resolve('session-a', 'doc-a', 'pdfref_00000000-0000-4000-8000-000000000000',
      new AbortController().signal), /No active agent/)
  } finally { await runtime.disposeEffects() }

  const mismatch = host({ agentSessionId: 'session-a', resolvedAgentId: 'session-b' })
  await apply(mismatch.ctx, mismatch.config, assets)
  try {
    const resolver = mismatch.services.get('pdfImageEvidence') as {
      resolve(sessionId: string, documentId: string, refId: string, signal: AbortSignal): Promise<unknown>
    }
    await assert.rejects(resolver.resolve('session-a', 'doc-a', 'pdfref_00000000-0000-4000-8000-000000000000',
      new AbortController().signal), { code: 'pdf/session-mismatch' })
  } finally { await mismatch.disposeEffects() }

  const unavailable = host({ agentSessionId: 'session-a' })
  await apply(unavailable.ctx, unavailable.config, assets)
  try {
    const resolver = unavailable.services.get('pdfImageEvidence') as {
      resolve(sessionId: string, documentId: string, refId: string, signal: AbortSignal): Promise<unknown>
    }
    await assert.rejects(resolver.resolve('session-a', 'doc-a', 'pdfref_00000000-0000-4000-8000-000000000000',
      new AbortController().signal), { code: 'pdf/attachment-unavailable' })
  } finally { await unavailable.disposeEffects() }

  const mounted = host({ agentSessionId: 'session-a', attachments: { async readImage() { throw new Error('unused') } } })
  await apply(mounted.ctx, mounted.config, assets)
  try {
    const resolver = mounted.services.get('pdfImageEvidence') as {
      resolve(sessionId: string, documentId: string, refId: string, signal: AbortSignal): Promise<unknown>
    }
    await assert.rejects(resolver.resolve('session-a', 'missing-document',
      'pdfref_00000000-0000-4000-8000-000000000000', new AbortController().signal),
    { code: 'pdf/unknown-document' })
  } finally { await mounted.disposeEffects() }
})

test('Host bootstrap closes earlier domains when opening navigation, evidence or retrieval storage fails', async (t) => {
  const assets = await assetFixture(t)
  for (const failOpenAt of [2, 3, 4]) {
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
  assert.equal(runtime.closed.length, runtime.opened.length, 'a second teardown must not close domains twice')
  await runtime.disposeEffects().catch(() => undefined)
})
