import { z } from 'zod'

const identity = z.string().min(1).max(512)
const reference = z.string().regex(/^pdfref_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
const coordinate = z.number().finite()
const rectangle = z.tuple([coordinate, coordinate, coordinate, coordinate])
const page = z.number().int().min(1).max(100_000)
const requestIdentity = {
  sessionId: identity, documentId: identity,
  expectedRevision: z.number().int().nonnegative(), expectedContentVersion: identity,
}
const sourceIdentity = {
  documentId: identity, sourcePath: z.string().min(1).max(32_768),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceVersion: z.string().min(1).max(4096), contentVersion: identity,
  revision: z.number().int().nonnegative(),
}

export const selectionPrepareRequestSchema = z.object({
  ...requestIdentity, action: z.literal('prepare').optional(),
  quote: z.string().min(1).max(12_000),
  fragments: z.array(z.object({ page, rect: rectangle,
    quadPoints: z.array(coordinate).min(8).max(1024) }).strict()).min(1).max(10),
}).strict()
export const selectionRevalidationRequestSchema = z.object({
  ...requestIdentity, action: z.literal('revalidate'),
  selections: z.array(z.object({ id: identity, refIds: z.array(reference).min(1).max(10) }).strict()).min(1).max(20),
}).strict().refine(input => new Set(input.selections.map(selection => selection.id)).size === input.selections.length,
  'Selection IDs must be unique')
export const selectionEvidenceRequestSchema = z.discriminatedUnion('action', [
  selectionPrepareRequestSchema, selectionRevalidationRequestSchema,
])
export const selectionPrepareResultSchema = z.object({
  ...sourceIdentity, text: z.string().min(1).max(8000),
  excerpts: z.array(z.object({ page, text: z.string().min(1).max(8000), refId: reference,
    startUtf16: z.number().int().nonnegative(), endUtf16: z.number().int().positive() }).strict()).min(1).max(10),
}).strict()
export const selectionRevalidationResultSchema = z.object({
  ...sourceIdentity,
  selections: z.array(z.object({
    id: identity, text: z.string().min(1).max(8000), evidenceRefs: z.array(reference).min(1).max(10),
    fragments: z.array(z.object({ page, rect: rectangle,
      quadPoints: z.array(coordinate).min(8).max(32_000).refine(points => points.length % 8 === 0) }).strict()).min(1).max(10),
  }).strict()).min(1).max(20),
}).strict()

export type SelectionRevalidationRequest = z.infer<typeof selectionRevalidationRequestSchema>
export type SelectionRevalidationResult = z.infer<typeof selectionRevalidationResultSchema>
