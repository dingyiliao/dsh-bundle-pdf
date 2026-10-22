import { z } from 'zod'

const anchor = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict()

/** Shared location shape for reading-position RPC and durable V1 records. */
export const readingPositionSchema = z.object({
  page: z.number().int().min(1).max(100000), x: z.number().finite(), y: z.number().finite(),
  scale: z.number().finite().positive(), fit: z.enum(['custom', 'width', 'page']),
  viewportAnchor: anchor.optional(),
}).strict()
