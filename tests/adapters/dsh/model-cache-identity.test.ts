import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { sessionModelCacheIdentity, type SessionModelInfo } from '../../../src/adapters/host/dsh/model-cache-identity.ts'
import { createSessionLlmOcrBackend, type SessionOcrLlm } from '../../../src/adapters/host/dsh/ocr-session-llm.ts'
import { createDshVisionBackend } from '../../../src/adapters/host/dsh/image-backends.ts'
import { createPdfPageContent } from '../../../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../../../src/adapters/host/dsh/retrieval.ts'
import { HostOcrService } from '../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../src/modules/image-understanding/index.ts'
import { createMemoryEvidenceReferenceStore } from '../../../src/modules/evidence/index.ts'
import { EmbeddingRegistry } from '../../../src/embedding/index.ts'
import { defaultSettings } from '../../../src/shared/contracts.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
const route = { provider: 'fixture-provider', model: 'fixture-vision' }
const metadata: SessionModelInfo = { provider: route.provider, id: route.model, inputModalities: ['text', 'image'],
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
const controls = { system: 'fixture instructions', maxOutputTokens: 4096 }

/** Real Cordis services deliberately return a fresh contextual proxy on every get(). */
class FixtureLlm extends Service implements SessionOcrLlm {
  calls = 0
  constructor(ctx: Context) { super(ctx, 'llm') }
  async resolveModelInfo(): Promise<SessionModelInfo> { return structuredClone(metadata) }
  stream(_options: Parameters<SessionOcrLlm['stream']>[0]): ReturnType<SessionOcrLlm['stream']> {
    this.calls++
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'A needle appears in the scanned page.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}
const getLlm = (ctx: Context) => ctx.get('llm') as unknown as SessionOcrLlm

test('model cache identity survives fresh Cordis proxies and caller contexts for one service', async () => {
  const ctx = new Context()
  new FixtureLlm(ctx)
  try {
    const first = getLlm(ctx), second = getLlm(ctx), child = getLlm(ctx.extend({}))
    assert.notEqual(first, second, 'the fixture must exercise real fresh Cordis service proxies')
    assert.notEqual(first, child)
    const identity = sessionModelCacheIdentity(first, route, metadata, controls)
    assert.deepEqual(sessionModelCacheIdentity(second, route, metadata, controls), identity)
    assert.deepEqual(sessionModelCacheIdentity(child, route, metadata, controls), identity)
  } finally { await ctx.fiber.dispose() }
})

test('replacing the actual Cordis service changes model cache identity', async () => {
  const ctx = new Context(), replacementContext = new Context()
  new FixtureLlm(ctx)
  const replacement = new FixtureLlm(replacementContext)
  try {
    const before = sessionModelCacheIdentity(getLlm(ctx), route, metadata, controls)
    ctx.set('llm', replacement)
    const after = sessionModelCacheIdentity(getLlm(ctx), route, metadata, controls)
    assert.notDeepEqual(after, before)
    assert.deepEqual(sessionModelCacheIdentity(getLlm(ctx), route, metadata, controls), after)
  } finally { await ctx.fiber.dispose(); await replacementContext.fiber.dispose() }
})

test('route, effort, metadata and request controls still invalidate one Cordis service cache identity', async () => {
  const ctx = new Context()
  new FixtureLlm(ctx)
  try {
    const runtime = getLlm(ctx), baseline = sessionModelCacheIdentity(runtime, route, metadata, controls)
    for (const changed of [
      sessionModelCacheIdentity(runtime, { ...route, provider: 'other-provider' }, metadata, controls),
      sessionModelCacheIdentity(runtime, { ...route, model: 'other-model' }, metadata, controls),
      sessionModelCacheIdentity(runtime, { ...route, reasoningEffort: 'high' }, metadata, controls),
      sessionModelCacheIdentity(runtime, route, { ...metadata, defaultMaxTokens: 8192 }, controls),
      sessionModelCacheIdentity(runtime, route, metadata, { ...controls, maxOutputTokens: 2048 }),
    ]) assert.notDeepEqual(changed, baseline)
  } finally { await ctx.fiber.dispose() }
})

test('ordinary runtimes and invalid original markers retain their own stable identity, including callable targets', () => {
  const plain = {}, nullOriginal = { [symbols.original]: null }, primitiveOriginal = { [symbols.original]: 1 }
  const identities = [plain, nullOriginal, primitiveOriginal].map(runtime => {
    const identity = sessionModelCacheIdentity(runtime, route, metadata, controls)
    assert.deepEqual(sessionModelCacheIdentity(runtime, route, metadata, controls), identity)
    return identity
  })
  assert.equal(new Set(identities.map(identity => JSON.stringify(identity))).size, 3)
  const callable = () => undefined
  const first = { [symbols.original]: callable }, second = { [symbols.original]: callable }
  assert.deepEqual(sessionModelCacheIdentity(first, route, metadata, controls),
    sessionModelCacheIdentity(second, route, metadata, controls))
})

for (const mode of ['ocr', 'image'] as const) test(`${mode} indexing completes through real Cordis model service proxies and remains searchable`, async () => {
  const ctx = new Context(), llm = new FixtureLlm(ctx)
  const ocr = new HostOcrService(() => 'session-llm')
  const image = new HostImageUnderstandingService(() => 'dsh-vision')
  const attachments = { async saveImage() {
    return { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 24, width: 200, height: 300 }
  } }
  ocr.register(createSessionLlmOcrBackend({ getLlm: () => getLlm(ctx), getAttachments: () => attachments,
    async resolveModel() { return route } }))
  image.register(createDshVisionBackend({ getLlm: () => getLlm(ctx), getAttachments: () => attachments,
    selectedModel: () => route }))
  const bytes = new Uint8Array([1, 2, 3])
  const snapshot = (): HostWorkspaceSnapshot => ({ id: 'doc', path: '/scanned.pdf', bytes,
    sourceVersion: 'disk-one', contentVersion: 'content-one', revision: 0,
    dirty: false, conflict: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [{ page: 1, userUnit: 1, rotation: 0, mediaBox: [0, 0, 200, 300], cropBox: [0, 0, 200, 300] }],
      annotations: [], signed: false, encrypted: false, readOnly: false } })
  const workspaces = { readSnapshot: snapshot }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText() { return { snapshot: snapshot(), content: { items: [], styles: {}, lang: null } } },
    async renderOcrImage() {
      const png = Buffer.alloc(24)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12)
      png.writeUInt32BE(200, 16); png.writeUInt32BE(300, 20)
      return { snapshot: snapshot(), png, width: 200, height: 300, pdfRegion: [0, 0, 200, 300] }
    },
  }
  const settings = { ...defaultSettings, ocrEngine: 'session-llm', imageEngine: 'dsh-vision',
    embeddingEngine: 'fixture', indexScanPages: mode === 'ocr', indexImageDescriptions: mode === 'image' }
  const embeddings = new EmbeddingRegistry()
  embeddings.register({ descriptor: { id: 'fixture', name: 'Fixture', version: '1', execution: 'local' },
    describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1', dimensions: 2,
      maxBatchSize: 16, maxInputCharacters: 1200, encoding: 'fixture', fingerprint: 'embedding-v1' }),
    async embed(request) { return request.texts.map(() => [1, 0]) } })
  const content = createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image })
  const retrieval = createPdfRetrieval(workspaces, pages, createMemoryEvidenceReferenceStore(), {
    settings: () => settings, embeddings, content,
  })
  try {
    const progress: { indexedPages: number; embeddedChunks: number; phase?: string }[] = []
    await retrieval.prepare('session', { documentId: 'doc' }, signal, value => { progress.push(value) })
    assert.equal(progress.at(-1)?.indexedPages, 1)
    assert.ok((progress.at(-1)?.embeddedChunks ?? 0) > 0)
    assert.equal(progress.at(-1)?.phase, 'ready')
    assert.equal(llm.calls, 1)
    const found = await retrieval.search('session', { documentId: 'doc', query: 'needle', mode: 'semantic' }, signal)
    assert.equal(found.status, 'complete')
    assert.equal(found.candidates.length, 1)
    assert.equal(found.candidates[0]?.source, mode === 'ocr' ? 'ocr-text' : 'image-description')
    assert.match(found.candidates[0]!.quote, /needle/)
    assert.equal(found.coverage.failedPages.length, 0)
    await retrieval.prepare('session', { documentId: 'doc' }, signal)
    assert.equal(llm.calls, 1, 'stable model proxies reuse the prepared index without another model call')
  } finally {
    await retrieval.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose(); await ctx.fiber.dispose()
  }
})
