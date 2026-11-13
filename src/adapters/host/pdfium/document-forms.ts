import type { PdfFormField, PdfFormOperation } from '../../../core/pdf-types.js'
import { PdfDocumentError } from '../../../core/pdf-types.js'
import { FormValidationError, resolveFormField, validateFormChanges } from '../../../modules/forms/index.js'
import type { NativeFormEdit, NativeFormField } from '../../../engine/protocol/forms.js'

export function decodeFormFields(fields: readonly NativeFormField[], documentReadOnly = false): PdfFormField[] {
  return fields.map(({ objectNumber, generation, ...field }) => ({
    ...field,
    id: `pdf-field:${objectNumber}:${generation}`,
    readOnly: documentReadOnly || field.readOnly,
  }))
}

/** Replay history against stable field identities. The native layer validates
 * the actual field tree again before writing values or regenerating widgets. */
export function encodeFormEdits(fields: readonly PdfFormField[], operations: readonly PdfFormOperation[]): NativeFormEdit[] {
  const issues = validateFormChanges(fields, operations, { allowRepeated: true })
  if (issues.length) throw new FormValidationError(issues)
  return operations.map(operation => {
    // Validation above rejects unsupported targets before any edit is encoded.
    const field = resolveFormField(fields, operation) as PdfFormField & { type: NativeFormEdit['type'] }
    const match = /^pdf-field:([1-9]\d*):(0|[1-9]\d*)$/.exec(field.id ?? '')
    const objectNumber = Number(match?.[1])
    const generation = Number(match?.[2])
    if (!match || objectNumber > 0xfffffffe || generation > 0xfffffffe) {
      throw new PdfDocumentError('invalid-operation', 'The form field has no native identity.')
    }
    const identity = { objectNumber, generation }
    switch (field.type) {
      case 'text':
      case 'radio':
        return { ...identity, type: field.type, value: operation.value as string }
      case 'checkbox':
        return { ...identity, type: field.type, value: operation.value as boolean }
      case 'dropdown':
        return { ...identity, type: field.type, value: operation.value === '' ? [] : [operation.value as string] }
      case 'option-list':
        return { ...identity, type: field.type, value: operation.value as string[] }
    }
  })
}
