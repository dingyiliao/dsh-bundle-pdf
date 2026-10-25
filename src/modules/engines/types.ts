import { z } from 'zod'

export const engineKinds = ['ocr', 'image', 'translation'] as const
export type EngineKind = typeof engineKinds[number]
export type EngineJson = null | boolean | number | string | EngineJson[] | { [key: string]: EngineJson }
export type EngineConfiguration = Readonly<Record<string, EngineJson>>
export interface EngineBinding { engineId: string; config?: EngineConfiguration }

export const configurationFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), label: z.string().min(1).max(200),
  type: z.enum(['string', 'number', 'boolean', 'secret-reference']), required: z.boolean().optional(),
}).strict()
export type EngineConfigurationField = z.infer<typeof configurationFieldSchema>
export const engineDescriptorSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9@][a-zA-Z0-9@/_.:-]{0,199}$/),
  name: z.string().min(1).max(200), version: z.string().min(1).max(128),
  execution: z.enum(['disabled', 'local', 'remote']),
  configurationFields: z.array(configurationFieldSchema).max(32).optional(),
}).superRefine((descriptor, ctx) => {
  const fields = descriptor.configurationFields ?? []
  if (new Set(fields.map(field => field.key)).size !== fields.length) ctx.addIssue({ code: 'custom', message: 'Duplicate engine configuration field' })
})
export type EngineDescriptor = z.infer<typeof engineDescriptorSchema>
const json: z.ZodType<EngineJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(8192), z.array(json).max(128), z.record(z.string().max(200), json),
]))
export const engineConfigurationSchema = z.record(z.string().max(200), json)
  .superRefine((value, ctx) => {
    if (JSON.stringify(value).length > 16_384) ctx.addIssue({ code: 'custom', message: 'Engine configuration exceeds its limit' })
  })
/** References are opaque names owned by the contributor, never raw credentials. */
export function validateEngineConfiguration(descriptor: EngineDescriptor, input: EngineConfiguration = {}): EngineConfiguration {
  const config = engineConfigurationSchema.parse(input)
  const fields = descriptor.configurationFields ?? []
  for (const key of Object.keys(config)) {
    if (!fields.some(field => field.key === key)) throw new Error('Unknown engine configuration field')
  }
  for (const field of fields) {
    const value = config[field.key]
    if (value === undefined || value === '') {
      if (field.required) throw new Error(`Engine configuration requires ${field.label}`)
      continue
    }
    const type = field.type === 'secret-reference' ? 'string' : field.type
    if (typeof value !== type || type === 'number' && !Number.isFinite(value)) throw new Error(`Invalid engine configuration: ${field.label}`)
    if (field.type === 'secret-reference' && !/^[a-zA-Z0-9][a-zA-Z0-9/_.:-]{0,199}$/.test(String(value))) {
      throw new Error('A credential reference, not a secret, is required')
    }
  }
  return config
}

export type EngineConfigurations = Partial<Record<EngineKind, Record<string, EngineConfiguration>>>
const configurationsByEngine = z.record(z.string().min(1).max(200), engineConfigurationSchema)
  .refine(value => Object.keys(value).length <= 128, 'Too many engine configurations')
export const engineConfigurationsSchema = z.object({ ocr: configurationsByEngine.optional(),
  image: configurationsByEngine.optional(), translation: configurationsByEngine.optional() }).strict()
  .refine(value => JSON.stringify(value).length <= 65_536, 'Engine configurations exceed their limit')
export function engineBinding(kind: EngineKind, engineId: string, configurations?: EngineConfigurations): EngineBinding {
  return { engineId, config: configurations?.[kind]?.[engineId] ?? {} }
}
