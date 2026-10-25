import { PdfDocumentError } from '../../core/pdf-types.js'

export type FormFieldIdentity = { id?: string; name: string }
export type FormFieldTarget = { fieldId: string; name?: never } | { name: string; fieldId?: never }

/** Names are display/legacy lookup keys, not identities: distinct fields can share one. */
export function formFieldId(field: FormFieldIdentity): string { return field.id ?? field.name }

export function matchingFormFields<T extends FormFieldIdentity>(fields: readonly T[], target: FormFieldTarget): T[] {
  return target.fieldId !== undefined ? fields.filter(field => formFieldId(field) === target.fieldId)
    : fields.filter(field => field.name === target.name)
}

/** Old name-based drafts remain readable only when the target is unambiguous. */
export function resolveFormField<T extends FormFieldIdentity>(fields: readonly T[], target: FormFieldTarget): T {
  const matches = matchingFormFields(fields, target)
  if (matches.length > 1) throw new PdfDocumentError('invalid-operation',
    'Ambiguous form field target; inspect the page and use its exact fieldId instead of a shared name')
  if (!matches.length) throw new PdfDocumentError('invalid-operation', 'Unknown form field target')
  return matches[0]!
}
