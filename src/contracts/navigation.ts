import { z } from 'zod'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const rect = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(value => value[2] > value[0] && value[3] > value[1], 'Target rectangle must have positive dimensions')

/** A Host-revalidated text target, never a model-supplied rectangle. */
export const textNavigationTargetSchema = z.object({
  kind: z.literal('text'),
  refId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  sourceDigest: digest,
  pageTextDigest: digest,
  startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().positive(),
  textSha256: digest,
  rectPdf: rect,
  quadPoints: z.array(z.number().finite()).min(8).max(32000).refine(value => value.length % 8 === 0),
}).strict().refine(value => value.endUtf16 > value.startUtf16, 'Target text range must not be empty')
export type TextNavigationTarget = z.infer<typeof textNavigationTargetSchema>

export const agentNavigationRequestSchema = z.object({
  requestId: z.string().uuid(),
  page: z.number().int().positive().max(100000),
  documentId: z.string().min(1).max(512),
  contentVersion: z.string().min(1).max(512),
  target: textNavigationTargetSchema.optional(),
}).strict()
export type AgentNavigationRequest = z.infer<typeof agentNavigationRequestSchema>
