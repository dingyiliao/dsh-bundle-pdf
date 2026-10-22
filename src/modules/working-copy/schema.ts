import { z } from 'zod'
import { hashSchema, idSchema, workingCopyOperationSchema, pathSchema } from '../../contracts/rpc/requests.js'

/** V1 persisted draft schema; the storage wire format stays unchanged. */

export const draftSchema = z.object({
  format: z.literal(1), sessionId: idSchema, path: pathSchema,
  sourceHash: hashSchema, sourceVersion: z.string().min(1).max(4096), contentVersion: idSchema,
  // Absolute deployment ceiling. Per-operation volatile limits remain enforced by the file adapter.
  // Existing drafts carry original inline. New drafts store it once under baseKey.
  original: z.string().min(1).max(357913944).optional(), baseKey: z.string().min(1).max(256).optional(),
  revision: z.number().int().min(0),
  /** Hash of materialized bytes persisted before a save for crash recovery. */
  renderedHash: hashSchema.optional(),
  groups: z.array(z.array(workingCopyOperationSchema).max(1000)).max(500),
  groupDates: z.array(z.string().datetime()).max(500).optional(),
  cursor: z.number().int().min(0).max(500),
}).strict().refine(value => value.cursor <= value.groups.length
  && (value.original !== undefined || value.baseKey !== undefined)
  && (value.groupDates === undefined || value.groupDates.length === value.groups.length))
export type DraftRecord = z.infer<typeof draftSchema>
/** Hydrated in-memory V1 draft; legacy records may have no groupDates on disk. */
export type WorkspaceRecord = DraftRecord & { groupDates: string[] }
