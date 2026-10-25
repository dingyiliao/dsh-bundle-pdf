import { PdfDocumentError, type PdfFormField } from '../../core/pdf-types.js'
import { formFieldId, matchingFormFields, type FormFieldTarget } from './identity.js'

export type FormValueContract = {
  valueType: 'string' | 'boolean' | 'string[]' | 'unsupported'
  examples: PdfFormField['value'][]
  hint: string
}

/** Machine-readable instructions, shared by inspection and validation. Never coerce guessed values. */
export function formValueContract(field: PdfFormField): FormValueContract {
  switch (field.type) {
    case 'text': return { valueType: 'string', examples: ['', 'Example'.slice(0, field.maxLength ?? 7)],
      hint: 'Use a string; an empty string clears the field. Respect maxLength (Unicode characters).' }
    case 'checkbox': return { valueType: 'boolean', examples: [true, false],
      hint: 'Use true to check or false to uncheck; never use a label, "Yes", "Off", or a quoted boolean.' }
    case 'radio':
    case 'dropdown': return { valueType: 'string', examples: field.options?.slice(0, 1) ?? [],
      hint: 'Use one exact string from options, not its printed label or an index. An empty string clears the selection.' }
    case 'option-list': return { valueType: 'string[]', examples: [[], field.options?.slice(0, 1) ?? []],
      hint: 'Use an array of exact option strings; [] clears it. If multiple is false, select at most one.' }
    case 'unsupported': return { valueType: 'unsupported', examples: [], hint: 'This field type cannot be edited.' }
  }
}

export type FormIssueCode = 'unknown_field' | 'ambiguous_field' | 'duplicate_field' | 'read_only'
  | 'unsupported_field_type' | 'field_not_visible' | 'value_type_mismatch' | 'value_too_long'
  | 'invalid_option' | 'too_many_selections'

export interface FormValidationIssue {
  index: number
  property: 'fieldId' | 'value'
  fieldId: string
  fieldName?: string
  fieldType?: PdfFormField['type']
  pages?: number[]
  code: FormIssueCode
  expected?: FormValueContract['valueType']
  receivedType?: string
  maxLength?: number
  hint: string
}

export class FormValidationError extends PdfDocumentError {
  constructor(public readonly issues: FormValidationIssue[]) {
    super(issues[0]?.code === 'read_only' ? 'read-only' : 'invalid-operation',
      `Form validation failed (${issues.length} issue(s)): ${issues[0]?.hint}`)
    this.name = 'FormValidationError'
  }
}

type FormChange = FormFieldTarget & { value: unknown }
function valueType(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value }

/** All failures are returned together; values are deliberately excluded from diagnostic data. */
export function validateFormChanges(fields: readonly PdfFormField[], changes: readonly FormChange[],
  options: { requireVisible?: boolean; allowRepeated?: boolean } = {}): FormValidationIssue[] {
  const issues: FormValidationIssue[] = [], seen = new Set<string>()
  changes.forEach((change, index) => {
    const matches = matchingFormFields(fields, change)
    const target = change.fieldId ?? change.name
    if (matches.length !== 1) {
      issues.push({ index, property: 'fieldId', fieldId: target,
        code: matches.length ? 'ambiguous_field' : 'unknown_field',
        hint: `${matches.length ? 'Ambiguous' : 'Unknown'} form field target. Inspect the page and use its exact fieldId, not an F01 label or a shared field name.` })
      return
    }
    const field = matches[0]!, fieldId = formFieldId(field), contract = formValueContract(field)
    const issue = (code: FormIssueCode, hint: string, property: 'fieldId' | 'value' = 'value') => {
      issues.push({ index, property, fieldId, fieldName: field.name, fieldType: field.type,
        pages: [...new Set(field.widgets.map(widget => widget.page))], code,
        expected: contract.valueType, receivedType: valueType(change.value),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}), hint })
    }
    if (seen.has(fieldId) && !options.allowRepeated) issue('duplicate_field', 'Duplicate field: submit this field only once in a batch.', 'fieldId')
    seen.add(fieldId)
    if (field.type === 'unsupported') { issue('unsupported_field_type', contract.hint, 'fieldId'); return }
    if (field.readOnly) { issue('read_only', 'This form field is read only; do not retry writing it.', 'fieldId'); return }
    if (options.requireVisible && !field.widgets.length) {
      issue('field_not_visible', 'This field has no visible control; inspect a visible field instead.', 'fieldId'); return
    }
    const { value } = change
    const validType = contract.valueType === 'string[]'
      ? Array.isArray(value) && value.every(item => typeof item === 'string')
      : typeof value === contract.valueType
    if (!validType) { issue('value_type_mismatch', contract.hint); return }
    if (field.type === 'text' && field.maxLength !== undefined && [...value as string].length > field.maxLength) {
      issue('value_too_long', `The value exceeds the maximum length of ${field.maxLength} Unicode characters.`)
    }
    if ((field.type === 'radio' || field.type === 'dropdown') && value !== '' && !field.options?.includes(value as string)
      || field.type === 'option-list' && (value as string[]).some(item => !field.options?.includes(item))) {
      issue('invalid_option', `Invalid ${field.type} option; inspect the page and use exact values from options.`)
    }
    if (field.type === 'option-list' && field.multiple === false && (value as string[]).length > 1) {
      issue('too_many_selections', 'This list allows at most one selected option.')
    }
  })
  return issues
}

/** Convert an already validated input to the canonical draft representation. */
export function projectedFormValue(field: PdfFormField, value: PdfFormField['value']): PdfFormField['value'] {
  return field.type === 'dropdown' ? value === '' ? [] : [value as string] : Array.isArray(value) ? [...value] : value
}
