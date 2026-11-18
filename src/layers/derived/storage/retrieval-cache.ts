import { z } from 'zod'

/** Legacy V1 Storage Domain envelope, read only during import into the disk index store. */
export const retrievalCacheRecordSchema = z.object({
  createdAt: z.number().finite().nonnegative(),
  payload: z.json(),
}).strict()
export type RetrievalCacheRecord = z.infer<typeof retrievalCacheRecordSchema>
