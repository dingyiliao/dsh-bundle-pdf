/**
 * Frozen V1 storage validators copied from pre-refactor main
 * 643a7c9512ff615d9d718b70b1f97c617b2b9abd. Do not import today's
 * validators here: these represent what a rollback binary would accept.
 */
import { z } from 'zod'

const scalar = z.number().finite()
const color = z.tuple([scalar.min(0).max(1), scalar.min(0).max(1), scalar.min(0).max(1)])
const rect = z.tuple([scalar, scalar, scalar, scalar])
  .refine(value => value[2] >= value[0] && value[3] >= value[1], 'Rectangle bounds are reversed')
const id = z.string().min(1).max(512)
const path = z.string().min(1).max(32768).refine(value => !value.includes('\0'), 'Path contains NUL')
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const operationSchema = z.discriminatedUnion('type', [
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

export const priorMainDraftSchema = z.object({
  format: z.literal(1), sessionId: id, path,
  sourceHash: hash, sourceVersion: z.string().min(1).max(4096), contentVersion: id,
  original: z.string().min(1).max(357913944).optional(), baseKey: z.string().min(1).max(256).optional(),
  revision: z.number().int().min(0), renderedHash: hash.optional(),
  groups: z.array(z.array(operationSchema).max(1000)).max(500),
  groupDates: z.array(z.string().datetime()).max(500).optional(),
  cursor: z.number().int().min(0).max(500),
}).strict().refine(value => value.cursor <= value.groups.length
  && (value.original !== undefined || value.baseKey !== undefined)
  && (value.groupDates === undefined || value.groupDates.length === value.groups.length))

const anchor = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict()
const position = z.object({
  page: z.number().int().min(1).max(100000), x: z.number().finite(), y: z.number().finite(),
  scale: z.number().finite().positive(), fit: z.enum(['custom', 'width', 'page']),
  viewportAnchor: anchor.optional(),
}).strict()

export const priorMainPositionSchema = z.object({
  format: z.literal(1), path: z.string().min(1).max(32768), sourceHash: hash,
  position, updatedAt: z.string().datetime(),
}).strict()
