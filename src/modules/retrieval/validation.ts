import { z } from 'zod'

/** Failure metadata emitted by page extraction and persisted in checkpoints. */
export const pageFailureSchema = z.object({ code: z.string().min(1).max(100) }).strict()
export type PageFailure = z.infer<typeof pageFailureSchema>

