import { responseSchema } from '../../../contracts/rpc/index.js'
import { selectionPrepareRequestSchema, selectionPrepareResultSchema,
  selectionRevalidationRequestSchema, selectionRevalidationResultSchema } from '../../../contracts/selection.js'
import type { PdfTextSelectionEvidenceApi } from '../../../modules/viewer/index.js'
import type { PdfConnection } from './pdf-api.js'

/** The Host, not the browser selection, determines the text admitted as evidence. */
export function createTextSelectionEvidenceApi(connection: PdfConnection, lifetime: AbortSignal): PdfTextSelectionEvidenceApi {
  return {
    async prepare(input, signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime
      combined.throwIfAborted()
      const request = selectionPrepareRequestSchema.parse(input)
      const response = responseSchema.parse(await connection.rpc.call('/api', 'pdf.selection', request, combined))
      combined.throwIfAborted()
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      const result = selectionPrepareResultSchema.parse(response.value)
      if (result.documentId !== request.documentId || result.contentVersion !== request.expectedContentVersion
        || result.revision !== request.expectedRevision
        || result.excerpts.some(excerpt => !request.fragments.some(fragment => fragment.page === excerpt.page)
          || excerpt.endUtf16 <= excerpt.startUtf16)) {
        throw new Error('Host text selection identity does not match the requested PDF selection')
      }
      return result
    },
    async revalidate(input, signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime
      combined.throwIfAborted()
      const request = selectionRevalidationRequestSchema.parse({ ...input, action: 'revalidate' })
      const response = responseSchema.parse(await connection.rpc.call('/api', 'pdf.selection', request, combined))
      combined.throwIfAborted()
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      const result = selectionRevalidationResultSchema.parse(response.value)
      if (result.documentId !== request.documentId || result.contentVersion !== request.expectedContentVersion
        || result.revision !== request.expectedRevision || result.selections.length !== request.selections.length
        || result.selections.some((selection, index) => {
          const expected = request.selections[index]!
          return selection.id !== expected.id || selection.evidenceRefs.length !== expected.refIds.length
            || selection.evidenceRefs.some((ref, part) => ref !== expected.refIds[part])
            || selection.fragments.length !== expected.refIds.length
            || selection.fragments.some((fragment, part) => part > 0 && fragment.page <= selection.fragments[part - 1]!.page)
        })) {
        throw new Error('Host text revalidation does not match the requested selections or working revision')
      }
      return result
    },
  }
}
