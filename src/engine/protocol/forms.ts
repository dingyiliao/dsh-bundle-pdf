import { z } from 'zod'

export const maxFormFontBytes = 32 * 1024 * 1024

const identity = {
  objectNumber: z.number().int().min(1).max(0xfffffffe),
  generation: z.number().int().min(0).max(0xfffffffe),
}
const base = z.object({
  ...identity,
  name: z.string(),
  description: z.string().optional(),
  readOnly: z.boolean(),
  required: z.boolean(),
  widgets: z.array(z.object({
    page: z.number().int().min(1).max(100_000),
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    option: z.string().optional(),
  })),
})

export const nativeFormsSchema = z.object({
  fields: z.array(z.discriminatedUnion('type', [
    base.extend({ type: z.literal('text'), value: z.string(), multiline: z.boolean(), maxLength: z.number().int().positive().optional() }),
    base.extend({ type: z.literal('checkbox'), value: z.boolean() }),
    base.extend({ type: z.literal('radio'), value: z.string(), options: z.array(z.string()) }),
    base.extend({ type: z.literal('dropdown'), value: z.array(z.string()), options: z.array(z.string()) }),
    base.extend({ type: z.literal('option-list'), value: z.array(z.string()), options: z.array(z.string()), multiple: z.boolean() }),
    base.extend({ type: z.literal('unsupported'), value: z.literal(''), readOnly: z.literal(true) }),
  ])).max(5000),
  nextOffset: z.number().int().nonnegative().nullable(),
})

export type NativeFormField = z.infer<typeof nativeFormsSchema>['fields'][number]
export type NativeFormEdit = z.infer<z.ZodObject<typeof identity>> & (
  | { type: 'text' | 'radio'; value: string }
  | { type: 'checkbox'; value: boolean }
  | { type: 'dropdown' | 'option-list'; value: readonly string[] }
)
