import { z } from 'zod'

/** Profile-owned derived indexes; this operation never receives a document or file path. */
export const RETRIEVAL_REBUILD_METHOD = 'pdf.retrieval.rebuild'
export const retrievalRebuildRequestSchema = z.object({}).strict()
export const retrievalRebuildResultSchema = z.object({ status: z.literal('invalidated') }).strict()
