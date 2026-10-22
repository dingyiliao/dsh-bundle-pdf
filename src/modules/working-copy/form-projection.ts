import { PdfDocumentError, type PdfDocumentInfo, type PdfFormOperation } from '../../core/pdf-types.js'
import { formFieldId, resolveFormField } from '../forms/index.js'

/** Validate and project field values without modifying PDF bytes; save performs the same checks on the canonical tree. */
export function projectFormOperations(document: PdfDocumentInfo, operations: readonly PdfFormOperation[]): PdfDocumentInfo {
  if (!operations.length) return document
  if (document.readOnly || document.formKind !== 'acroform' || !document.formFields) {
    throw new PdfDocumentError('read-only', 'This PDF has no editable AcroForm fields.')
  }
  const fields = document.formFields.map(field => ({ ...field }))
  const identities = new Set<string>()
  for (const operation of operations) {
    const { value } = operation
    const field = resolveFormField(fields, operation), name = field.name
    const identity = formFieldId(field)
    if (identities.has(identity)) throw new PdfDocumentError('invalid-operation', 'Duplicate form field in this batch')
    identities.add(identity)
    if (field.readOnly) throw new PdfDocumentError('read-only', `Form field is read only: ${name}`)
    switch (field.type) {
      case 'text':
        if (typeof value !== 'string' || field.maxLength !== undefined && [...value].length > field.maxLength) break
        field.value = value
        continue
      case 'checkbox':
        if (typeof value !== 'boolean') break
        field.value = value
        continue
      case 'radio':
        if (typeof value !== 'string' || !field.options?.includes(value)) break
        field.value = value
        continue
      case 'dropdown':
        if (typeof value !== 'string' || !field.options?.includes(value)) break
        field.value = [value]
        continue
      case 'option-list':
        if (!Array.isArray(value) || value.some(item => !field.options?.includes(item))) break
        if (field.multiple === false && value.length > 1) break
        field.value = [...value]
        continue
    }
    throw new PdfDocumentError('invalid-operation', `Unsupported value or form field type: ${name}`)
  }
  return { ...document, formFields: fields }
}
