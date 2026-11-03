import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { pdfIndexContentDigest } from '../../../src/adapters/host/pdf-lib/content-identity.ts'
import { createRetrievalStore } from '../../../src/adapters/host/filesystem/retrieval-store.ts'
import { sessionModelCacheIdentity, type SessionModelInfo } from '../../../src/adapters/host/dsh/model-cache-identity.ts'
import { createSessionLlmOcrBackend, type SessionOcrLlm } from '../../../src/adapters/host/dsh/ocr-session-llm.ts'
import { createDshVisionBackend } from '../../../src/adapters/host/dsh/image-backends.ts'
import { createPdfPageContent, pageContentDigestBytes } from '../../../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../../../src/adapters/host/dsh/retrieval.ts'
import { HostOcrService } from '../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../src/modules/image-understanding/index.ts'
import { createMemoryEvidenceReferenceStore } from '../../../src/modules/evidence/index.ts'
import { EmbeddingRegistry, type EmbeddingEngine } from '../../../src/embedding/index.ts'
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
  vision = true
  constructor(ctx: Context) { super(ctx, 'llm') }
  async resolveModelInfo(provider: string, id: string): Promise<SessionModelInfo> {
    return { ...structuredClone(metadata), provider, id, inputModalities: this.vision ? ['text', 'image'] : ['text'] }
  }
  stream(_options: Parameters<SessionOcrLlm['stream']>[0]): ReturnType<SessionOcrLlm['stream']> {
    this.calls++
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'A needle appears in the scanned page.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}
const getLlm = (ctx: Context) => ctx.get('llm') as unknown as SessionOcrLlm

test('model identities depend on actual routes, effective effort and request controls', () => {
  const baseline = sessionModelCacheIdentity(route, metadata, controls)
  assert.equal(typeof baseline, 'string')
  for (const changed of [
    sessionModelCacheIdentity({ ...route, provider: 'other-provider' }, metadata, controls),
    sessionModelCacheIdentity({ ...route, model: 'other-model' }, metadata, controls),
    sessionModelCacheIdentity({ ...route, reasoningEffort: 'high' }, metadata, controls),
    sessionModelCacheIdentity(route, { ...metadata, reasoning: { ...metadata.reasoning!, defaultEffort: 'high' } }, controls),
    sessionModelCacheIdentity(route, metadata, { ...controls, maxOutputTokens: 2048 }),
    sessionModelCacheIdentity(route, metadata, { ...controls, system: 'Different instructions' }),
  ]) assert.notEqual(changed, baseline)
  assert.equal(sessionModelCacheIdentity({ ...route, reasoningEffort: 'low' }, metadata, controls), baseline,
    'an explicitly selected effort and the same materialized default execute the same request')
  assert.equal(sessionModelCacheIdentity({ ...route, reasoningEffort: 'low' },
    { ...metadata, reasoning: { efforts: [], defaultEffort: 'high' } }, controls), baseline,
    'an explicit effort does not inherit later model defaults')
  assert.notEqual(sessionModelCacheIdentity(route, { inputModalities: ['image'] }, controls), baseline)
})

test('model display and capability metadata cannot invalidate persisted request results', () => {
  const baseline = sessionModelCacheIdentity(route, metadata, controls)
  const changed: SessionModelInfo = { ...metadata, name: 'Renamed display entry', description: 'Updated model description',
    context: { contextWindow: 20_000 }, defaultMaxTokens: 8192, inputModalities: ['image', 'text'],
    systemPromptUpdate: 'in-history', toolUpdate: 'in-history',
    reasoning: { defaultEffort: 'low', efforts: [{ id: 'high', name: 'More reasoning' }, { id: 'low', name: 'Less reasoning' }] } }
  assert.equal(sessionModelCacheIdentity(route, changed, controls), baseline,
    'these adapters send an explicit output cap and a single image request, independently of display and conversation metadata')
  assert.equal(sessionModelCacheIdentity(route, metadata, { maxOutputTokens: 4096, system: 'fixture instructions' }), baseline)
})

test('default backend identities survive fresh Cordis proxies, new sessions and recreated Host services', async () => {
  const first = new Context(), restarted = new Context()
  new FixtureLlm(first); new FixtureLlm(restarted)
  let owner = first
  const attachments = { async saveImage() { throw new Error('identity checks must not upload an image') } }
  const ocr = () => createSessionLlmOcrBackend({ getLlm: () => getLlm(owner), getAttachments: () => attachments,
    async resolveModel() { return route } })
  const image = () => createDshVisionBackend({ getLlm: () => getLlm(owner), getAttachments: () => attachments,
    selectedModel: () => route })
  try {
    assert.notEqual(getLlm(first), getLlm(first), 'exercise real context-aware service proxies')
    for (const backend of [ocr(), image()]) {
      const before = await backend.cacheIdentity!('old-session', signal)
      owner = first.extend({})
      assert.equal(await backend.cacheIdentity!('new-session', signal), before)
      owner = restarted
      assert.equal(await backend.cacheIdentity!('after-host-restart', signal), before)
      owner = first
    }
    assert.equal(await ocr().cacheIdentity!('new-session', signal), await ocr().cacheIdentity!('old-session', signal))
    assert.equal(await image().cacheIdentity!('new-session', signal), await image().cacheIdentity!('old-session', signal))
  } finally { await first.fiber.dispose(); await restarted.fiber.dispose() }
})

test('cache identity resolves a valid text-only route without attachments but does not accept failed model resolution', async () => {
  let offline = false
  const llm: SessionOcrLlm = {
    async resolveModelInfo() {
      if (offline) throw new Error('model metadata unavailable')
      return { ...metadata, inputModalities: ['text'] }
    },
    async *stream() { throw new Error('identity lookup must not execute a model') },
  }
  const backends = [
    { value: createSessionLlmOcrBackend({ getLlm: () => llm, getAttachments: () => undefined,
      async resolveModel() { return route } }), code: 'engine-unavailable' },
    { value: createDshVisionBackend({ getLlm: () => llm, getAttachments: () => undefined,
      selectedModel: () => route }), code: 'pdf/image-unavailable' },
  ]
  for (const { value, code } of backends) {
    offline = false
    assert.equal(typeof await value.cacheIdentity!('session', signal), 'string')
    offline = true
    await assert.rejects(value.cacheIdentity!('session', signal), { code })
  }
})

for (const scenario of ['current', 'legacy-default', 'legacy-private'] as const)
for (const mode of ['ocr', 'image'] as const) test(`${scenario} ${mode} index survives Host recreation without crossing private backend boundaries`, async t => {
  const legacy = scenario !== 'current', privateBackend = scenario === 'legacy-private'
  const ocrId = privateBackend ? 'private-ocr' : 'session-llm'
  const imageId = privateBackend ? 'private-image' : 'dsh-vision'
  const directory = await mkdtemp(join(tmpdir(), 'pdf-model-identity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let ctx = new Context(), llm = new FixtureLlm(ctx)
  let store = createRetrievalStore({ directory, maxMemoryBytes: 64 * 1024 })
  let ocr = new HostOcrService(() => ocrId)
  let image = new HostImageUnderstandingService(() => imageId)
  let selectedRoute = route, attachmentService = true
  const attachments = { async saveImage() {
    return { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 24, width: 200, height: 300 }
  } }
  const registerBackends = (old: boolean) => {
    const ocrBackend = createSessionLlmOcrBackend({ getLlm: () => getLlm(ctx),
      getAttachments: () => attachmentService ? attachments : undefined,
      async resolveModel() { return selectedRoute } })
    const imageBackend = createDshVisionBackend({ getLlm: () => getLlm(ctx),
      getAttachments: () => attachmentService ? attachments : undefined,
      selectedModel: () => selectedRoute })
    const scoped = old || privateBackend ? {
      cacheIdentity: async () => ({ identity: old ? 'old-runtime' : 'new-runtime', reusable: false as const }),
    } : {}
    ocr.register({ ...ocrBackend, descriptor: { ...ocrBackend.descriptor, id: ocrId }, ...scoped })
    image.register({ ...imageBackend, descriptor: { ...imageBackend.descriptor, id: imageId }, ...scoped })
  }
  registerBackends(legacy)
  const pdf = await PDFDocument.create(); pdf.addPage([200, 300])
  const bytes = await pdf.save()
  const indexContentDigest = pdfIndexContentDigest(await PDFDocument.load(bytes))
  assert.ok(indexContentDigest)
  let modernMetadata = !legacy, authorizedSession = 'session'
  let documentId = 'doc', contentVersion = 'content-one', nativeReads = 0, renders = 0, documentVectors = 0
  const snapshot = (): HostWorkspaceSnapshot => ({ id: documentId, path: '/scanned.pdf', bytes,
    sourceVersion: 'disk-one', contentVersion, revision: 0,
    dirty: false, conflict: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [{ page: 1, userUnit: 1, rotation: 0, mediaBox: [0, 0, 200, 300], cropBox: [0, 0, 200, 300] }],
      annotations: [], signed: false, encrypted: false, readOnly: false,
      ...(modernMetadata ? { indexContentDigest } : {}) } })
  const workspaces = { readSnapshot(sessionId: string, id: string) {
    if (sessionId !== authorizedSession || id !== documentId) {
      throw Object.assign(new Error('Document is not owned by this session'), { code: 'pdf/unknown-document' })
    }
    return snapshot()
  } }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText() { nativeReads++; return { snapshot: snapshot(), content: { items: [], styles: {}, lang: null } } },
    async renderOcrImage() {
      renders++
      const png = Buffer.alloc(24)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12)
      png.writeUInt32BE(200, 16); png.writeUInt32BE(300, 20)
      return { snapshot: snapshot(), png, width: 200, height: 300, pdfRegion: [0, 0, 200, 300] }
    },
  }
  const settings = { ...defaultSettings, ocrEngine: ocrId, imageEngine: imageId,
    embeddingEngine: 'fixture', indexScanPages: mode === 'ocr', indexImageDescriptions: mode === 'image' }
  let embeddings = new EmbeddingRegistry()
  const embeddingBackend: EmbeddingEngine = { descriptor: { id: 'fixture', name: 'Fixture', version: '1', execution: 'local' },
    describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1', dimensions: 2,
      maxBatchSize: 16, maxInputCharacters: 1200, encoding: 'fixture', fingerprint: 'embedding-v1' }),
    async embed(request: { texts: readonly string[]; purpose: string }) {
      if (request.purpose === 'document') documentVectors += request.texts.length
      return request.texts.map(() => [1, 0])
    } }
  embeddings.register(embeddingBackend)
  let content = createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image, cache: store })
  const oldContentPort = { ...content }
  delete oldContentPort.indexIdentity
  let retrieval = createPdfRetrieval(workspaces, pages, createMemoryEvidenceReferenceStore(), {
    settings: () => settings, embeddings, content: legacy ? oldContentPort : content, cache: store,
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
    const firstIdentity = await (mode === 'ocr' ? ocr : image).cacheIdentity('session', signal)
    assert.equal(firstIdentity.reusable, !legacy)
    const firstVectors = documentVectors, firstReads = nativeReads, firstRenders = renders
    let switchedIdentity = firstIdentity
    if (legacy) {
      const aggregate = (await store.scan('pagecontent_')).entries.filter(([key]) => /^pagecontent_[a-f0-9]{64}$/.test(key))
      assert.equal(aggregate.length, 1, 'the old full page aggregate really exists in SQLite')
      const value = aggregate[0]![1]
      assert.ok(value && typeof value === 'object')
      assert.equal('indexContentDigest' in value, false, 'the fixture must use the 0.1.4 record shape')
      assert.ok('extractionIdentity' in value)
      assert.equal(value.extractionIdentity, content.identity('session'))
    }
    selectedRoute = { ...route, model: 'another-conversation-model' }
    if (!legacy) {
      switchedIdentity = await (mode === 'ocr' ? ocr : image).cacheIdentity('model-b-session', signal)
      assert.notEqual(switchedIdentity.fingerprint, firstIdentity.fingerprint,
        'live engine identity must continue detecting a genuinely different execution route')
      authorizedSession = 'model-b-session'
      let switchedPhase: string | undefined
      await retrieval.prepare(authorizedSession, { documentId }, signal, value => { switchedPhase = value.phase })
      assert.equal(switchedPhase, 'ready')
      assert.equal(llm.calls, 1, 'changing the conversation model cannot replace an accepted document index')
      assert.equal(nativeReads, firstReads, 'a model-only switch does not re-extract the PDF')
      assert.equal(documentVectors, firstVectors, 'a model-only switch does not recalculate document embeddings')
    }
    await retrieval.dispose(); content.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose()
    await store.dispose(); await ctx.fiber.dispose()
    ctx = new Context(); llm = new FixtureLlm(ctx)
    llm.vision = false
    store = createRetrievalStore({ directory, maxMemoryBytes: 64 * 1024 })
    ocr = new HostOcrService(() => ocrId); image = new HostImageUnderstandingService(() => imageId)
    attachmentService = false
    registerBackends(false)
    embeddings = new EmbeddingRegistry(); embeddings.register(embeddingBackend)
    documentId = 'reopened-document'; contentVersion = 'new-working-copy-identity'
    modernMetadata = true; authorizedSession = 'new-session'
    content = createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image, cache: store })
    retrieval = createPdfRetrieval(workspaces, pages, createMemoryEvidenceReferenceStore(), {
      settings: () => settings, embeddings, content, cache: store,
    })
    const reopenedIdentity = await (mode === 'ocr' ? ocr : image).cacheIdentity('new-session', signal)
    assert.equal((await (mode === 'ocr' ? ocr : image).availability('new-session', signal)).status, 'unavailable',
      'the current text-only model and missing attachment service remain unavailable for new image processing')
    if (legacy) assert.notEqual(reopenedIdentity.fingerprint, firstIdentity.fingerprint)
    else assert.equal(reopenedIdentity.fingerprint, switchedIdentity.fingerprint)
    assert.notEqual(reopenedIdentity.generation, firstIdentity.generation,
      'persistent identity is independent of the new registration, which still fences in-flight operations')
    if (privateBackend) {
      await assert.rejects(retrieval.prepare(authorizedSession, { documentId }, signal), { code: 'pdf/retrieval-incomplete' })
      assert.equal(llm.calls, 0)
      assert.equal(documentVectors, firstVectors)
      return
    }
    let restoredPhase: string | undefined
    await retrieval.prepare('new-session', { documentId }, signal, value => { restoredPhase = value.phase })
    assert.equal(restoredPhase, 'ready')
    assert.equal(llm.calls, 0, 'Host recreation cannot rerun completed OCR or visual descriptions')
    assert.equal(nativeReads, firstReads, 'restoring completed pages does not re-extract them')
    assert.equal(documentVectors, firstVectors, 'restoring completed pages does not recompute document vectors')
    assert.equal(renders, firstRenders, 'upgrading must not render unchanged PDF pixels again')
    const reopened = await retrieval.search('new-session', { documentId, query: 'needle', mode: 'semantic' }, signal)
    assert.equal(reopened.status, 'complete')
    if (!legacy) assert.equal(reopened.indexGeneration, found.indexGeneration)
    assert.equal(reopened.candidates[0]?.source, mode === 'ocr' ? 'ocr-text' : 'image-description')
    assert.match(reopened.candidates[0]!.quote, /needle/)
    const provenance = reopened.candidates[0]!.evidence.snapshot
    assert.deepEqual(provenance, found.candidates[0]!.evidence.snapshot,
      'reused content keeps its original provenance instead of being relabelled for the current session')
    if (mode === 'image') {
      assert.ok('model' in provenance)
      assert.equal(provenance.model, `${route.provider}/${route.model}`)
    }
    assert.equal(reopened.documentId, documentId)
    assert.equal(reopened.candidates[0]!.evidence.documentId, documentId)
    assert.equal(reopened.candidates[0]!.evidence.sourceDigest, pageContentDigestBytes(bytes))
    await assert.rejects(retrieval.search('unrelated-session', { documentId, query: 'needle', mode: 'semantic' }, signal),
      { code: 'pdf/unknown-document' })
    assert.equal(llm.calls, 0)
    assert.equal(documentVectors, firstVectors)
  } finally {
    await retrieval.dispose(); content.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose()
    await store.dispose(); await ctx.fiber.dispose()
  }
})
