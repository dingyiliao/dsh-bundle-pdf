import { z } from 'zod'
import { prepareTextSelectionEvidence } from '../../../modules/evidence/index.js'
import type { EvidenceReferenceStore, FreshSourceRead, SelectionTextReader } from '../../../modules/evidence/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'
import type { PdfDispatch } from './transport.js'

const identity = z.string().min(1).max(512)
const coordinate = z.number().finite()
export const selectionEvidenceRequestSchema = z.object({
  sessionId: identity,
  documentId: identity,
  expectedRevision: z.number().int().nonnegative(),
  expectedContentVersion: identity,
  quote: z.string().min(1).max(12_000),
  fragments: z.array(z.object({
    page: z.number().int().min(1).max(100_000),
    rect: z.tuple([coordinate, coordinate, coordinate, coordinate]),
    quadPoints: z.array(coordinate).min(8).max(1024),
  }).strict()).min(1).max(10),
}).strict()

/** Authenticated pdf.selection RPC. Neither quote nor geometry is trusted as evidence. */
export function createPdfSelectionDispatch(workspaces: WorkingCopyReadPort,
  reader: SelectionTextReader, references: EvidenceReferenceStore,
  readSource: (agent: Parameters<PdfDispatch>[2]) => FreshSourceRead): PdfDispatch {
  return async (sessionId, raw, agent, signal) => {
    const input = selectionEvidenceRequestSchema.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) {
      throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
    }
    return prepareTextSelectionEvidence(workspaces, reader, references, input, signal, readSource(agent))
  }
}
