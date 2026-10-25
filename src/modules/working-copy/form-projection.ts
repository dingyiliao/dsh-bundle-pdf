import { PdfDocumentError, type PdfDocumentInfo, type PdfFormOperation } from '../../core/pdf-types.js'
import { resolveFormField, validateFormChanges, FormValidationError, projectedFormValue } from '../forms/index.js'

/** Validate and project field values without modifying PDF bytes; save performs the same checks on the canonical tree. */
export function projectFormOperations(document: PdfDocumentInfo, operations: readonly PdfFormOperation[],
  options: { requireVisible?: boolean } = {}): PdfDocumentInfo {
  if (!operations.length) return document
  if (document.readOnly || document.formKind !== 'acroform' || !document.formFields) {
    throw new PdfDocumentError('read-only', 'This PDF has no editable AcroForm fields.')
  }
  const issues = validateFormChanges(document.formFields, operations, options)
  if (issues.length) throw new FormValidationError(issues)
  const fields = document.formFields.map(field => ({ ...field }))
  for (const operation of operations) {
    const field = resolveFormField(fields, operation)
    field.value = projectedFormValue(field, operation.value)
  }
  return { ...document, formFields: fields }
}
