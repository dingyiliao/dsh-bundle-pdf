import { z } from 'zod'

const anchor = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict()

/** Shared V1 location shape for personal bookmarks and reading positions. */
export const bookmarkPositionSchema = z.object({
  page: z.number().int().min(1).max(100000), x: z.number().finite(), y: z.number().finite(),
  scale: z.number().finite().positive(), fit: z.enum(['custom', 'width', 'page']),
  viewportAnchor: anchor.optional(),
}).strict()
