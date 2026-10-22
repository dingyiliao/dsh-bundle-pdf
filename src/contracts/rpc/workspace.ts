import { z } from 'zod'
import type { PdfOutlineItem } from '../../core/pdf-types.js'

const wireOutlineItemSchema: z.ZodType<PdfOutlineItem> = z.lazy(() => z.object({
  id: z.string(), title: z.string(), page: z.number().int().positive().optional(),
  targetChanged: z.literal(true).optional(), children: z.array(wireOutlineItemSchema),
}))
const wireFormFieldSchema = z.object({
  id: z.string().optional(),
  name: z.string(), type: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'option-list', 'unsupported']),
  value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  widgets: z.array(z.object({ page: z.number().int().positive(),
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]), option: z.string().optional() })),
  options: z.array(z.string()).optional(), maxLength: z.number().int().optional(),
  multiline: z.boolean().optional(), multiple: z.boolean().optional(), readOnly: z.boolean(), required: z.boolean(),
})

const rect = z.tuple([z.number(), z.number(), z.number(), z.number()])
const point = z.tuple([z.number().finite(), z.number().finite()])
const color = z.tuple([z.number(), z.number(), z.number()])
export const wireAnnotationSchema = z.object({
  sourceObjectId: z.string().optional(), popupObjectId: z.string().optional(), commentPosition: point.optional(),
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
  baselineOutline: z.array(wireOutlineItemSchema).optional(),
  baselineFormFields: z.array(wireFormFieldSchema).optional(),
  document: z.object({
    pageCount: z.number().int().positive(), title: z.string().optional(), signed: z.boolean(), encrypted: z.boolean(),
    formKind: z.enum(['acroform', 'xfa']).optional(),
    outline: z.array(wireOutlineItemSchema).optional(), outlineReadOnlyReason: z.string().optional(),
    formFields: z.array(wireFormFieldSchema).optional(),
    readOnly: z.boolean(), readOnlyReason: z.string().optional(),
    pages: z.array(z.object({ page: z.number().int(), mediaBox: rect.optional(), cropBox: rect, rotation: z.number(), userUnit: z.number() })),
    annotations: z.array(wireAnnotationSchema),
  }).optional(),
})

export type WireSnapshot = z.infer<typeof wireSnapshotSchema>
