import assert from 'node:assert/strict'
import test from 'node:test'
import { checkFormChoiceGroups, formChoiceGroupSchema, FormChoiceError } from '../../../src/modules/forms/index.ts'
import { loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { projectFormOperations } from '../../../src/modules/working-copy/index.ts'
import { duplicateFieldNamesFixture } from '../../fixtures/acroform.ts'

test('printed exclusive checkbox groups validate final values, including existing selections and explicit unchecks', async () => {
  const doc = await loadPdfDocument(await duplicateFieldNamesFixture())
  const boxes = doc.formFields!.filter(field => field.type === 'checkbox')
  const group = { fieldIds: boxes.map(field => field.id!), evidence: { page: 1, quote: 'Select one option only' } }
  const project = (values: Array<[string, boolean]>) => projectFormOperations(doc,
    values.map(([fieldId, value]) => ({ type: 'set-field' as const, fieldId, value })))
  assert.equal(formChoiceGroupSchema.safeParse(group).success, true)
  assert.equal(checkFormChoiceGroups(doc, [group]).evaluated, 1)
  const one = project([[boxes[0].id!, true]])
  assert.equal(checkFormChoiceGroups(one, [group]).source, 'model-supplied')
  const two = projectFormOperations(one, [{ type: 'set-field', fieldId: boxes[1].id!, value: true }])
  assert.throws(() => checkFormChoiceGroups(two, [group]), (error: unknown) => {
    assert.ok(error instanceof FormChoiceError)
    assert.equal(error.code, 'pdf/form-choice-failed')
    assert.deepEqual(error.issues.map(issue => issue.fieldId), boxes.slice(0, 2).map(field => field.id))
    assert.ok(error.issues.every(issue => issue.code === 'multiple_choices_selected' && issue.path === 'choiceGroups[0]'))
    assert.match(error.issues[0].hint, /existing draft values/)
    return true
  })
  const switched = projectFormOperations(one, [{ type: 'set-field', fieldId: boxes[0].id!, value: false },
    { type: 'set-field', fieldId: boxes[1].id!, value: true }])
  assert.equal(checkFormChoiceGroups(switched, [group]).evaluated, 1)
  assert.equal(checkFormChoiceGroups(two, []).evaluated, 0, 'No inferred grouping of independent checkboxes')
})

test('choice checks reject missing, linked, non-checkbox and wrong-page groups and bound the complete batch', async () => {
  const doc = await loadPdfDocument(await duplicateFieldNamesFixture())
  const boxes = doc.formFields!.filter(field => field.type === 'checkbox')
  const group = { fieldIds: boxes.map(field => field.id!), evidence: { page: 1, quote: 'Choose one' } }
  for (const invalid of [
    { ...group, fieldIds: [] }, { ...group, fieldIds: [boxes[0].id!, boxes[0].id!] },
    { ...group, fieldIds: [boxes[0].id!, 'missing'] }, { ...group, fieldIds: [boxes[0].id!, doc.formFields![0].id!] },
    { ...group, evidence: { ...group.evidence, page: 2 } }, { ...group, evidence: { ...group.evidence, page: 3 } },
  ]) assert.throws(() => checkFormChoiceGroups(doc, [invalid]), (error: unknown) => {
    assert.ok(error instanceof FormChoiceError)
    assert.equal(error.issues[0].code, 'invalid_choice_group'); return true
  })
  assert.throws(() => checkFormChoiceGroups({ ...doc, formFields: undefined }, [group]), FormChoiceError)
  assert.throws(() => checkFormChoiceGroups(doc, Array.from({ length: 34 }, () => group)), (error: unknown) => {
    assert.ok(error instanceof FormChoiceError); assert.equal(error.issues[0].path, 'choiceGroups'); return true
  })
  assert.equal(formChoiceGroupSchema.safeParse({ ...group, fieldIds: [boxes[0].id!] }).success, false)
  assert.equal(formChoiceGroupSchema.safeParse({ ...group, evidence: { page: 1, quote: ' ' } }).success, false)
})
