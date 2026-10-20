import { z } from 'zod'

/** Validated Client-to-Host working-copy requests. Keep this independent of Host storage. */
const scalar = z.number().finite()
const color = z.tuple([scalar.min(0).max(1), scalar.min(0).max(1), scalar.min(0).max(1)])
const rect = z.tuple([scalar, scalar, scalar, scalar]).refine(value => value[2] >= value[0] && value[3] >= value[1], 'Rectangle bounds are reversed')
export const idSchema = z.string().min(1).max(512)
export const pathSchema = z.string().min(1).max(32768).refine(value => !value.includes('\0'), 'Path contains NUL')
export const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const wireHints = { knownBytesHash: hashSchema.optional() }

export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), annotation: z.object({
    id: idSchema, page: z.number().int().min(1),
    subtype: z.enum(['Highlight', 'Underline', 'StrikeOut', 'Text']), rect,
    replyToId: idSchema.optional(),
    quadPoints: z.array(scalar).min(8).max(32000).refine(value => value.length % 8 === 0).optional(),
    color: color.optional(), contents: z.string().max(100000).optional(), author: z.string().max(1024).optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('update'), id: idSchema, patch: z.object({
    contents: z.string().max(100000).optional(), color: color.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('delete'), id: idSchema }).strict(),
])

export const requestSchema = z.discriminatedUnion('action', [
  z.object({ ...wireHints, action: z.literal('open'), sessionId: idSchema, address: z.string().min(1).max(32768),
    owner: z.enum(['ui', 'agent']).optional() }).strict(),
  z.object({ ...wireHints, action: z.literal('inspectTarget'), sessionId: idSchema, path: pathSchema }).strict(),
  ...(['undo', 'redo', 'reload', 'discard'] as const).map(action => z.object({
    ...wireHints, action: z.literal(action), sessionId: idSchema, id: idSchema, revision: z.number().int().min(0),
  }).strict()),
  z.object({ ...wireHints, action: z.literal('discardMany'), sessionId: idSchema, ids: z.array(idSchema).max(1000) }).strict(),
  z.object({ ...wireHints, action: z.literal('discardAddresses'), sessionId: idSchema, addresses: z.array(z.string().min(1).max(32768)).max(1000) }).strict(),
  z.object({ ...wireHints, action: z.literal('change'), sessionId: idSchema, id: idSchema, revision: z.number().int().min(0),
    /** Optional fresh source CAS for model-authored changes; older Client calls remain unchanged. */
    expectedSourceHash: hashSchema.optional(),
    operations: z.array(operationSchema).min(1).max(1000),
  }).strict(),
  z.object({ ...wireHints, action: z.literal('save'), sessionId: idSchema, id: idSchema, revision: z.number().int().min(0),
    options: z.object({ path: pathSchema.optional(), overwrite: z.boolean().optional(),
      expectedTargetVersion: hashSchema.nullable().optional(),
    }).strict(),
  }).strict(),
])
