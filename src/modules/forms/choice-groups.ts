import { z } from 'zod'
import type { PdfDocumentInfo } from '../../core/pdf-types.js'
import { formFieldId } from './identity.js'
import { formRuleEvidenceSchema } from './conditions.js'

/** Printed single-choice questions are often encoded as independent PDF checkboxes. */
export const formChoiceGroupSchema = z.object({
  fieldIds: z.array(z.string().min(1).max(2048)).min(2).max(100),
  evidence: formRuleEvidenceSchema,
}).strict()
export type FormChoiceGroup = z.infer<typeof formChoiceGroupSchema>
export interface FormChoiceIssue {
  path: string
  code: 'invalid_choice_group' | 'multiple_choices_selected'
  fieldId?: string
  hint: string
}
export class FormChoiceError extends Error {
  readonly code = 'pdf/form-choice-failed'
  constructor(readonly issues: FormChoiceIssue[]) {
    super('No fields were changed: review the form’s mutually exclusive choices')
  }
}

/** Checks final values, including boxes not present in this write; never guesses a group from geometry. */
export function checkFormChoiceGroups(after: PdfDocumentInfo, groups: readonly FormChoiceGroup[]) {
  const invalidHint = 'Use at least two distinct inspected checkbox fields and a short printed single-choice instruction from a page containing the group. Do not guess groups by order or proximity.'
  if (groups.reduce((sum, group) => sum + group.fieldIds.length, 0) > 100) {
    throw new FormChoiceError([{ path: 'choiceGroups', code: 'invalid_choice_group', hint: 'At most 100 choice-group members are allowed per batch.' }])
  }
  const fields = new Map((after.formFields ?? []).map(field => [formFieldId(field), field]))
  const issues: FormChoiceIssue[] = []
  groups.forEach((group, index) => {
    const path = `choiceGroups[${index}]`, members = group.fieldIds.map(id => fields.get(id))
    if (group.fieldIds.length < 2 || new Set(group.fieldIds).size !== group.fieldIds.length
      || members.some(field => !field || field.type !== 'checkbox')
      || group.evidence.page > after.pageCount
      || !members.some(field => field?.widgets.some(widget => widget.page === group.evidence.page))) {
      issues.push({ path, code: 'invalid_choice_group', hint: invalidHint })
      return
    }
    const selected = members.filter(field => field!.value === true)
    if (selected.length > 1) for (const field of selected) {
      issues.push({ path, code: 'multiple_choices_selected', fieldId: formFieldId(field!),
        hint: 'More than one checkbox is selected in this supplied single-choice group, including existing draft values. Confirm every option’s printed meaning, then explicitly uncheck the alternatives in the same batch. No changes were applied.' })
    }
  })
  if (issues.length) throw new FormChoiceError(issues)
  return { source: 'model-supplied' as const, evaluated: groups.length,
    limitation: 'Only supplied groups were checked for at most one selected checkbox. Host does not infer or verify printed option meanings, group membership, or whether a choice is applicable or required.' }
}
