import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFormFields, encodeFormEdits } from '../../../src/adapters/host/pdfium/document-forms.js'
import { FormValidationError } from '../../../src/modules/forms/index.js'

const fields = decodeFormFields([
  { type: 'text', name: 'name', objectNumber: 14, generation: 3, value: '', multiline: false,
    widgets: [], readOnly: false, required: true },
  { type: 'unsupported', name: 'signature', objectNumber: 22, generation: 0, value: '',
    widgets: [], readOnly: true, required: false },
])

test('native form edit encoding rejects invalid and out-of-range PDF identities', () => {
  const change = { type: 'set-field', name: 'name', value: 'Sample' } as const
  for (const id of [undefined, 'legacy-name', 'pdf-field:0:0', 'pdf-field:4294967295:0', 'pdf-field:1:4294967295']) {
    assert.throws(() => encodeFormEdits([{ ...fields[0]!, id }], [change]),
      { code: 'invalid-operation', message: 'The form field has no native identity.' })
  }
  assert.deepEqual(encodeFormEdits(fields, [change]), [{ objectNumber: 14, generation: 3, type: 'text', value: 'Sample' }])
})

test('native form edit encoding uses shared validation for unsupported fields and mismatched values', () => {
  assert.throws(() => encodeFormEdits(fields, [
    { type: 'set-field', fieldId: 'pdf-field:22:0', value: 'Sample' },
    { type: 'set-field', fieldId: 'pdf-field:14:3', value: true },
  ]), (error: unknown) => {
    assert.ok(error instanceof FormValidationError)
    assert.deepEqual(error.issues.map(issue => issue.code), ['unsupported_field_type', 'value_type_mismatch'])
    return true
  })
})
