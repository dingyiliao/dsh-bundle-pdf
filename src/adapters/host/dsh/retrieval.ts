import { createHash } from 'node:crypto'
import { createRetrievalService, retrievalPageText, type RetrievalCache, type RetrievalInput, type RetrievalPrepareInput, type RetrievalProgress,
  type RetrievalEmbedding, type RetrievalResult } from '../../../modules/retrieval/index.js'
import { evidenceSha256, rememberTextEvidence, createImageEvidenceRegistry, type AgentPageReadPort,
  type EvidenceReferenceStore } from '../../../modules/evidence/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'
import { engineBinding } from '../../../modules/engines/index.js'
import { EmbeddingError, type EmbeddingRegistry } from '../../../embedding/index.js'
import { joinPageText } from '../../../shared/page-text.js'
import { defaultSettings, type PdfSettings } from '../../../shared/contracts.js'
import { projectPageContent, type PdfPageContent } from './page-content.js'

/** Tool output reports each issue once; detailed per-page quality stays in the index. */
function summarizeCoverage(coverage: RetrievalResult['coverage'], candidates: readonly { page: number }[]) {
  const candidatePages = new Set(candidates.map(candidate => candidate.page))
  const groups = new Map<string, Set<number>>()
  for (const entry of coverage.qualityWarnings) for (const message of entry.warnings) {
    let pages = groups.get(message)
    if (!pages) groups.set(message, pages = new Set())
    pages.add(entry.page)
  }
  const summaries = [...groups].map(([message, pages]) => {
    const sorted = [...pages].sort((a, b) => a - b)
    const relevant = sorted.filter(page => candidatePages.has(page))
    const sampleOtherPages = sorted.filter(page => !candidatePages.has(page)).slice(0, 8)
    return { message, affectedPageCount: pages.size, candidatePages: relevant, sampleOtherPages,
      omittedPageCount: pages.size - relevant.length - sampleOtherPages.length }
  }).sort((a, b) => b.candidatePages.length - a.candidatePages.length
    || b.affectedPageCount - a.affectedPageCount || a.message.localeCompare(b.message))
  const omitted = summaries.slice(8)
  const omittedPages = new Set<number>()
  for (const entry of omitted) for (const page of groups.get(entry.message)!) omittedPages.add(page)
  return { ...coverage, qualityWarnings: summaries.slice(0, 8),
    ...(omitted.length ? { qualityWarningsOmitted: { warningTypes: omitted.length,
      affectedPageCount: omittedPages.size,
      candidatePages: [...omittedPages].filter(page => candidatePages.has(page)).sort((a, b) => a - b) } } : {}) }
}

/** Host integration owns authorization snapshots and ref signing; retrieval owns only derived indexes. */
export function createPdfRetrieval(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore, options: {
    cache?: RetrievalCache; embeddings?: EmbeddingRegistry; settings?: () => PdfSettings
    limits?: Parameters<typeof createRetrievalService>[0]['limits']
    content?: PdfPageContent
    /** Resolve the caller's session policy and re-read the actual source, including ready-cache hits. */
    freshSource?(sessionId: string, documentId: string, signal: AbortSignal): Promise<void>
    retain?: (sessionId: string, documentId: string, signal: AbortSignal) => Promise<() => void>
  } = {}) {
  const digests = new WeakMap<Uint8Array, string>()
  const hash = (bytes: Uint8Array) => {
    let digest = digests.get(bytes)
    if (!digest) { digest = evidenceSha256(bytes); digests.set(bytes, digest) }
    return digest
  }
  const snapshot = (sessionId: string, id: string) => {
    const current = workspaces.readSnapshot(sessionId, id)
    if (current.conflict) throw Object.assign(new Error('PDF source has changed; resolve the conflict before retrieval.'), { code: 'pdf/stale-reader' })
    return { id: current.id, path: current.path, sourceDigest: hash(current.bytes),
      contentVersion: current.contentVersion, pageCount: current.document.pageCount }
  }
  function selection(): { backend: RetrievalEmbedding; configuration: string; registry: EmbeddingRegistry } | { reason: string } {
    const registry = options.embeddings
    const settings = options.settings?.() ?? defaultSettings
    if (!settings.embeddingEngine || settings.embeddingEngine === 'none') {
      return { reason: 'Semantic retrieval is disabled in PDF settings. Select and configure an embedding engine to enable it; pdf_keyword_search remains available.' }
    }
    if (!registry) return { reason: 'The embedding engine registry is not installed; pdf_keyword_search remains available.' }
    // Keep configuration ownership separate from learned service metadata. An
    // availability probe may discover a model revision but must not bless a
    // concurrent switch of endpoint, credentials or registered implementation.
    const binding = structuredClone(engineBinding('embedding', settings.embeddingEngine, settings.engineConfigurations))
    const configuration = JSON.stringify([binding.engineId,
      Object.entries(binding.config ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)])
    try {
      const model = registry.describe(binding)
      return { configuration, registry,
        backend: { fingerprint: model.fingerprint, generation: registry.generation(binding),
        ...(model.documentFingerprint ? { documentFingerprint: createHash('sha256')
          .update(JSON.stringify([binding.engineId, model.documentFingerprint])).digest('hex') } : {}),
        configurationIdentity: createHash('sha256').update(configuration).digest('hex'),
        dimensions: model.dimensions, maxBatchSize: model.maxBatchSize, maxInputCharacters: model.maxInputCharacters,
        async availability(signal) {
          try { return (await registry.availability(binding, signal)).status === 'available' }
          catch (error) {
            signal.throwIfAborted()
            if (error instanceof EmbeddingError && ['engine-unavailable', 'not-configured', 'timeout'].includes(error.code)) return false
            throw error
          }
        },
        async embed(texts, purpose, signal) {
          const result = await registry.embed({ texts, purpose, signal }, binding)
          if (result.model.fingerprint !== model.fingerprint) {
            throw Object.assign(new Error('Embedding model changed during retrieval'), { code: 'pdf/stale-reader' })
          }
          return result.vectors
        },
      } }
    } catch (error) {
      if (error instanceof EmbeddingError && ['disabled', 'engine-unavailable', 'not-configured'].includes(error.code)) {
        const reason = error.code === 'disabled' ? 'The selected embedding engine is disabled.'
          : error.code === 'not-configured' ? 'The selected embedding engine needs configuration in PDF settings.'
            : 'The selected embedding engine is not installed or is no longer available.'
        return { reason: `${reason} pdf_keyword_search remains available.` }
      }
      throw error
    }
  }
  function select(): RetrievalEmbedding | undefined {
    const result = selection()
    return 'backend' in result ? result.backend : undefined
  }
  const imageEvidence = createImageEvidenceRegistry(workspaces, references)
  const service = createRetrievalService({ documents: { snapshot, retain: options.retain }, cache: options.cache, limits: options.limits,
    embedding: { select }, pages: { ...(options.content ? { identity: options.content.identity } : {}), async read(sessionId, id, page, signal) {
      if (options.content) return projectPageContent(await options.content.read(sessionId, id, page, signal))
      // Whole-document indexing must not unexpectedly OCR hundreds of pages.
      const { content } = await pages.readPageText(sessionId, id, page, signal, { recover: false })
      return { ...retrievalPageText(content.items), source: content.extraction === 'local-ocr' ? 'ocr' : 'pdf-text',
        warnings: [...(content.warnings ?? []), ...(content.quality?.unmappedCharacters
          ? ['Some native characters could not be decoded; OCR or visual inspection is needed.'] : [])] }
    } } })
  function operationalAvailability() {
    const state = service.state()
    return state === 'ready' ? undefined : { status: 'unavailable' as const,
      reason: state === 'failed' ? 'PDF index reset failed. Retry Rebuild index in PDF settings before semantic search; pdf_keyword_search remains available.'
        : state === 'rebuilding' ? 'PDF search indexes are being reset. Retry semantic search shortly; pdf_keyword_search remains available.'
          : 'PDF retrieval is unloading; pdf_keyword_search remains available.' }
  }
  async function availability(_sessionId: string, signal: AbortSignal, _documentId?: string) {
    signal.throwIfAborted()
    const operation = operationalAvailability()
    if (operation) return operation
    let selected = selection()
    if ('reason' in selected) return { status: 'unavailable' as const, reason: selected.reason }
    for (let attempt = 0; attempt < 2; attempt++) {
      const backend = selected.backend
      const available = !backend.availability || await backend.availability(signal)
      signal.throwIfAborted()
      const currentOperation = operationalAvailability()
      if (currentOperation) return currentOperation
      const latest = selection()
      if ('reason' in latest || latest.configuration !== selected.configuration || latest.registry !== selected.registry
          || latest.backend.generation !== backend.generation) {
        return { status: 'unavailable' as const, reason: 'Selected embedding engine changed during the availability check.' }
      }
      if (!available) return { status: 'unavailable' as const,
        reason: 'Selected embedding engine is not currently available; pdf_keyword_search remains available.' }
      if (latest.backend.fingerprint === backend.fingerprint) return { status: 'available' as const }
      // A first probe can learn the service's revision. Refresh the selection
      // once, then require that identity to remain stable across confirmation.
      selected = latest
    }
    return { status: 'unavailable' as const, reason: 'Embedding model changed repeatedly during the availability check.' }
  }
  return {
    availability,
    async prepare(sessionId: string, input: RetrievalPrepareInput, signal: AbortSignal, onProgress?: (progress: RetrievalProgress) => void) {
      // A queued background task must reauthorize and pin its working copy before
      // reading even the initial snapshot. Pins do not create document owners.
      const release = await options.retain?.(sessionId, input.documentId, signal)
      try {
        signal.throwIfAborted()
        await options.freshSource?.(sessionId, input.documentId, signal)
        const ready = await availability(sessionId, signal)
        if (ready.status !== 'available') {
          throw Object.assign(new Error(ready.reason), { code: 'pdf/retrieval-engine-unavailable' })
        }
        await options.content?.prepare(sessionId, signal)
        if (input.rebuild) options.content?.refresh(sessionId, input.documentId)
        await service.prepare(sessionId, input, signal, onProgress)
        await options.content?.verify(sessionId, signal)
        await options.freshSource?.(sessionId, input.documentId, signal)
      } finally { release?.() }
    },
    async search(sessionId: string, input: RetrievalInput, signal: AbortSignal) {
      signal.throwIfAborted()
      // Even a ready shared index requires the current caller's authority
      // and working-copy lease before probing an engine or reading metadata.
      const release = await options.retain?.(sessionId, input.documentId, signal)
      try {
        signal.throwIfAborted()
        await options.freshSource?.(sessionId, input.documentId, signal)
        await options.content?.prepare(sessionId, signal)
        if (input.mode !== 'lexical' && service.state() === 'ready') {
          // Learn remotely reported model identity before the core captures its
          // index key, including direct callers that did not request pdf_status.
          const ready = await availability(sessionId, signal)
          if (ready.status !== 'available' && input.mode !== 'auto' && input.mode !== undefined) {
            throw Object.assign(new Error(ready.reason), { code: 'pdf/retrieval-engine-unavailable' })
          }
        }
        const result = await service.search(sessionId, input, signal)
        await options.content?.verify(sessionId, signal)
        const check = () => {
          signal.throwIfAborted()
          service.validate(sessionId, result)
          const current = snapshot(sessionId, input.documentId)
          if (current.path !== result.document.path || current.contentVersion !== result.document.contentVersion
            || current.sourceDigest !== result.document.sourceDigest) {
            throw Object.assign(new Error('PDF changed while resolving retrieval results'), { code: 'pdf/stale-reader' })
          }
        }
        check()
        const candidates = []
        const pageReads = new Map<number, Awaited<ReturnType<AgentPageReadPort['readPageText']>>>()
        for (const chunk of result.chunks) {
          let read = pageReads.get(chunk.page)
          if (!read) {
            // Reauthorize/recheck the source without rerunning a nondeterministic OCR or description.
            read = await pages.readPageText(sessionId, input.documentId, chunk.page, signal, { recover: false })
            pageReads.set(chunk.page, read)
          }
          check()
          if (chunk.representation && options.content) {
            const metadata = chunk.representation
            // The validated index owns this exact derived snapshot. Its offsets
            // are representation-local and are never reinterpreted as native text.
            if (metadata.kind !== 'native-text') {
              if (!metadata.inputDigest || !metadata.producer) throw new Error('Derived PDF content has no image provenance.')
              const current = workspaces.readSnapshot(sessionId, input.documentId)
              const spans = metadata.spans ?? []
              const rect = spans.length ? spans.reduce<[number, number, number, number]>((rect, span) => [
                Math.min(rect[0], span.rectPdf[0]), Math.min(rect[1], span.rectPdf[1]),
                Math.max(rect[2], span.rectPdf[2]), Math.max(rect[3], span.rectPdf[3])], [...spans[0].rectPdf]) : metadata.rectPdf
              const evidence = await imageEvidence.mint(sessionId, { documentId: current.id, sourcePath: current.path,
                sourceDigest: result.document.sourceDigest, sourceVersion: current.sourceVersion,
                contentVersion: current.contentVersion, revision: current.revision, page: chunk.page,
                renderedImageSha256: metadata.inputDigest, source: metadata.kind === 'ocr-text' ? 'ocr-text' : 'auxiliary-vision',
                snapshot: { kind: 'derived-text', text: chunk.text, sha256: evidenceSha256(chunk.text), backendId: metadata.producer.id,
                  ...(metadata.producer.version ? { backendVersion: metadata.producer.version } : {}), ...(metadata.producer.model ? { model: metadata.producer.model } : {}) },
                locator: rect ? { kind: 'pdf-region', rectPdf: rect } : { kind: 'page-only' },
                precision: spans.length ? 'approximate-geometry' : 'page-only',
                limitations: [metadata.kind === 'ocr-text' ? 'OCR text is recognized from page pixels and may contain errors.'
                  : 'This is a generated image description, not a quotation from the PDF.',
                  'Derived text does not certify native glyph geometry for exact highlighting.'],
              }, signal)
              check()
              candidates.push({ page: chunk.page, quote: chunk.text, score: chunk.score,
                source: metadata.kind, blockId: metadata.blockId, annotationStatus: 'unavailable' as const, evidence })
              continue
            }
          }
          const text = joinPageText(read.content.items)
          if (evidenceSha256(text).replace(/^sha256:/, '') !== chunk.pageTextDigest || text.slice(chunk.startUtf16, chunk.endUtf16) !== chunk.text) {
            throw Object.assign(new Error('Indexed PDF text changed; rebuild the search'), { code: 'pdf/stale-reader' })
          }
          const evidence = await rememberTextEvidence(references, sessionId, read.snapshot, chunk.page,
            text, chunk.startUtf16, chunk.endUtf16, read.content, result.document.sourceDigest)
          check()
          candidates.push({ page: chunk.page, quote: chunk.text, score: chunk.score,
            source: 'native-text', ...(chunk.representation ? { blockId: chunk.representation.blockId } : {}),
            annotationStatus: chunk.source === 'pdf-text' && !read.content.quality?.unmappedCharacters
              ? 'requires-geometry-check' : 'unavailable', evidence })
        }
        const { chunks: _chunks, document, ...progress } = result
        check()
        await options.freshSource?.(sessionId, input.documentId, signal)
        check()
        const current = workspaces.readSnapshot(sessionId, input.documentId)
        return { ...progress, coverage: summarizeCoverage(result.coverage, candidates), documentId: document.id, path: document.path,
          contentVersion: document.contentVersion, sourceDigest: document.sourceDigest,
          sourceVersion: current.sourceVersion, revision: current.revision, candidates,
          limitations: [
            result.coverage.visual === 'image-descriptions'
              ? 'Image descriptions are generated retrieval aids, not original quotations or exhaustive visual coverage.'
              : 'Only native and enabled OCR text is indexed. Visual semantics are not covered unless image-description indexing is enabled.',
            'Ranking gives leads, not verified answers or proof of absence. Read context and inspect complex pages before drawing conclusions.',
            'Text references are checked against the original page; annotation and exact navigation still validate native glyph geometry and may reject ambiguous layouts.',
            ...(result.nextCursor ? ['The requested scope is not fully indexed. Continue pdf_semantic_search with only the returned searchId while hasMore is true.']
              : result.status === 'incomplete' ? ['Some page content could not be indexed. These are ranked available representations, not complete coverage. Rebuild the document index to retry failed enrichment.'] : []),
          ] }
      } finally { release?.() }
    },
    cancelSession(sessionId: string) { service.cancelSession(sessionId); options.content?.cancelSession(sessionId) },
    rebuild: service.rebuild,
    async dispose() { options.content?.dispose(); await service.dispose() },
  }
}
export type PdfRetrieval = ReturnType<typeof createPdfRetrieval>
