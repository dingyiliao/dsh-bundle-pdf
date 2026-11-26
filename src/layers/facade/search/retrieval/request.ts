import { z } from 'zod'

/** Normalize search requests; cursor authority and freshness stay with the service binding. */
export const retrievalQuerySchema = z.object({
  documentId: z.string().min(1).max(512), query: z.string().trim().min(1).max(2000),
  terms: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  mode: z.enum(['auto', 'lexical', 'semantic', 'hybrid']).default('auto'),
  topK: z.number().int().min(1).max(20).default(6),
  fromPage: z.number().int().min(1).default(1), maxPages: z.number().int().min(1).max(100_000).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict()
export const retrievalPrepareSchema = retrievalQuerySchema.pick({ documentId: true, fromPage: true, maxPages: true }).extend({
  rebuild: z.boolean().optional(), rebuildToken: z.string().min(1).max(2048).optional(),
})
const cursorSchema = z.object({
  version: z.literal(2), key: z.string().length(64), generation: z.string().uuid(),
  binding: z.string().length(64), query: z.string().length(64),
}).strict()
export type RetrievalQuery = z.infer<typeof retrievalQuerySchema>
export type RetrievalPrepareScope = z.infer<typeof retrievalPrepareSchema>

export function parseRetrievalCursor(token: string): z.infer<typeof cursorSchema> {
  try {
    const decoded = Buffer.from(token, 'base64url')
    if (decoded.toString('base64url') !== token) throw new Error('Invalid encoding')
    return cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
  } catch { throw Object.assign(new Error('Invalid retrieval cursor; restart the search'), { code: 'pdf/invalid-window' }) }
}

export function encodeRetrievalCursor(value: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
