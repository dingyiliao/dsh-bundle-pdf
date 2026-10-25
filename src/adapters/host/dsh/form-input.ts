import { z } from 'zod'
import { formControlReferenceSchema, FormValidationError, type FormInspectionRegistry,
  formRuleEvidenceSchema } from '../../../modules/forms/index.js'
import type { ModelFillFormInput } from '../../../modules/model-write/index.js'

const value = z.union([z.string().max(8000), z.boolean(), z.array(z.string().max(2048)).max(1000)])
const localReference = z.object({ label: formControlReferenceSchema.shape.label }).strict()
const sharedReference = z.object({ sharedFieldKey: z.string().max(32).regex(/^G[1-9]\d*$/) }).strict()
const ruleReference = z.union([localReference, sharedReference])
const evidence = z.object({ quote: formRuleEvidenceSchema.shape.quote }).strict()
export const numberedFillFormSchema = z.object({
  documentId: z.string().min(1).max(512), expectedRevision: z.number().int().nonnegative(),
  inspectionId: z.string().regex(/^form-inspect_[0-9a-f-]{36}$/),
  fields: z.array(localReference.extend({ value }).strict()).min(1).max(100),
  conditions: z.array(z.object({
    fields: z.array(ruleReference).min(1).max(100),
    when: z.union([localReference.extend({ equals: value }).strict(), sharedReference.extend({ equals: value }).strict()]),
    evidence,
    onInactive: z.enum(['require-empty', 'preserve']).optional(),
  }).strict()).max(100).optional(),
  choiceGroups: z.array(z.object({ fields: z.array(ruleReference).min(2).max(100),
    evidence }).strict()).max(50).optional(),
}).strict().refine(input => JSON.stringify(input).length <= 64_000, 'Form batch exceeds the tool budget')
export type NumberedFillFormInput = z.infer<typeof numberedFillFormSchema>
type Bindings = ReturnType<FormInspectionRegistry['resolve']>
type RuleReference = z.infer<typeof ruleReference>

function target(reference: RuleReference, bindings: Bindings) {
  return 'label' in reference ? bindings.get(reference.label) : bindings.getShared(reference.sharedFieldKey)
}

/** Only this adapter translates model-visible labels; the shared draft still uses canonical field identities. */
export function resolveNumberedFormInput(input: NumberedFillFormInput, bindings: Bindings,
  currentRevision: number): ModelFillFormInput {
  const fields = input.fields.map((field, index) => {
    const control = bindings.get(field.label)
    if (control.option !== undefined && typeof field.value === 'string' && field.value !== '' && field.value !== control.option) {
      throw new FormValidationError([{ index, fieldId: control.fieldId, property: 'value', code: 'invalid_option',
        hint: 'Use the exact option attached to this numbered radio control, or choose the label of the desired option.' }])
    }
    return { fieldId: control.fieldId, value: field.value }
  })
  return { documentId: input.documentId, expectedRevision: currentRevision, fields,
    conditions: [...(input.conditions?.map(rule => ({
      fieldIds: rule.fields.map(reference => target(reference, bindings).fieldId),
      when: { fieldId: target(rule.when, bindings).fieldId, equals: rule.when.equals },
      evidence: { page: target(rule.when, bindings).page, quote: rule.evidence.quote },
      ...(rule.onInactive ? { onInactive: rule.onInactive } : {}),
    })) ?? [])],
    choiceGroups: [...(input.choiceGroups?.map(group => ({
      fieldIds: group.fields.map(reference => target(reference, bindings).fieldId),
      evidence: { page: target(group.fields[0], bindings).page, quote: group.evidence.quote },
    })) ?? [])] }
}

export function numberedReference(input: NumberedFillFormInput, bindings: Bindings,
  fieldId: string): RuleReference | null {
  const references = [...input.fields, ...(input.conditions?.flatMap(rule => [...rule.fields, rule.when]) ?? []),
    ...(input.choiceGroups?.flatMap(group => group.fields) ?? [])]
  const supplied = references.find(reference => target(reference, bindings).fieldId === fieldId)
  if (supplied) return 'label' in supplied ? { label: supplied.label } : { sharedFieldKey: supplied.sharedFieldKey }
  const found = bindings.reference(fieldId)
  return !found ? null : found.page === bindings.page ? { label: found.label } : { sharedFieldKey: found.sharedFieldKey }
}

export const CONTROL_REFERENCE_PROPERTIES = {
  label: { type: 'string' as const, required: true as const, description: 'Exact F01-style label on the page identified by inspectionId. No page number or native field ID.' },
}

export const SHARED_REFERENCE_PROPERTIES = {
  sharedFieldKey: { type: 'string' as const, required: true as const,
    description: 'Exact G-style sharedFieldKey from an inspected field in the same original document snapshot. Read-only rule reference; cannot write another page.' },
}

export const RULE_REFERENCE_SCHEMA = { oneOf: [
  { type: 'object' as const, additionalProperties: false, properties: CONTROL_REFERENCE_PROPERTIES },
  { type: 'object' as const, additionalProperties: false, properties: SHARED_REFERENCE_PROPERTIES },
] } as const
