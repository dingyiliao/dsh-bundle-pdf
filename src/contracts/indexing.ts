import { z } from 'zod'

export const PDF_INDEXING_METHOD = 'pdf.indexing'
const sessionId = z.string().min(1).max(512)
const documentId = z.string().min(1).max(512)
export const indexingProgressSchema = z.object({
  indexedPages: z.number().int().nonnegative(), totalPages: z.number().int().positive(),
  embeddedChunks: z.number().int().nonnegative(), totalChunks: z.number().int().nonnegative(),
  phase: z.enum(['restoring', 'extracting', 'embedding', 'ready']).optional(),
  reusedChunks: z.number().int().nonnegative().optional(), computedChunks: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.indexedPages <= value.totalPages && value.embeddedChunks <= value.totalChunks,
  'Invalid indexing progress').refine(value => value.reusedChunks === undefined && value.computedChunks === undefined
    || value.reusedChunks !== undefined && value.computedChunks !== undefined
      && value.reusedChunks + value.computedChunks === value.embeddedChunks, 'Invalid vector work counts')
export const indexingTaskSchema = z.object({
  documentId, title: z.string().min(1).max(512), occurrence: z.number().int().positive(),
  state: z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']),
  progress: indexingProgressSchema.optional(), failureCode: z.string().max(128).optional(),
}).strict()
export const indexingSnapshotSchema = z.object({
  revision: z.string().min(1).max(128), enabled: z.boolean(), tasks: z.array(indexingTaskSchema).max(64),
}).strict()
export const indexingRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), sessionId, revision: z.string().min(1).max(128).optional() }).strict(),
  z.object({ action: z.literal('start'), sessionId, documentId }).strict(),
  z.object({ action: z.literal('rebuild'), sessionId, documentId }).strict(),
  z.object({ action: z.literal('cancel'), sessionId, documentId }).strict(),
])
export type PdfIndexingTask = z.infer<typeof indexingTaskSchema>
export type PdfIndexingSnapshot = z.infer<typeof indexingSnapshotSchema>
