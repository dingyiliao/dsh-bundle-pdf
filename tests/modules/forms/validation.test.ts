import assert from 'node:assert/strict'
import test from 'node:test'
import { formValueContract, validateFormChanges, FormValidationError, resolveFormField,
  inspectFormPage, modelFormInspectionFields } from '../../../src/modules/forms/index.ts'
import { projectFormOperations } from '../../../src/modules/working-copy/index.ts'
import type { PdfDocumentInfo, PdfFormField } from '../../../src/core/pdf-types.ts'

const field = (type: PdfFormField['type'], extra: Partial<PdfFormField> = {}): PdfFormField => ({
  id: `id-${type}`, name: type, type, value: '', required: false, readOnly: false,
  widgets: [{ page: 2, rect: [10, 10, 30, 30] }], ...extra,
})

test('inspection contracts explain exact values without interpreting labels or guessing booleans', () => {
  assert.deepEqual(formValueContract(field('checkbox')).examples, [true, false])
  assert.equal(formValueContract(field('text', { maxLength: 2 })).examples[1], 'Ex')
  assert.equal(formValueContract(field('text')).valueType, 'string')
  assert.deepEqual(formValueContract(field('radio', { options: ['yes-code'] })).examples, ['yes-code'])
  assert.deepEqual(formValueContract(field('dropdown')).examples, [])
  assert.equal(formValueContract(field('option-list')).valueType, 'string[]')
  assert.equal(formValueContract(field('unsupported')).valueType, 'unsupported')
  const checkbox = field('checkbox')
  for (const value of ['Yes', 'false', 'true', 1, null, undefined, []]) {
    const [issue] = validateFormChanges([checkbox], [{ fieldId: checkbox.id!, value }])
    assert.equal(issue.code, 'value_type_mismatch'); assert.equal(issue.expected, 'boolean')
  }
  assert.deepEqual(validateFormChanges([checkbox], [{ fieldId: checkbox.id!, value: false }]), [])
  for (const type of ['radio', 'dropdown'] as const) {
    assert.match(formValueContract(field(type)).hint, /empty string clears/)
    assert.deepEqual(validateFormChanges([field(type)], [{ fieldId: `id-${type}`, value: '' }]), [])
  }
})

test('all field failures include exact targets, indexes and constraints, never submitted values', () => {
  const fields = [field('text', { maxLength: 3 }), field('checkbox'), field('radio', { options: ['a', 'b'] }),
    field('option-list', { options: ['a', 'b'], multiple: false }), field('dropdown', { options: ['a'] }),
    field('text', { id: 'locked', name: 'locked', readOnly: true }),
    field('unsupported'), field('text', { id: 'hidden', widgets: [] })]
  const issues = validateFormChanges(fields, [
    { fieldId: 'id-text', value: 'PRIVATE-LONG-VALUE' },
    { fieldId: 'id-checkbox', value: 'PRIVATE-WRONG-BOOLEAN' },
    { fieldId: 'id-radio', value: 'PRIVATE-UNKNOWN-OPTION' },
    { fieldId: 'id-option-list', value: ['a', 'b'] },
    { fieldId: 'id-dropdown', value: [] },
    { fieldId: 'locked', value: 'PRIVATE' }, { fieldId: 'id-unsupported', value: 'PRIVATE' },
    { fieldId: 'hidden', value: 'PRIVATE' }, { fieldId: 'missing', value: 'PRIVATE' },
    { fieldId: 'id-checkbox', value: false },
  ], { requireVisible: true })
  assert.deepEqual(issues.map(issue => issue.code), ['value_too_long', 'value_type_mismatch', 'invalid_option',
    'too_many_selections', 'value_type_mismatch', 'read_only', 'unsupported_field_type', 'field_not_visible',
    'unknown_field', 'duplicate_field'])
  assert.deepEqual(issues.map(issue => issue.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(issues[0].maxLength, 3); assert.deepEqual(issues[1].pages, [2])
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE/)
  assert.equal(new FormValidationError([issues[5]]).code, 'read-only')
  assert.equal(new FormValidationError(issues).code, 'invalid-operation')
})

test('projection and history validation share types, options, Unicode lengths and identity rules', () => {
  const fields = [field('text', { maxLength: 1 }), field('dropdown', { options: ['a'] }),
    field('option-list', { options: ['a', 'b'], multiple: true })]
  const document: PdfDocumentInfo = { pageCount: 2, pages: [], signed: false, encrypted: false,
    readOnly: false, formKind: 'acroform', annotations: [], formFields: fields }
  const projected = projectFormOperations(document, [
    { type: 'set-field', fieldId: 'id-text', value: '𝑅' },
    { type: 'set-field', fieldId: 'id-dropdown', value: 'a' },
    { type: 'set-field', fieldId: 'id-option-list', value: ['a', 'b'] },
  ])
  assert.deepEqual(projected.formFields!.map(item => item.value), ['𝑅', ['a'], ['a', 'b']])
  assert.deepEqual(projectFormOperations(projected, [{ type: 'set-field', fieldId: 'id-dropdown', value: '' }])
    .formFields![1].value, [])
  assert.equal(document.formFields![0].value, '')
  assert.equal(validateFormChanges(fields, [{ fieldId: 'id-option-list', value: ['unknown'] }])[0].code, 'invalid_option')
  assert.equal(validateFormChanges(fields, [{ fieldId: 'id-option-list', value: [1] }])[0].code, 'value_type_mismatch')
  const repeated = [{ fieldId: 'id-text', value: 'a' }, { fieldId: 'id-text', value: 'b' }]
  assert.deepEqual(validateFormChanges(fields, repeated, { allowRepeated: true }), [])
  const sameName = [field('text', { id: 'a' }), field('text', { id: 'b' })]
  assert.throws(() => resolveFormField(sameName, { name: 'text' }), /Ambiguous/)
  assert.throws(() => resolveFormField(sameName, { fieldId: 'missing' }), /Unknown/)
  assert.equal(validateFormChanges(sameName, [{ name: 'text', value: 'a' }])[0].code, 'ambiguous_field')
  assert.deepEqual(validateFormChanges(sameName, [{ fieldId: 'b', value: 'a' }]), [])
})

test('dropdown inspection and fill round-trip one string while native and draft values remain selected-option arrays', () => {
  const document: PdfDocumentInfo = { pageCount: 2, signed: false, encrypted: false, readOnly: false, formKind: 'acroform', annotations: [],
    pages: [1, 2].map(page => ({ page, cropBox: [0, 0, 200, 300], userUnit: 1, rotation: 0 })),
    formFields: [field('dropdown', { options: ['a', 'b'], value: ['a'] })] }
  for (const value of ['b', '']) {
    const updated = projectFormOperations(document, [{ type: 'set-field', fieldId: 'id-dropdown', value }])
    const field = modelFormInspectionFields(inspectFormPage(updated, 2, 512, true), updated)[0]
    assert.equal(field.type, 'dropdown'); assert.equal(field.valueType, 'string'); assert.equal(field.value, value)
    assert.deepEqual(validateFormChanges(updated.formFields!, [{ fieldId: 'id-dropdown', value: field.value }]), [])
    const readBack = projectFormOperations(updated, [{ type: 'set-field', fieldId: 'id-dropdown', value: field.value! }])
    assert.deepEqual(readBack.formFields![0].value, value === '' ? [] : [value])
    assert.deepEqual(updated.formFields![0].value, value === '' ? [] : [value])
  }
  assert.deepEqual(document.formFields![0].value, ['a'])
})
