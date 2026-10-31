import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { PDFDocument } from 'pdf-lib'
import { apply, inject, name } from '../../src/entrypoints/reader-host.ts'
import { Config, type HostConfig } from '../../src/entrypoints/reader-host-config.ts'
import { defaultSettings } from '../../src/shared/contracts.ts'
import { evidenceSha256 } from '../../src/modules/evidence/index.ts'
import { nativeTestSubprocess } from '../native-test-subprocess.ts'
import type { PdfImageEvidenceResolver } from '../../src/adapters/host/dsh/index.ts'
import type { SavedImageReference } from '../../src/modules/evidence/index.ts'
import { EmbeddingError, type EmbeddingEngine, type EmbeddingRegistry } from '../../src/embedding/index.ts'

type Route = Parameters<Parameters<typeof apply>[0]['connection']['fetch']['register']>[0]
type HostContext = Parameters<typeof apply>[0]
type RegisteredTool = { name: string; execute(input: unknown, execution: {
  agent: { session: { id: string; header: {} } }; signal: AbortSignal
}): Promise<unknown> }

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
  const registeredTools = new Map<string, RegisteredTool>()
  const domainValues = new Map<string, Map<string, unknown>>()
  const provided: string[] = []
  const services = new Map<string, unknown>()
  const injections: string[][] = []
  const effects: { label: string; dispose?: () => void | Promise<void> }[] = []
  const configListeners = new Set<(paths: readonly (readonly string[])[]) => void>()
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
    on(event: string, listener: (paths: readonly (readonly string[])[]) => void) {
      if (event === 'loader/volatile-update') configListeners.add(listener)
      return () => { if (event === 'loader/volatile-update') configListeners.delete(listener) }
    },
    storageDomain: { async open(definition: { name: string }) {
      if (opened.length + 1 === options.failOpenAt) throw new Error('Domain open failed')
      opened.push(definition.name)
      const values = new Map<string, unknown>()
      domainValues.set(definition.name, values)
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
    tools: { register(tool: RegisteredTool) { tools.push(tool.name); registeredTools.set(tool.name, tool) } },
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
    tools, registeredTools, domainValues, provided, services, injections, effects, disposeEffects, configListeners,
    configChanged(paths: readonly (readonly string[])[]) { for (const listener of [...configListeners]) listener(paths) } }
}

async function openSyntheticDocument(runtime: ReturnType<typeof host>, assetRoot: string, sessionId: string, text?: string) {
  const root = await realpath(assetRoot), path = join(root, 'evidence.pdf')
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([200, 200])
  if (text) page.drawText(text, { x: 10, y: 160, size: 10 })
  const bytes = await pdf.save()
  await writeFile(path, bytes)
  runtime.ctx.fs = {
    async resolve(input, options) {
      const absolute = resolve(options?.cwd ?? root, input)
      assert.equal(absolute, path)
      return { targetKey: absolute, displayPath: absolute }
    },
    processPath: target => String(target.targetKey),
    processPathFromHostPath: input => input,
    contains: (parent, child) => parent.targetKey === child.targetKey,
    async stat(target) {
      const content = await readFile(String(target.targetKey))
      return { type: 'file', version: evidenceSha256(content), size: content.length }
    },
    async readBytes(target, signal, maxBytes) {
      const content = await readFile(String(target.targetKey), { signal })
      assert.ok(content.length <= maxBytes)
      return content
    },
  }
  runtime.ctx.sandboxPolicy = { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }
  const opened = await runtime.registeredTools.get('pdf_open')!.execute({ path }, {
    agent: { session: { id: sessionId, header: {} } }, signal: new AbortController().signal,
  }) as { documentId: string; contentVersion: string; revision: number }
  return { ...opened, path, bytes }
}

function infoRequest(payload: unknown, init: RequestInit = {}) {
  return new Request('https://example.test/api/pdf.info', {
    method: 'POST', headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(payload), ...init,
  })
}

const indexingWorker = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
async function waitForIndexing(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await condition()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(await condition(), 'background indexing did not reach its expected state')
}
function indexingEngine(embed: EmbeddingEngine['embed']): EmbeddingEngine {
  return { descriptor: { id: 'fixture', name: 'Fixture', version: '1', execution: 'local' },
    describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1',
      fingerprint: 'fixture-index', encoding: 'fixture', dimensions: 2, maxBatchSize: 8, maxInputCharacters: 16000 }), embed }
}

test('opening a PDF starts shared background indexing without a synthetic query or delaying open', { skip: !existsSync(indexingWorker) }, async t => {
  const assets = await assetFixture(t), sessionId = 'preindex-owner', runtime = host({ agentSessionId: sessionId })
  runtime.ctx.pdfNative.executable = indexingWorker
  const config = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({ embeddingEngine: 'fixture' })
  await apply(runtime.ctx, config, assets)
  const purposes: string[] = []
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  ;(runtime.services.get('pdfEmbedding') as EmbeddingRegistry).register(indexingEngine(async request => {
    purposes.push(request.purpose)
    if (request.purpose === 'document') await gate
    return request.texts.map(() => [1, 0])
  }))
  try {
    const opened = await openSyntheticDocument(runtime, assets, sessionId, 'An atomic transaction rolls back changes.')
    await waitForIndexing(() => purposes.length > 0)
    assert.deepEqual(purposes, ['document'], 'opening completes while document vectors are still pending')
    const execution = { agent: { session: { id: sessionId, header: {} } }, signal: new AbortController().signal }
    const service = runtime.services.get('pdf') as { dispatch(session: string, input: unknown, agent: unknown, signal: AbortSignal): Promise<{ id: string }> }
    const ui = await service.dispatch(sessionId, { action: 'open', sessionId, owner: 'ui', referenceId: 'reader-view',
      address: `dsh-resource://file/session/${sessionId}/${opened.path}` }, execution.agent, execution.signal)
    assert.equal(ui.id, opened.documentId, 'UI takes over the same working copy')
    finish()
    const search = await runtime.registeredTools.get('pdf_semantic_search')!.execute({ documentId: opened.documentId, query: 'rollback' }, execution) as { status: string }
    assert.equal(search.status, 'complete')
    assert.equal(purposes.filter(purpose => purpose === 'document').length, 1)
    assert.equal(purposes.filter(purpose => purpose === 'query').length, 1)
  } finally { finish(); await runtime.disposeEffects() }
  assert.equal(runtime.configListeners.size, 0)
})

test('document index choices survive global edits and wait for explicit processing before reset can resume them', { skip: !existsSync(indexingWorker) }, async t => {
  const assets = await assetFixture(t), sessionId = 'preindex-settings', runtime = host({ agentSessionId: sessionId })
  runtime.ctx.pdfNative.executable = indexingWorker
  await apply(runtime.ctx, runtime.config, assets)
  const calls: AbortSignal[] = []
  let finishSecond!: () => void
  const secondGate = new Promise<void>(resolve => { finishSecond = resolve })
  ;(runtime.services.get('pdfEmbedding') as EmbeddingRegistry).register(indexingEngine(async request => {
    assert.equal(request.purpose, 'document', 'background preparation must never invent a query')
    calls.push(request.signal)
    if (calls.length === 1) await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
    })
    if (calls.length === 2) await secondGate
    return request.texts.map(() => [1, 0])
  }))
  const changeEngine = (engine: string) => {
    const next = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({ embeddingEngine: engine })
    updateVolatile(runtime.config.embeddingEngine, next.embeddingEngine)
    runtime.configChanged([['embeddingEngine']])
  }
  const control = async (payload: unknown) => {
    const response = await runtime.routes.get('/api/pdf.indexing')!.fetch(infoRequest({
      type: 'client-request', method: 'pdf.indexing', rpcId: 'policy-control', payload,
    }))
    const body = await response.json() as { result: { ok: boolean; value: {
      tasks: Array<{ documentId: string; state: string }>; documents: Array<{
      documentId: string; revision: number; pending: boolean; policy: { embeddingEngine: string; ocrEngine: string;
        imageEngine: string; indexScanPages: boolean; indexImageDescriptions: boolean }; activePolicy: { embeddingEngine: string }
    }> } } }
    assert.equal(body.result.ok, true)
    return body.result.value
  }
  try {
    const opened = await openSyntheticDocument(runtime, assets, sessionId, 'Prepare this already opened document in the background.')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls.length, 0, 'disabled semantic retrieval must not process document text')
    changeEngine('fixture')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls.length, 0, 'new global defaults do not change a PDF that is already open')
    const settings = (await control({ action: 'status', sessionId })).documents[0]!
    assert.equal(settings.policy.embeddingEngine, 'none')
    const configured = await control({ action: 'configure', sessionId, documentId: opened.documentId,
      revision: settings.revision, policy: { ...settings.policy, embeddingEngine: 'fixture' } })
    assert.equal(configured.documents[0]!.pending, true)
    assert.equal(calls.length, 0, 'saving a new document policy does not start expensive work')
    await control({ action: 'start', sessionId, documentId: opened.documentId })
    await waitForIndexing(() => calls.length === 1)
    changeEngine('none')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls[0]!.aborted, false, 'changing global defaults does not cancel the document-owned build')
    await control({ action: 'cancel', sessionId, documentId: opened.documentId })
    await waitForIndexing(() => calls[0]!.aborted)
    await control({ action: 'start', sessionId, documentId: opened.documentId })
    await waitForIndexing(() => calls.length === 2)
    const building = await control({ action: 'status', sessionId })
    assert.equal(building.tasks.find(task => task.documentId === opened.documentId)!.state, 'running')
    assert.equal(building.documents[0]!.pending, true, 'embedding admission is not a ready index')
    assert.equal(building.documents[0]!.activePolicy.embeddingEngine, 'none')
    finishSecond()
    await waitForIndexing(async () => {
      const ready = await control({ action: 'status', sessionId })
      const document = ready.documents.find(document => document.documentId === opened.documentId)!
      return ready.tasks.some(task => task.documentId === opened.documentId && task.state === 'ready')
        && !document.pending && document.activePolicy.embeddingEngine === 'fixture'
    })
    const reset = await runtime.routes.get('/api/pdf.retrieval.rebuild')!.fetch(infoRequest({
      type: 'client-request', method: 'pdf.retrieval.rebuild', rpcId: 'reset-prefetch', payload: {},
    }))
    const body = await reset.json() as { result: { ok: boolean } }
    assert.equal(body.result.ok, true)
    await waitForIndexing(() => calls.length === 3)
  } finally { finishSecond(); await runtime.disposeEffects() }
  assert.equal(runtime.configListeners.size, 0)
})

test('indexing controls use the resource Session and a long poll reauthorizes before publishing task names', async t => {
  const assets = await assetFixture(t), sessionId = 'indexing-controls', runtime = host({ agentSessionId: sessionId })
  const config = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({ embeddingEngine: 'fixture' })
  await apply(runtime.ctx, config, assets)
  const signals: AbortSignal[] = []
  const engine = indexingEngine(async () => { throw new Error('No text embedding should be admitted before availability finishes') })
  ;(runtime.services.get('pdfEmbedding') as EmbeddingRegistry).register({ ...engine,
    async availability(_config, signal) {
      signals.push(signal)
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve() })
      return { status: 'unavailable' }
    },
  })
  const call = async (payload: unknown) => {
    const response = await runtime.routes.get('/api/pdf.indexing')!.fetch(infoRequest({
      type: 'client-request', method: 'pdf.indexing', rpcId: 'indexing-fixture', payload,
    }))
    return (await response.json() as { result: { ok: boolean; value?: { revision: string; tasks: Array<{ documentId: string; title: string; state: string }> }; error?: { code: string } } }).result
  }
  try {
    const opened = await openSyntheticDocument(runtime, assets, sessionId)
    await waitForIndexing(() => signals.length === 1)
    const current = await call({ action: 'status', sessionId })
    assert.equal(current.value!.tasks[0]!.documentId, opened.documentId)
    assert.equal(current.value!.tasks[0]!.title, 'evidence.pdf')
    assert.equal((await call({ action: 'cancel', sessionId: 'another-session', documentId: opened.documentId })).error!.code, 'pdf/session-mismatch')
    const cancelled = await call({ action: 'cancel', sessionId, documentId: opened.documentId })
    assert.equal(cancelled.value!.tasks[0]!.state, 'cancelled')
    await waitForIndexing(() => signals[0]!.aborted)
    await call({ action: 'start', sessionId, documentId: opened.documentId })
    await waitForIndexing(() => signals.length === 2)
    const before = await call({ action: 'status', sessionId })
    const watching = call({ action: 'status', sessionId, revision: before.value!.revision })
    await new Promise<void>(resolve => setImmediate(resolve))
    t.mock.method(runtime.ctx.sessionController, 'resolveAgent', async () => ({ error: new Error('Session retired') }))
    const disabled = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({ embeddingEngine: 'none' })
    updateVolatile(config.embeddingEngine, disabled.embeddingEngine)
    runtime.configChanged([['embeddingEngine']])
    const rejected = await watching
    assert.equal(rejected.ok, false)
    assert.equal('value' in rejected, false, 'a retired Session cannot receive names/progress from a completed long poll')
  } finally { await runtime.disposeEffects() }
})

test('Host plugin installs its authenticated routes, tools, services and isolated domains', async (t) => {
  const assets = await assetFixture(t)
  const runtime = host()
  assert.equal(name, 'pdf-reader')
  assert.deepEqual(inject, ['connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain',
    'loader', 'tools', 'pdfNative', 'subprocess'])
  await apply(runtime.ctx, runtime.config, assets)
  try {
    assert.equal(runtime.routes.size, 17)
    assert.deepEqual(runtime.registrations, [
      '/api/pdf.dispatch.v2', '/api/pdf.watch', '/api/pdf.native', '/api/pdf.position',
      '/api/pdf.translation', '/api/pdf.ocr', '/api/pdf.region', '/api/pdf.selection',
      '/api/pdf.readercontext', '/api/pdf.navigation', '/api/pdf.indexing', '/api/pdf.evidence',
      '/api/pdf-assets/ocr/bridge.js', '/api/pdf.info', '/api/pdf.engines', '/api/pdf.model-options', '/api/pdf.retrieval.rebuild',
    ])
    assert.deepEqual(runtime.opened.map(domain => domain.split('_').slice(0, 2).join('_')),
      ['pdf_drafts', 'pdf_positions', 'pdf_evidence', 'pdf_retrieval', 'pdf_index'])
    assert.deepEqual(runtime.provided, ['pdfTranslation', 'pdfEmbedding', 'pdfAiSettings', 'pdfCapabilities', 'pdf', 'pdfImageEvidence'])
    assert.ok(runtime.tools.includes('pdf_open'))
    assert.ok(runtime.tools.includes('pdf_page_read'))
    assert.ok(runtime.tools.includes('pdf_semantic_search'))
    assert.ok(runtime.tools.includes('pdf_page_jump'))
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

test('settings model choices reuse the official catalog without an active PDF or conversation mutation', async t => {
  const runtime = host(), assets = await assetFixture(t)
  let reads = 0
  Object.assign(runtime.ctx.sessionController, {
    async modelCatalog() {
      reads++
      return { groups: [{ id: 'provider', name: 'Provider', models: [
        { id: 'text', name: 'Text' }, { id: 'visual', name: 'Visual' },
      ] }], failures: [] }
    },
    selectModel() { assert.fail('PDF model settings must not select a conversation model') },
  })
  runtime.services.set('llm', { async resolveModelInfo(_provider: string, model: string) {
    return { inputModalities: model === 'visual' ? ['text', 'image'] : ['text'] }
  }, stream() { assert.fail('listing models must not run inference') } })
  await apply(runtime.ctx, runtime.config, assets)
  const route = runtime.routes.get('/api/pdf.model-options')!
  const call = (payload: unknown) => route.fetch(infoRequest({
    type: 'client-request', method: 'pdf.model-options', rpcId: 'model-options-test', payload,
  }))
  try {
    const response = await call({})
    const envelope = await response.json() as { result: { ok: boolean; value: unknown } }
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(envelope.result.ok, true)
    assert.deepEqual(envelope.result.value, { groups: [{ id: 'provider', name: 'Provider',
      models: [{ id: 'visual', name: 'Visual' }] }], failures: [] })
    assert.equal(reads, 1)
    const invalid = await (await call({ provider: 'client-invented' })).json() as { result: { ok: boolean } }
    assert.equal(invalid.result.ok, false)
    assert.equal(reads, 1, 'invalid settings requests do not load the Host catalog')
  } finally { await runtime.disposeEffects() }
  assert.equal(runtime.routes.has('/api/pdf.model-options'), false)
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

test('authenticated settings rebuild resets only derived retrieval records without opening a PDF', async t => {
  const assets = await assetFixture(t), runtime = host()
  await apply(runtime.ctx, runtime.config, assets)
  const cache = [...runtime.domainValues].find(([name]) => name.startsWith('pdf_retrieval_'))![1]
  const drafts = [...runtime.domainValues].find(([name]) => name.startsWith('pdf_drafts_'))![1]
  drafts.set('unchanged-draft', { revision: 7, dirty: true })
  const call = (payload: unknown) => runtime.routes.get('/api/pdf.retrieval.rebuild')!.fetch(infoRequest({
    type: 'client-request', method: 'pdf.retrieval.rebuild', rpcId: 'rebuild', payload,
  }))
  try {
    cache.set('derived-vector', { createdAt: Date.now(), payload: [1, 0] })
    const invalid = await (await call({ documentId: 'unexpected' })).json() as { result: { ok: boolean } }
    assert.equal(invalid.result.ok, false)
    assert.equal(cache.size, 1, 'invalid input cannot clear indexes')
    const response = await call({})
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json() as { result: unknown }
    assert.deepEqual(body.result, { ok: true, value: { status: 'invalidated' } })
    assert.equal(cache.size, 0)
    assert.deepEqual(drafts.get('unchanged-draft'), { revision: 7, dirty: true })
  } finally { await runtime.disposeEffects() }
})

test('rebuild route reports storage failures without claiming success and permits a successful retry', async t => {
  const assets = await assetFixture(t), runtime = host()
  await apply(runtime.ctx, runtime.config, assets)
  const cache = [...runtime.domainValues].find(([name]) => name.startsWith('pdf_retrieval_'))![1]
  cache.set('derived-vector', { createdAt: Date.now(), payload: [1, 0] })
  const deletion = t.mock.method(cache, 'delete', () => { throw new Error('private storage path') })
  const call = () => runtime.routes.get('/api/pdf.retrieval.rebuild')!.fetch(infoRequest({
    type: 'client-request', method: 'pdf.retrieval.rebuild', rpcId: 'rebuild', payload: {},
  }))
  try {
    const body = await (await call()).json() as { result: { ok: boolean; error: { code: string; message: string } } }
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'pdf/retrieval-rebuild-failed')
    assert.equal(JSON.stringify(body).includes('private storage path'), false)
    deletion.mock.restore()
    const retried = await (await call()).json() as { result: { ok: boolean } }
    assert.equal(retried.result.ok, true)
    assert.equal(cache.size, 0)
  } finally { await runtime.disposeEffects() }
})

test('Host embedding resolves optional credentials per operation, including rotation and provider removal', async t => {
  const assets = await assetFixture(t), runtime = host()
  const authorizations: Array<string | null> = [], references: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'https://embedding.example/v1/models') {
      return new Response(JSON.stringify({ data: [{ id: 'fixture' }] }),
        { headers: { 'content-type': 'application/json' } })
    }
    authorizations.push(new Headers(init?.headers).get('authorization'))
    assert.equal(String(input), 'https://embedding.example/v1/embeddings')
    return new Response(JSON.stringify({ model: 'fixture', data: [{ index: 0, embedding: [3, 4] }] }),
      { headers: { 'content-type': 'application/json' } })
  })
  await apply(runtime.ctx, runtime.config, assets)
  const registry = runtime.services.get('pdfEmbedding') as EmbeddingRegistry
  const config = { endpoint: 'https://embedding.example/v1/embeddings', model: 'fixture',
    dimensions: 2, queryInstruction: '' }
  const binding = { engineId: 'local-qwen3-embedding', config }
  try {
    assert.deepEqual((await registry.embed({ texts: ['document'], purpose: 'document' }, binding)).vectors, [[0.6, 0.8]])
    assert.deepEqual(authorizations, [null], 'a keyless service must work without the optional credential seam')

    const authenticated = { ...binding, config: { ...config, apiKeyRef: 'PDF_EMBEDDING_KEY' } }
    let value = 'first-key'
    runtime.services.set('credentials', { async resolve(reference: string) {
      references.push(reference)
      return { value }
    } })
    await registry.embed({ texts: ['document'], purpose: 'document' }, authenticated)
    value = 'rotated-key'
    await registry.embed({ texts: ['document'], purpose: 'document' }, authenticated)
    runtime.services.set('credentials', { async resolve(reference: string) {
      references.push(reference)
      return { value: 'replacement-key' }
    } })
    await registry.embed({ texts: ['document'], purpose: 'document' }, authenticated)
    assert.deepEqual(references, Array(3).fill('PDF_EMBEDDING_KEY'))
    assert.deepEqual(authorizations, [null, 'Bearer first-key', 'Bearer rotated-key', 'Bearer replacement-key'])

    runtime.services.delete('credentials')
    await assert.rejects(registry.embed({ texts: ['document'], purpose: 'document' }, authenticated),
      error => error instanceof EmbeddingError && error.code === 'not-configured')
    assert.equal(authorizations.length, 4, 'removing the provider must not reuse the last resolved key')
    runtime.services.set('credentials', { async resolve() { return undefined } })
    await assert.rejects(registry.embed({ texts: ['document'], purpose: 'document' }, authenticated),
      error => error instanceof EmbeddingError && error.code === 'not-configured')
    assert.equal(authorizations.length, 4, 'an unset reference must not fall back to a previous key')
  } finally { await runtime.disposeEffects() }
})

test('Host embedding cancellation during credential resolution sends no document request', async t => {
  const assets = await assetFixture(t), runtime = host()
  let networkRequests = 0, finish!: (result: { value: string }) => void, started!: () => void
  const resolving = new Promise<void>(resolve => { started = resolve })
  const credential = new Promise<{ value: string }>(resolve => { finish = resolve })
  runtime.services.set('credentials', { async resolve() { started(); return credential } })
  t.mock.method(globalThis, 'fetch', async () => { networkRequests++; throw new Error('Unexpected request') })
  await apply(runtime.ctx, runtime.config, assets)
  try {
    const registry = runtime.services.get('pdfEmbedding') as EmbeddingRegistry
    const controller = new AbortController()
    const pending = registry.embed({ texts: ['private document'], purpose: 'document', signal: controller.signal },
      { engineId: 'local-qwen3-embedding', config: { endpoint: 'https://embedding.example/v1/embeddings',
        model: 'fixture', dimensions: 2, queryInstruction: '', apiKeyRef: 'PDF_EMBEDDING_KEY' } })
    await resolving
    controller.abort()
    await assert.rejects(pending, error => error instanceof EmbeddingError && error.code === 'cancelled')
    finish({ value: 'late-key' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(networkRequests, 0)
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

test('Host image evidence resolves persisted attachments and drains an admitted resolution before closing storage', async t => {
  const assets = await assetFixture(t), sessionId = 'image-evidence-session'
  const data = new Uint8Array([137, 80, 78, 71])
  let hold: (() => Promise<void>) | undefined, attachmentSignal: AbortSignal | undefined
  const runtime = host({ agentSessionId: sessionId, attachments: {
    async readImage(ref: { attachmentId: string; mediaType: 'image/png'; bytes: number; width: number; height: number },
      signal: AbortSignal) {
      attachmentSignal = signal
      await hold?.()
      signal.throwIfAborted()
      return { ref, data }
    },
  } })
  await apply(runtime.ctx, runtime.config, assets)
  let resume: (() => void) | undefined
  try {
    const document = await openSyntheticDocument(runtime, assets, sessionId)
    const refId = 'pdfref_00000000-0000-4000-8000-000000000001'
    const saved: SavedImageReference = { sessionId, createdAt: Date.now(), evidence: {
      refId, documentId: document.documentId, sourcePath: document.path,
      sourceDigest: evidenceSha256(document.bytes), sourceVersion: evidenceSha256(document.bytes),
      contentVersion: document.contentVersion, revision: document.revision, page: 1,
      source: 'direct-image', renderedImageSha256: evidenceSha256(data),
      locator: { kind: 'page-only' }, precision: 'page-only', limitations: [],
      snapshot: { kind: 'attachment', attachmentId: evidenceSha256(data), mediaType: 'image/png',
        bytes: data.length, width: 1, height: 1, storedImageSha256: evidenceSha256(data) },
    } }
    const evidenceDomain = runtime.opened.find(domain => domain.startsWith('pdf_evidence_'))!
    runtime.domainValues.get(evidenceDomain)!.set(refId, saved)
    const resolver = runtime.services.get('pdfImageEvidence') as PdfImageEvidenceResolver
    const resolved = await resolver.resolve(sessionId, document.documentId, refId, new AbortController().signal)
    assert.deepEqual(resolved.image, { mediaType: 'image/png', data, width: 1, height: 1 })
    assert.deepEqual(resolved.evidence, saved.evidence)

    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { resume = resolve })
    hold = () => { entered(); return blocked }
    const pending = resolver.resolve(sessionId, document.documentId, refId, new AbortController().signal)
    const cancelled = assert.rejects(pending, { name: 'AbortError' })
    await reading
    const routeEffect = runtime.effects.find(effect => effect.label.startsWith('pdf: routes'))!
    let closed = false
    const closing = Promise.resolve(routeEffect.dispose!()).then(() => { closed = true })
    assert.equal(attachmentSignal!.aborted, true, 'unloading must cancel the admitted attachment read')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, false, 'teardown must wait for the admitted resolver to settle')
    assert.equal(runtime.closed.length, 0, 'evidence storage must remain open while its resolver is active')
    resume!()
    await cancelled
    await closing
    assert.deepEqual(runtime.closed, [...runtime.opened].reverse())
    await assert.rejects(resolver.resolve(sessionId, document.documentId, refId, new AbortController().signal),
      { name: 'AbortError' })
  } finally { resume?.(); await runtime.disposeEffects() }
})

test('Host evidence navigation rechecks the authorized source path and current file before trusting a replayed card', async t => {
  const assets = await assetFixture(t), sessionId = 'evidence-card-session'
  const runtime = host({ agentSessionId: sessionId })
  await apply(runtime.ctx, runtime.config, assets)
  try {
    const document = await openSyntheticDocument(runtime, assets, sessionId)
    const excerpt = 'Historical card excerpt'
    const payload = { action: 'revalidate', sessionId, documentId: document.documentId,
      sourcePathDigest: evidenceSha256(document.path), page: 1, pageTextDigest: evidenceSha256(excerpt),
      startUtf16: 0, endUtf16: excerpt.length, excerpt, excerptSha256: evidenceSha256(excerpt) }
    const revalidate = async (input: typeof payload) => {
      const response = await runtime.routes.get('/api/pdf.evidence')!.fetch(infoRequest({
        type: 'client-request', method: 'pdf.evidence', rpcId: 'replayed-card', payload: input,
      }))
      assert.equal(response.status, 200)
      return (await response.json() as { result: { ok: boolean; error: { code: string; message: string } } }).result
    }
    const wrongPath = await revalidate({ ...payload, sourcePathDigest: evidenceSha256('/another.pdf') })
    assert.equal(wrongPath.ok, false)
    assert.equal(wrongPath.error.code, 'pdf/stale-reader')
    assert.match(wrongPath.error.message, /source path/)

    await writeFile(document.path, new Uint8Array([...document.bytes, 10]))
    const replacedSource = await revalidate(payload)
    assert.equal(replacedSource.ok, false)
    assert.equal(replacedSource.error.code, 'pdf/stale-reader')
    assert.match(replacedSource.error.message, /changed outside this working copy/)
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

test('Host bootstrap closes earlier domains when navigation, evidence, retrieval or index preferences fail to open', async (t) => {
  const assets = await assetFixture(t)
  for (const failOpenAt of [2, 3, 4, 5]) {
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
