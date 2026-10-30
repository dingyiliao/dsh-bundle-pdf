import { z } from 'zod'

export const PDF_MODEL_OPTIONS_METHOD = 'pdf.model-options'
export const modelOptionsRequestSchema = z.object({}).strict().default({})
const identifier = z.string().min(1).max(512)
const name = z.string().min(1).max(512)
export const visionModelReasoningSchema = z.object({
  efforts: z.array(z.object({ id: identifier, name }).strict()).max(32),
  defaultEffort: identifier.optional(),
}).strict()
export const visionModelOptionSchema = z.object({
  id: identifier, name, reasoning: visionModelReasoningSchema.optional(),
}).strict()
export const visionModelCatalogSchema = z.object({
  groups: z.array(z.object({ id: identifier, name,
    models: z.array(visionModelOptionSchema).max(1024),
  }).strict()).max(64),
  failures: z.array(z.object({ id: identifier, name, message: z.string().min(1).max(2048) }).strict()).max(128),
}).strict()
export type VisionModelOption = z.infer<typeof visionModelOptionSchema>
export type VisionModelCatalog = z.infer<typeof visionModelCatalogSchema>
