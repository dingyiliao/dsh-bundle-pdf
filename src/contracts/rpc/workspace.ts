import { z } from 'zod'

const rect = z.tuple([z.number(), z.number(), z.number(), z.number()])
const color = z.tuple([z.number(), z.number(), z.number()])
export const wireAnnotationSchema = z.object({
  sourceObjectId: z.string().optional(), popupObjectId: z.string().optional(),
  replyToId: z.string().optional(), replyType: z.enum(['R', 'Group']).optional(),
  hasRichText: z.literal(true).optional(),
  linkAction: z.string().optional(),
  id: z.string(), page: z.number().int(), subtype: z.string(), rect: rect.optional(), quadPoints: z.array(z.number()).optional(),
  color: color.optional(), opacity: z.number().optional(), contents: z.string().optional(), author: z.string().optional(),
  createdAt: z.string().optional(), modifiedAt: z.string().optional(), flags: z.number(),
  supported: z.boolean(), editable: z.boolean(), readOnlyReason: z.string().optional(),
})

/** Full snapshots and annotation deltas share one versioned wire shape. */
export const wireSnapshotSchema = z.object({
  id: z.string(), path: z.string(), sourceVersion: z.string(), contentVersion: z.string(),
  revision: z.number().int(), dirty: z.boolean(), canUndo: z.boolean(), canRedo: z.boolean(), conflict: z.boolean(),
  warning: z.string().optional(),
  reader: z.object({ bytesHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    generation: z.number().int(), protocolVersion: z.literal(1) }),
  annotationDelta: z.object({ fromRevision: z.number().int(), remove: z.array(z.string()), upsert: z.array(wireAnnotationSchema) }).optional(),
  baselineAnnotations: z.array(wireAnnotationSchema).optional(),
  document: z.object({
    pageCount: z.number().int().positive(), title: z.string().optional(), signed: z.boolean(), encrypted: z.boolean(),
    readOnly: z.boolean(), readOnlyReason: z.string().optional(),
    pages: z.array(z.object({ page: z.number().int(), mediaBox: rect.optional(), cropBox: rect, rotation: z.number(), userUnit: z.number() })),
    annotations: z.array(wireAnnotationSchema),
  }).optional(),
})

export type WireSnapshot = z.infer<typeof wireSnapshotSchema>
