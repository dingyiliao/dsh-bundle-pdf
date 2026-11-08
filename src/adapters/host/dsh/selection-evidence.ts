import { prepareTextSelectionEvidence, revalidateTextSelectionEvidence } from '../../../modules/evidence/index.js'
import type { EvidenceReferenceStore, FreshSourceRead, AgentPageReadPort } from '../../../modules/evidence/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'
import type { PdfDispatch } from './transport.js'
import { selectionEvidenceRequestSchema } from '../../../contracts/selection.js'

export { selectionEvidenceRequestSchema } from '../../../contracts/selection.js'

/** Authenticated pdf.selection RPC. Neither quote nor geometry is trusted as evidence. */
export function createPdfSelectionDispatch(workspaces: WorkingCopyReadPort,
  reader: AgentPageReadPort, references: EvidenceReferenceStore,
  readSource: (agent: Parameters<PdfDispatch>[2]) => FreshSourceRead): PdfDispatch {
  return async (sessionId, raw, agent, signal) => {
    const input = selectionEvidenceRequestSchema.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) {
      throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
    }
    return input.action === 'revalidate'
      ? revalidateTextSelectionEvidence(workspaces, reader, references, input, signal, readSource(agent))
      : prepareTextSelectionEvidence(workspaces, reader, references, input, signal, readSource(agent))
  }
}
