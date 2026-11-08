import type { Context } from '@deepseek-ai/cordis'
import type { EmbeddingRegistry } from '../../../../embedding/index.js'
import { assertFreshSource, type EvidenceReferenceStore } from '../../../../modules/evidence/index.js'
import { settingsForIndexPlan, type createDocumentIndexPolicies, type RetrievalCache } from '../../../../modules/retrieval/index.js'
import type { createWorkingCopyService } from '../../../../modules/working-copy/index.js'
import type { PdfSettings } from '../../../../shared/contracts.js'
import type { createLocalFiles } from '../../filesystem/local-files.js'
import { createPdfPageContent } from '../page-content.js'
import { createPdfRetrieval } from '../retrieval.js'
import { createDocumentIndexes } from '../document-indexes.js'
import { createRetrievalPrefetch } from '../retrieval-prefetch.js'
import { createPdfIndexing } from '../indexing.js'
import type { createIndexingDiagnostics } from '../indexing-diagnostics.js'
import { freshSourceReader } from '../fresh-source.js'
import type { registerPdfTransport } from '../transport.js'

type IndexingDependencies = {
  ctx: Pick<Context, 'get'> & Pick<Parameters<typeof registerPdfTransport>[0], 'sessionController'>
  workspaces: ReturnType<typeof createWorkingCopyService>
  pdfService: Parameters<typeof createPdfPageContent>[1] & Parameters<typeof createPdfRetrieval>[1]
  files: Pick<ReturnType<typeof createLocalFiles>, 'read' | 'readIndexSourceVersion'>
  referenceStore: EvidenceReferenceStore
  indexPolicies: ReturnType<typeof createDocumentIndexPolicies>
  embeddings: EmbeddingRegistry
  indexingDiagnostics: ReturnType<typeof createIndexingDiagnostics>
  retrievalCache: RetrievalCache & { clear(): Promise<void> }
  waitForMigration(signal?: AbortSignal): Promise<void>
  readSettings(): PdfSettings
}

/** Compose per-document retrieval, background preparation and its task surface. */
export function createReaderIndexing(options: IndexingDependencies) {
  const { ctx, workspaces, pdfService, files, referenceStore, indexPolicies, embeddings,
    indexingDiagnostics, retrievalCache, waitForMigration, readSettings } = options
  const retrieval = createDocumentIndexes({ documents: workspaces.listOpenDocuments, policies: indexPolicies,
    clearCache: () => retrievalCache.clear(),
    create(plan) {
      const settings = settingsForIndexPlan(plan, readSettings())
      const content = createPdfPageContent(workspaces, pdfService, { cache: retrievalCache, settings: () => settings,
        ocr: () => ctx.get('ocr'), image: () => ctx.get('imageUnderstanding'), onActivity: indexingDiagnostics.activity })
      const api = createPdfRetrieval(workspaces, pdfService, referenceStore,
        { cache: retrievalCache, embeddings, settings: () => settings, content,
          onFailure: indexingDiagnostics.failure,
          limits: { maxMemoryBytes: 64 * 1024 * 1024, maxIndexes: 2 },
          async freshSource(sessionId, documentId, signal, purpose) {
            const resolved = await ctx.sessionController.resolveAgent(sessionId)
            if ('error' in resolved) throw resolved.error
            if (resolved.agent.session.id !== sessionId) throw new Error('PDF retrieval session identity mismatch')
            const snapshot = workspaces.readSnapshot(sessionId, documentId)
            const readSource = purpose === 'indexing'
              ? () => files.readIndexSourceVersion(resolved.agent, snapshot.path, signal)
              : freshSourceReader(files, resolved.agent)
            await assertFreshSource(sessionId, snapshot, readSource, signal, workspaces.bytesHash(snapshot.bytes))
          },
          async retain(sessionId, documentId, signal) {
            const resolved = await ctx.sessionController.resolveAgent(sessionId)
            if ('error' in resolved) throw resolved.error
            if (resolved.agent.session.id !== sessionId) throw new Error('PDF retrieval session identity mismatch')
            return workspaces.acquire(sessionId, documentId, resolved.agent, signal)
          },
        })
      return { ...api,
        async availability(sessionId, signal, documentId) { await waitForMigration(signal); return api.availability(sessionId, signal, documentId) },
        async prepare(sessionId, input, signal, onProgress) { await waitForMigration(signal); return api.prepare(sessionId, input, signal, onProgress) },
        async prepareSlice(sessionId, input, signal, onProgress, occurrence) {
          await waitForMigration(signal)
          return api.prepareSlice!(sessionId, input, signal, onProgress, occurrence)
        },
        async search(sessionId, input, signal) { await waitForMigration(signal); return api.search(sessionId, input, signal) },
      }
    },
  })
  const prefetch = createRetrievalPrefetch({
    documents: workspaces.listOpenDocuments,
    subscribe: workspaces.onDocumentsChanged,
    selection: retrieval.selection,
    prepare: (sessionId, input, signal, onProgress) => indexingDiagnostics.run(sessionId, input.documentId,
      () => retrieval.prepare(sessionId, input, signal, onProgress)),
    prepareSlice: (sessionId, input, signal, onProgress, occurrence) => indexingDiagnostics.run(sessionId, input.documentId,
      () => retrieval.prepareSlice!(sessionId, input, signal, onProgress, occurrence)),
    onDiagnostic: indexingDiagnostics.record,
  })
  const indexing = createPdfIndexing(prefetch, { documents: workspaces.listOpenDocuments, indexes: retrieval, enabled: () => true })
  return { retrieval, prefetch, indexing }
}
