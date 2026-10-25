import { z } from 'zod'
import type { PdfDocumentInfo, PdfFormField } from '../../core/pdf-types.js'
import { formFieldId } from './identity.js'
import { projectedFormValue, validateFormChanges } from './validation.js'

const value = z.union([z.string().max(8000), z.boolean(), z.array(z.string().max(2048)).max(1000)])
export const formRuleEvidenceSchema = z.object({ page: z.number().int().min(1).max(100000),
  quote: z.string().trim().min(1).max(512) }).strict()
/** A model-proposed reading of printed instructions, NOT a trusted PDF validation rule. */
export const formConditionSchema = z.object({
  fieldIds: z.array(z.string().min(1).max(2048)).min(1).max(100),
  when: z.object({ fieldId: z.string().min(1).max(2048), equals: value }).strict(),
  evidence: formRuleEvidenceSchema,
  onInactive: z.enum(['require-empty', 'preserve']).optional(),
}).strict()
export type FormCondition = z.infer<typeof formConditionSchema>
export interface FormConditionIssue {
  path: string
  code: 'invalid_condition' | 'condition_not_met' | 'condition_unknown'
  fieldId?: string
  hint: string
}
export class FormConditionError extends Error {
  readonly code = 'pdf/form-condition-failed'
  constructor(readonly issues: FormConditionIssue[]) {
    super('No fields were changed: review the form’s conditional instructions and correct the batch')
  }
}
const empty = (field: PdfFormField) => field.value === '' || field.value === false || field.value === null
  || Array.isArray(field.value) && field.value.length === 0

/** Evaluate the FINAL projected batch, so a Yes plus its details can be one undoable change. */
export function checkFormConditions(before: PdfDocumentInfo, after: PdfDocumentInfo,
  submitted: ReadonlySet<string>, conditions: readonly FormCondition[]) {
  if (conditions.reduce((sum, rule) => sum + rule.fieldIds.length, 0) > 100) {
    throw new FormConditionError([{ path: 'conditions', code: 'invalid_condition',
      hint: 'At most 100 dependent-field checks are allowed per batch; narrow the batch and reinspect.' }])
  }
  const fields = new Map((after.formFields ?? []).map(field => [formFieldId(field), field]))
  const issues: FormConditionIssue[] = [], retained = new Set<string>()
  conditions.forEach((rule, index) => {
    const path = `conditions[${index}]`, controller = fields.get(rule.when.fieldId)
    // Reading a controlling answer does not require permission to edit it.
    const invalid = !controller || validateFormChanges([{ ...controller, readOnly: false }], [{ fieldId: rule.when.fieldId, value: rule.when.equals }]).length
      || rule.fieldIds.some(id => !fields.has(id) || id === rule.when.fieldId)
      || new Set(rule.fieldIds).size !== rule.fieldIds.length
      || rule.evidence.page > before.pageCount
      || !controller.widgets.some(widget => widget.page === rule.evidence.page)
    if (invalid) {
      issues.push({ path, code: 'invalid_condition', hint: 'Reinspect the controlling page. Use exact controller/dependent field IDs, an accepted comparison value, and a short printed condition quote; do not guess a rule.' })
      return
    }
    const expected = projectedFormValue(controller, rule.when.equals)
    const unknown = controller.type !== 'checkbox' && empty(controller) && !empty({ ...controller, value: expected })
    const comparable = (value: PdfFormField['value']) => JSON.stringify(Array.isArray(value) ? [...value].sort() : value)
    const satisfied = !unknown && comparable(controller.value) === comparable(expected)
    if (satisfied) return
    for (const fieldId of rule.fieldIds) {
      const field = fields.get(fieldId)!
      if (empty(field)) continue
      if (!submitted.has(fieldId) && rule.onInactive === 'preserve') { retained.add(fieldId); continue }
      issues.push({ path, code: unknown ? 'condition_unknown' : 'condition_not_met', fieldId,
        hint: unknown
          ? 'The controlling answer is missing. Ask the user rather than guessing; no changes were applied.'
          : 'The final controlling answer does not activate this field, but it is not empty. No changes were applied or automatically cleared. Clear it only when authorized, or explicitly preserve existing data and report it as unresolved.' })
    }
  })
  if (issues.length) throw new FormConditionError(issues)
  return { source: 'model-supplied' as const, evaluated: conditions.length,
    retainedInactiveFieldIds: [...retained],
    limitation: 'Only supplied conditions were checked against final field values. Host does not infer or attest printed business rules, field meanings, or completeness.' }
}
