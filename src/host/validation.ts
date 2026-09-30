import { z } from 'zod'

const scalar = z.number().finite()
const color = z.tuple([scalar.min(0).max(1), scalar.min(0).max(1), scalar.min(0).max(1)])
const rect = z.tuple([scalar, scalar, scalar, scalar]).refine(value => value[2] >= value[0] && value[3] >= value[1], 'Rectangle bounds are reversed')
const id = z.string().min(1).max(512)
const path = z.string().min(1).max(32768).refine(value => !value.includes('\0'), 'Path contains NUL')
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const wireHints = { knownBytesHash: hash.optional() }
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), annotation: z.object({
    id, page: z.number().int().min(1),
    subtype: z.enum(['Highlight', 'Underline', 'StrikeOut', 'Text']), rect,
    quadPoints: z.array(scalar).min(8).max(32000).refine(value => value.length % 8 === 0).optional(),
    color: color.optional(), contents: z.string().max(100000).optional(), author: z.string().max(1024).optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('update'), id, patch: z.object({
    contents: z.string().max(100000).optional(), color: color.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('delete'), id }).strict(),
])

export const draftSchema = z.object({
  format: z.literal(1), sessionId: id, path,
  sourceHash: hash, sourceVersion: z.string().min(1).max(4096), contentVersion: id,
  // Absolute deployment ceiling. Per-operation volatile limits remain enforced by the file adapter.
  // Existing drafts carry original inline. New drafts store it once under baseKey.
  original: z.string().min(1).max(357913944).optional(), baseKey: z.string().min(1).max(256).optional(),
  revision: z.number().int().min(0),
  /** Hash of materialized bytes persisted before a save for crash recovery. */
  renderedHash: hash.optional(),
  groups: z.array(z.array(operationSchema).max(1000)).max(500),
  groupDates: z.array(z.string().datetime()).max(500).optional(),
  cursor: z.number().int().min(0).max(500),
}).strict().refine(value => value.cursor <= value.groups.length
  && (value.original !== undefined || value.baseKey !== undefined)
  && (value.groupDates === undefined || value.groupDates.length === value.groups.length))
export type DraftRecord = z.infer<typeof draftSchema>

export const requestSchema = z.discriminatedUnion('action', [
  z.object({ ...wireHints, action: z.literal('open'), sessionId: id, address: z.string().min(1).max(32768) }).strict(),
  z.object({ ...wireHints, action: z.literal('inspectTarget'), sessionId: id, path }).strict(),
  ...(['undo', 'redo', 'reload', 'discard'] as const).map(action => z.object({
    ...wireHints, action: z.literal(action), sessionId: id, id, revision: z.number().int().min(0),
  }).strict()),
  z.object({ ...wireHints, action: z.literal('discardMany'), sessionId: id, ids: z.array(id).max(1000) }).strict(),
  z.object({ ...wireHints, action: z.literal('discardAddresses'), sessionId: id, addresses: z.array(z.string().min(1).max(32768)).max(1000) }).strict(),
  z.object({ ...wireHints, action: z.literal('change'), sessionId: id, id, revision: z.number().int().min(0),
    operations: z.array(operationSchema).min(1).max(1000),
  }).strict(),
  z.object({ ...wireHints, action: z.literal('save'), sessionId: id, id, revision: z.number().int().min(0),
    options: z.object({ path: path.optional(), overwrite: z.boolean().optional(),
      expectedTargetVersion: hash.nullable().optional(),
    }).strict(),
  }).strict(),
])
