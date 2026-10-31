import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { createEvidenceReferenceStore } from '../adapters/host/storage/evidence-references.js'
import { createRetrievalCache, retrievalCacheRecordSchema } from '../adapters/host/storage/retrieval-cache.js'
import { createPdfRetrieval } from '../adapters/host/dsh/retrieval.js'
import { createPdfPageContent } from '../adapters/host/dsh/page-content.js'
import { createRetrievalPrefetch } from '../adapters/host/dsh/retrieval-prefetch.js'
import { createPdfIndexing } from '../adapters/host/dsh/indexing.js'
import { createDocumentIndexes } from '../adapters/host/dsh/document-indexes.js'
import { createDocumentIndexPolicies, documentIndexRecordSchema, settingsForIndexPlan } from '../modules/retrieval/index.js'
import { EmbeddingRegistry, createDisabledEmbeddingEngine } from '../embedding/index.js'
import { createOpenAiCompatibleEmbeddingEngine } from '../adapters/host/embedding/openai-compatible.js'
import { evidenceNavigationRequestSchema, revalidateEvidenceNavigation, assertFreshSource,
  savedReferenceSchema } from '../modules/evidence/index.js'
import { Config, readConfig, type HostConfig } from './reader-host-config.js'
import { createHostTranslations, createPdfOcrDispatch, createPdfRegionDispatch, createPdfSelectionDispatch,
  createPdfImageEvidenceResolver, freshSourceReader,
  registerAssets, registerPdfAgentTools,
  registerPdfSystemPrompt, registerPdfTransport,
  type PdfImageEvidenceResolver, type TranslationHostContext } from '../adapters/host/dsh/index.js'
import { createPdfInfoRoute } from '../adapters/host/dsh/info-route.js'
import { createPdfModelOptions, type PdfModelOptionsController } from '../adapters/host/dsh/model-options.js'
import { PDF_MODEL_OPTIONS_METHOD } from '../contracts/model-options.js'
import { retainPdfDocument } from '../adapters/host/dsh/transport.js'
import { createLocalFiles } from '../adapters/host/filesystem/local-files.js'
import { pdfLibDocumentAdapter } from '../adapters/host/pdf-lib/document-adapter.js'
import { createV1DraftRepository } from '../adapters/host/storage/v1-drafts.js'
import { createV1NavigationStore } from '../adapters/host/storage/v1-navigation.js'
import { createWorkingCopyService, draftSchema } from '../modules/working-copy/index.js'
import { createAgentNavigation, createReaderContexts, createReadingPositions,
  readingPositionRecordSchema } from '../modules/navigation/index.js'
import { createPdfService } from '../adapters/host/pdfium/index.js'
import type { PdfNativeService } from './native-host.js'
import { ImageUnderstandingError } from '../modules/image-understanding/index.js'
import { CapabilityRegistry } from '../modules/capabilities/index.js'
import { createLocalTextRecovery } from '../adapters/host/ocr/local-text-recovery.js'
import { EngineCatalog, engineBinding, engineCatalogRequestSchema } from '../modules/engines/index.js'
import { RETRIEVAL_REBUILD_METHOD, retrievalRebuildRequestSchema } from '../contracts/retrieval-index.js'

export { Config }
export const name = 'pdf-reader'
export const inject = ['connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain', 'loader', 'tools', 'pdfNative', 'subprocess']

type TransportContext = Parameters<typeof registerPdfTransport>[0]
type LocalContext = Parameters<typeof createLocalFiles>[0]
interface CredentialResolver {
  resolve(reference: string): Promise<{ value: string } | undefined>
}
interface HostContext extends Omit<TransportContext, 'connection'>, LocalContext, TranslationHostContext {
  pdfNative: PdfNativeService
  tools: Context['tools']
  reflect: Context['reflect']
  get: Context['get']
  connection: {
    fetch: {
      register(route: {
        path: string
        methods: readonly ('GET' | 'HEAD' | 'POST')[]
        requestBody: 'buffered' | 'streaming'
        fetch(request: Request): Promise<Response>
      }): () => Promise<void>
    }
  }
  loader: { locate(): string | undefined; resolve(id: string): { options: { id: string } } }
  effect: Context['effect']
  /** Loader's volatile-update seam is optional in standalone Host integrations. */
  on?: Context['on'] & ((event: 'loader/volatile-update', listener: (paths: readonly (readonly string[])[]) => void) => () => unknown)
  /** Contributes reader prompt guidance only when the system-prompt service exists. */
  inject: Context['inject']
  storageDomain: Context['storageDomain']
  subprocess: Context['subprocess']
}

export async function apply(
  ctx: HostContext,
  config: HostConfig,
  /** @internal Source-level tests supply isolated built-asset fixtures. */
  testAssetRoot?: string,
): Promise<void> {
  const namespace = ctx.loader.locate()
  if (!namespace) throw new Error('PDF must be loaded as a configured plugin entry')
  const settingsNamespace = ctx.loader.resolve(namespace).options.id
  const suffix = createHash('sha256').update(namespace).digest('hex').slice(0, 16)
  // One adapter owns every session's canonical-path save queue. Its limit is
  // read again at operation boundaries after settings change.
  const files = createLocalFiles(ctx, { getMaxBytes: () => config.maxFileBytes.get() })
  const domain = await ctx.storageDomain.open(defineDomain({
    name: `pdf_drafts_${suffix}`, version: 1, layout: 'per-record', tables: { drafts: domainTable(draftSchema) },
  }))
  // Reading positions have their own durable domain.
  const positionDomain = await ctx.storageDomain.open(defineDomain({
    name: `pdf_positions_${suffix}`, version: 1, layout: 'per-record',
    tables: { positions: domainTable(readingPositionRecordSchema) },
  })).catch(async error => { await domain.close(); throw error })
  // Derived evidence survives Host restarts without changing V1 drafts or
  // reading positions. Eviction is bounded in the adapter.
  const evidenceDomain = await ctx.storageDomain.open(defineDomain({
    name: `pdf_evidence_${suffix}`, version: 1, layout: 'per-record',
    invalidRecords: 'backup-and-skip', tables: { references: domainTable(savedReferenceSchema) },
  })).catch(async error => { await positionDomain.close(); await domain.close(); throw error })
  const retrievalDomain = await ctx.storageDomain.open(defineDomain({
    name: `pdf_retrieval_${suffix}`, version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
    tables: { cache: domainTable(retrievalCacheRecordSchema) },
  })).catch(async error => { await evidenceDomain.close(); await positionDomain.close(); await domain.close(); throw error })
  const policyDomain = await ctx.storageDomain.open(defineDomain({
    name: `pdf_index_policies_${suffix}`, version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
    tables: { policies: domainTable(documentIndexRecordSchema) },
  })).catch(async error => { await retrievalDomain.close(); await evidenceDomain.close(); await positionDomain.close(); await domain.close(); throw error })
  const retrievalCache = createRetrievalCache(retrievalDomain.table('cache'))
  const policyTable = policyDomain.table('policies')
  const indexPolicies = createDocumentIndexPolicies({ get: key => policyTable.get(key), put: (key, value) => policyTable.put(key, value),
    key: path => createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex'),
  }, () => readConfig(config))
  const referenceStore = createEvidenceReferenceStore(evidenceDomain.table('references'))
  const workspaces = createWorkingCopyService(files, createV1DraftRepository(domain.table('drafts')), pdfLibDocumentAdapter)
  const positions = createReadingPositions(workspaces, createV1NavigationStore(positionDomain.table('positions')))
  const capabilities = new CapabilityRegistry()
  const pdfService = createPdfService(workspaces, {
    executable: ctx.pdfNative.executable,
    subprocess: ctx.subprocess,
    capabilities,
    textRecovery: createLocalTextRecovery(),
  })
  const readerContexts = createReaderContexts(workspaces)
  const agentNavigation = createAgentNavigation(workspaces, readerContexts)
  const transportLifetime = new AbortController()
  const pendingRequests = new Set<Promise<unknown>>()
  const track = (dispatch: Parameters<typeof retainPdfDocument>[0]): typeof dispatch => async (sessionId, input, agent, signal) => {
    const requestSignal = AbortSignal.any([signal, transportLifetime.signal])
    requestSignal.throwIfAborted()
    const task = dispatch(sessionId, input, agent, requestSignal)
    pendingRequests.add(task)
    try { return await task } finally { pendingRequests.delete(task) }
  }
  const retain = (dispatch: Parameters<typeof retainPdfDocument>[0]) => track(retainPdfDocument(dispatch, workspaces.acquire))
  const translations = createHostTranslations(ctx, namespace, () => readConfig(config))
  const embeddings = new EmbeddingRegistry()
  embeddings.register(createDisabledEmbeddingEngine())
  embeddings.register(createOpenAiCompatibleEmbeddingEngine({
    async resolveCredential(reference, signal) {
      signal.throwIfAborted()
      // Resolve the optional Host seam per operation so rotations and provider
      // unloads are visible without retaining credentials in settings or Client.
      const credentials = ctx.get('credentials') as CredentialResolver | undefined
      if (typeof credentials?.resolve !== 'function') return undefined
      const resolved = await credentials.resolve(reference)
      signal.throwIfAborted()
      return resolved?.value
    },
  }))
  const retrieval = createDocumentIndexes({ documents: workspaces.listOpenDocuments, policies: indexPolicies,
    clearCache: () => retrievalCache.clear(),
    create(plan) {
      const settings = settingsForIndexPlan(plan, readConfig(config))
      const content = createPdfPageContent(workspaces, pdfService, { cache: retrievalCache, settings: () => settings,
        ocr: () => ctx.get('ocr'), image: () => ctx.get('imageUnderstanding') })
      return createPdfRetrieval(workspaces, pdfService, referenceStore,
        { cache: retrievalCache, embeddings, settings: () => settings, content,
          limits: { maxMemoryBytes: 64 * 1024 * 1024, maxIndexes: 2 },
          async freshSource(sessionId, documentId, signal) {
            const resolved = await ctx.sessionController.resolveAgent(sessionId)
            if ('error' in resolved) throw resolved.error
            await assertFreshSource(sessionId, workspaces.readSnapshot(sessionId, documentId),
              freshSourceReader(files, resolved.agent), signal)
          },
          async retain(sessionId, documentId, signal) {
            const resolved = await ctx.sessionController.resolveAgent(sessionId)
            if ('error' in resolved) throw resolved.error
            if (resolved.agent.session.id !== sessionId) throw new Error('PDF retrieval session identity mismatch')
            return workspaces.acquire(sessionId, documentId, resolved.agent, signal)
          },
        })
    },
  })
  const prefetch = createRetrievalPrefetch({
    documents: workspaces.listOpenDocuments,
    subscribe: workspaces.onDocumentsChanged,
    selection: retrieval.selection,
    prepare: retrieval.prepare,
  })
  const indexing = createPdfIndexing(prefetch, { documents: workspaces.listOpenDocuments, indexes: retrieval, enabled: () => true })
  const stopIndexPolicies = retrieval.subscribe(() => { prefetch.refresh(); indexing.changed() })
  const stopIndexingDocuments = workspaces.onDocumentsChanged(() => { retrieval.refresh(); indexing.changed() })
  const stopPrefetchEngines = embeddings.subscribe(() => { prefetch.refresh(); indexing.changed() })
  const stopPrefetchConfig = ctx.on?.('loader/volatile-update', paths => {
    if (paths.some(path => ['embeddingEngine', 'engineConfigurations', 'ocrEngine', 'imageEngine', 'indexScanPages', 'indexImageDescriptions'].includes(String(path[0])))) {
      retrieval.refresh(); prefetch.refresh(); indexing.changed()
    }
  })
  const engineCatalog = new EngineCatalog()
  const stopTranslations = engineCatalog.attach('translation', translations.registry)
  const stopEmbeddings = engineCatalog.attach('embedding', embeddings)
  const stopContentEngines = engineCatalog.subscribe(() => { prefetch.refresh(); indexing.changed() })
  // The image-understanding plugin may start before or after this reader.
  // Resolve the current agent and attachment store for each request, not at
  // plugin startup, so neither mounting order nor an old Session grants access.
  const imageEvidence: PdfImageEvidenceResolver = {
    async resolve(sessionId, documentId, refId, signal) {
      signal = AbortSignal.any([signal, transportLifetime.signal])
      signal.throwIfAborted()
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      if (resolved.agent.session.id !== sessionId) {
        throw new ImageUnderstandingError('pdf/session-mismatch', 'Session identity mismatch.')
      }
      const attachments = ctx.get('attachments')
      if (!attachments) {
        throw new ImageUnderstandingError('pdf/attachment-unavailable', 'PDF image attachments are not mounted.')
      }
      const release = await workspaces.acquire(sessionId, documentId, resolved.agent, signal)
      try {
        const task = createPdfImageEvidenceResolver(workspaces, referenceStore, attachments,
          freshSourceReader(files, resolved.agent)).resolve(sessionId, documentId, refId, signal)
        pendingRequests.add(task)
        try { return await task } finally { pendingRequests.delete(task) }
      } finally { release() }
    },
  }
  const disposers: (() => Promise<void>)[] = []
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposed) return disposed
    // Close operation admission synchronously, then release transports. Domain
    // writes remain available until every already-admitted operation settles.
    transportLifetime.abort(new DOMException('PDF reader is unloading', 'AbortError'))
    stopPrefetchConfig?.()
    stopPrefetchEngines()
    stopIndexingDocuments()
    stopIndexPolicies()
    indexing.dispose()
    const prefetchDrain = prefetch.dispose()
    const retrievalDrain = retrieval.dispose()
    const drain = workspaces.dispose()
    translations.registry.dispose()
    embeddings.dispose()
    stopEmbeddings()
    stopTranslations()
    stopContentEngines()
    engineCatalog.dispose()
    readerContexts.dispose()
    agentNavigation.dispose()
    disposed = (async () => {
      const results = await Promise.allSettled(disposers.splice(0).reverse().map(close => close()))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      // Each resource still closes if managed-process teardown reports an
      // observation failure; otherwise one failed wait would retain both stores.
      // Draining queued position writes comes first: they resolve the working
      // copy they belong to, so releasing workspaces first would drop them.
      for (const close of [async () => { await Promise.allSettled([...pendingRequests]) }, async () => { await prefetchDrain }, async () => { await retrievalDrain },
        () => positions.dispose(), () => drain, () => pdfService.dispose(), () => retrievalCache.dispose(),
        () => policyDomain.close(), () => retrievalDomain.close(), () => evidenceDomain.close(), () => positionDomain.close(), () => domain.close()]) {
        try { await close() } catch (error) { failures.push(error) }
      }
      capabilities.dispose()
      if (failures.length) throw new AggregateError(failures, 'Could not fully dispose PDF routes and resources')
    })()
    return disposed
  }
  try {
    ctx.effect(() => {
      disposers.push(registerPdfTransport(ctx, track(pdfService.dispatch)))
      disposers.push(registerPdfTransport(ctx, async (sessionId, input, _agent, signal) => {
        const id = typeof input.id === 'string' && input.id.length <= 512 ? input.id : undefined
        const knownRevision = input.knownRevision
        if (!id || typeof knownRevision !== 'number' || !Number.isSafeInteger(knownRevision) || knownRevision < 0) {
          throw Object.assign(new Error('A document ID and known revision are required'), { code: 'pdf/invalid-request' })
        }
        return { revision: await workspaces.waitForRevision(sessionId, id, knownRevision, signal) }
      }, { endpoint: 'pdf.watch', maxRequestBytes: 4096 }))
      disposers.push(registerPdfTransport(ctx, track(pdfService.native), { endpoint: 'pdf.native', maxRequestBytes: 64 * 1024 }))
      disposers.push(registerPdfTransport(ctx, retain(positions.dispatch), { endpoint: 'pdf.position', maxRequestBytes: 4096 }))
      disposers.push(registerPdfTransport(ctx, translations.dispatch, { endpoint: 'pdf.translation', maxRequestBytes: 64 * 1024 }))
      disposers.push(registerPdfTransport(ctx, retain(createPdfOcrDispatch(ctx, workspaces, pdfService,
        () => config.ocrTimeoutMs.get(), () => {
          const settings = readConfig(config)
          return engineBinding('ocr', settings.ocrEngine ?? 'session-llm', settings.engineConfigurations)
        })), { endpoint: 'pdf.ocr', maxRequestBytes: 4096 }))
      disposers.push(registerPdfTransport(ctx, retain(createPdfRegionDispatch(ctx, workspaces, pdfService, referenceStore)),
        { endpoint: 'pdf.region', maxRequestBytes: 4096 }))
      disposers.push(registerPdfTransport(ctx, retain(createPdfSelectionDispatch(workspaces, pdfService, referenceStore,
        agent => freshSourceReader(files, agent))),
        { endpoint: 'pdf.selection', maxRequestBytes: 64 * 1024 }))
      disposers.push(registerPdfTransport(ctx, async (sessionId, input) => readerContexts.update(sessionId, input),
        { endpoint: 'pdf.readercontext', maxRequestBytes: 4096 }))
      disposers.push(registerPdfTransport(ctx, retain((sessionId, input, _agent, signal) =>
        agentNavigation.dispatch(sessionId, input, signal)),
      { endpoint: 'pdf.navigation', maxRequestBytes: 4096 }))
      disposers.push(registerPdfTransport(ctx, track(async (sessionId, input, _agent, signal) => {
        const result = await indexing.dispatch(sessionId, input, signal)
        // A long poll can outlive the agent that admitted it. Do not publish
        // task names/progress after the resource Session has been retired.
        const current = await ctx.sessionController.resolveAgent(sessionId)
        signal.throwIfAborted()
        if ('error' in current) throw current.error
        if (current.agent.session.id !== sessionId) throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
        return result
      }), { endpoint: 'pdf.indexing', maxRequestBytes: 4096 }))
      // A tool-result card may request navigation only after the currently
      // authorized working copy passes a fresh, whole-page evidence check.
      disposers.push(registerPdfTransport(ctx, retain(async (_sessionId, input, agent, signal) => {
        const request = evidenceNavigationRequestSchema.parse(input)
        // The transport derives sessionId from the same validated input field
        // and resolves its agent before dispatching this request.
        return revalidateEvidenceNavigation(workspaces, pdfService, request, signal,
          freshSourceReader(files, agent), referenceStore)
      // An 8,000-character UTF-16 excerpt can exceed 16 KiB as UTF-8 (for
      // example Chinese text), even before the RPC envelope is serialized.
      }), { endpoint: 'pdf.evidence', maxRequestBytes: 64 * 1024 }))
      disposers.push(registerAssets(ctx, testAssetRoot))
      // Settings bootstrap carries no file contents and works outside a session.
      disposers.push(ctx.connection.fetch.register(createPdfInfoRoute(() => ({
        namespace, settingsNamespace, settings: readConfig(config), translationEngines: translations.registry.list(),
        engineCatalog: engineCatalog.read(),
      }))))
      disposers.push(ctx.connection.fetch.register(createPdfInfoRoute(async (payload, signal) => {
        const { revision } = engineCatalogRequestSchema.parse(payload)
        return engineCatalog.wait(revision, signal)
      }, 'pdf.engines')))
      disposers.push(ctx.connection.fetch.register(createPdfInfoRoute(
        createPdfModelOptions(ctx.sessionController as PdfModelOptionsController, () => ctx.get('llm'), transportLifetime.signal),
        PDF_MODEL_OPTIONS_METHOD, { code: 'pdf/model-options-unavailable', message: 'Model choices are unavailable. Please retry.' })))
      disposers.push(ctx.connection.fetch.register(createPdfInfoRoute(async (payload, signal) => {
        retrievalRebuildRequestSchema.parse(payload)
        const active = AbortSignal.any([signal, transportLifetime.signal])
        active.throwIfAborted()
        // Once admitted, finish the cache reset even if this settings view closes.
        // Retrieval owns its lifetime and drains it before storage is disposed.
        await prefetch.suspend()
        await retrieval.rebuild()
        prefetch.resume()
        active.throwIfAborted()
        return { status: 'invalidated' as const }
      }, RETRIEVAL_REBUILD_METHOD, { code: 'pdf/retrieval-rebuild-failed', message: 'Could not rebuild PDF search indexes. Please retry.' })))
      return dispose
    }, 'pdf: routes, working copies and draft storage')
    ctx.effect(() => ctx.reflect.provide('pdfTranslation', translations.registry), 'pdf: Host translation engines')
    ctx.effect(() => ctx.reflect.provide('pdfEmbedding', embeddings), 'pdf: Host embedding engines')
    ctx.effect(() => ctx.reflect.provide('pdfAiSettings', () => readConfig(config)), 'pdf: Host AI selections')
    ctx.effect(() => {
      const ocr = ctx.inject(['ocr'], scope => scope.effect(() => engineCatalog.attach('ocr', scope.ocr), 'pdf: OCR directory'))
      const image = ctx.inject(['imageUnderstanding'], scope => scope.effect(() => engineCatalog.attach('image', scope.imageUnderstanding), 'pdf: image directory'))
      return () => { ocr.dispose(); image.dispose() }
    }, 'pdf: dynamic engine sources')
    ctx.effect(() => ctx.reflect.provide('pdfCapabilities', capabilities), 'pdf: capability providers')
    ctx.effect(() => ctx.reflect.provide('pdf', pdfService), 'pdf: shared document service')
    ctx.effect(() => ctx.reflect.provide('pdfImageEvidence', imageEvidence), 'pdf: image evidence resolver')
    // ToolRuntime binds registrations to this plugin Fiber and removes them on unload.
    ctx.effect(() => registerPdfAgentTools(ctx, workspaces, pdfService, readerContexts, referenceStore, files,
      agentNavigation, retrieval),
      'pdf: agent tools and background documents')
    // Reader guidance is injected, not declared, so a Host without the
    // system-prompt service still loads the reader without this section.
    ctx.effect(() => registerPdfSystemPrompt(ctx), 'pdf: reader system prompt')
  } catch (error) {
    await dispose().catch(() => undefined)
    throw error
  }
}
