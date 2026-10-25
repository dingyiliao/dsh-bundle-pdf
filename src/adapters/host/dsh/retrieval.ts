import { createRetrievalService, type RetrievalCache, type RetrievalInput,
  type RetrievalEmbedding } from '../../../modules/retrieval/index.js'
import { evidenceSha256, rememberTextEvidence, type AgentPageReadPort,
  type EvidenceReferenceStore } from '../../../modules/evidence/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'
import { engineBinding } from '../../../modules/engines/index.js'
import { EmbeddingError, type EmbeddingRegistry } from '../../../embedding/index.js'
import { joinPageText } from '../../../shared/page-text.js'
import { defaultSettings, type PdfSettings } from '../../../shared/contracts.js'

/** Host integration owns authorization snapshots and ref signing; retrieval owns only derived indexes. */
export function createPdfRetrieval(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore, options: {
    cache?: RetrievalCache; embeddings?: EmbeddingRegistry; settings?: () => PdfSettings
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
  function select(): RetrievalEmbedding | undefined {
    const registry = options.embeddings
    const settings = options.settings?.() ?? defaultSettings
    if (!registry || !settings.embeddingEngine || settings.embeddingEngine === 'none') return
    const binding = engineBinding('embedding', settings.embeddingEngine, settings.engineConfigurations)
    try {
      const model = registry.describe(binding)
      return { fingerprint: model.fingerprint, generation: registry.generation(binding),
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
      }
    } catch (error) {
      if (error instanceof EmbeddingError && ['disabled', 'engine-unavailable', 'not-configured'].includes(error.code)) return
      throw error
    }
  }
  const service = createRetrievalService({ documents: { snapshot, retain: options.retain }, cache: options.cache,
    embedding: { select }, pages: { async read(sessionId, id, page, signal) {
      // Whole-document indexing must not unexpectedly OCR hundreds of pages.
      const { content } = await pages.readPageText(sessionId, id, page, signal, { recover: false })
      return { text: joinPageText(content.items), source: content.extraction === 'local-ocr' ? 'ocr' : 'pdf-text',
        warnings: [...(content.warnings ?? []), ...(content.quality?.unmappedCharacters
          ? ['Some native characters could not be decoded; OCR or visual inspection is needed.'] : [])] }
    } } })
  return {
    async availability(_sessionId: string, signal: AbortSignal) {
      signal.throwIfAborted()
      const backend = select()
      if (!backend) return { status: 'unavailable' as const, reason: 'Semantic retrieval is disabled or its selected engine is not installed.' }
      const available = !backend.availability || await backend.availability(signal)
      signal.throwIfAborted()
      const latest = select()
      if (latest?.fingerprint !== backend.fingerprint || latest?.generation !== backend.generation) {
        return { status: 'unavailable' as const, reason: 'Selected embedding engine changed during the availability check.' }
      }
      return available ? { status: 'available' as const }
        : { status: 'unavailable' as const, reason: 'Selected embedding engine is not currently available; lexical retrieval remains available.' }
    },
    async search(sessionId: string, input: RetrievalInput, signal: AbortSignal) {
      const result = await service.search(sessionId, input, signal)
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
          read = await pages.readPageText(sessionId, input.documentId, chunk.page, signal, { recover: false })
          pageReads.set(chunk.page, read)
        }
        check()
        const text = joinPageText(read.content.items)
        if (evidenceSha256(text).replace(/^sha256:/, '') !== chunk.pageTextDigest || text.slice(chunk.startUtf16, chunk.endUtf16) !== chunk.text) {
          throw Object.assign(new Error('Indexed PDF text changed; rebuild the search'), { code: 'pdf/stale-reader' })
        }
        const evidence = await rememberTextEvidence(references, sessionId, read.snapshot, chunk.page,
          text, chunk.startUtf16, chunk.endUtf16, read.content, result.document.sourceDigest)
        check()
        candidates.push({ page: chunk.page, quote: chunk.text, score: chunk.score,
          annotationStatus: chunk.source === 'pdf-text' && !read.content.quality?.unmappedCharacters
            ? 'requires-geometry-check' : 'unavailable', evidence })
      }
      const { chunks: _chunks, document, ...progress } = result
      check()
      const current = workspaces.readSnapshot(sessionId, input.documentId)
      return { ...progress, documentId: document.id, path: document.path,
        contentVersion: document.contentVersion, sourceDigest: document.sourceDigest,
        sourceVersion: current.sourceVersion, revision: current.revision, candidates,
        limitations: [
          'Only extracted text is indexed. Images, charts, formulas and unrecognized scanned text are not fully covered.',
          'Ranking gives leads, not verified answers or proof of absence. Read context and inspect complex pages before drawing conclusions.',
          'Text references are checked against the original page; annotation and exact navigation still validate native glyph geometry and may reject ambiguous layouts.',
          ...(result.status !== 'complete' ? ['The requested scope is not fully indexed. Continue pdf_find_related with only the returned searchId while hasMore is true.'] : []),
        ] }
    },
    cancelSession: service.cancelSession,
    dispose: service.dispose,
  }
}
export type PdfRetrieval = ReturnType<typeof createPdfRetrieval>
