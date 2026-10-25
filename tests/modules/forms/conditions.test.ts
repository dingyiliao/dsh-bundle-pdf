import assert from 'node:assert/strict'
import test from 'node:test'
import { checkFormConditions, FormConditionError, type FormCondition } from '../../../src/modules/forms/index.ts'
import { loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { projectFormOperations } from '../../../src/modules/working-copy/index.ts'
import { acroformFixture } from '../../fixtures/acroform.ts'

test('conditional details evaluate final values; false/unknown reject writes, clearing and existing values are preserved', async () => {
  const doc = await loadPdfDocument(await acroformFixture())
  const ids = Object.fromEntries(doc.formFields!.map(field => [field.name, field.id!]))
  const rule: FormCondition = { fieldIds: [ids.Text1], when: { fieldId: ids.accepted, equals: true },
    evidence: { page: 1, quote: 'Only if accepted, provide details' }, onInactive: 'preserve' }
  const project = (values: Array<[string, string | boolean | string[]]>) => projectFormOperations(doc,
    values.map(([fieldId, value]) => ({ type: 'set-field' as const, fieldId, value })))
  const validate = (after: typeof doc, submitted: string[], conditions = [rule]) =>
    checkFormConditions(doc, after, new Set(submitted), conditions)
  assert.equal(validate(project([[ids.Text1, 'Alex'], [ids.accepted, true]]), [ids.Text1, ids.accepted]).evaluated, 1)
  assert.throws(() => validate(project([[ids.Text1, 'Alex']]), [ids.Text1]), (error: unknown) => {
    assert.ok(error instanceof FormConditionError); assert.equal(error.issues[0].code, 'condition_not_met')
    assert.doesNotMatch(JSON.stringify(error.issues), /Alex|Demo/); return true
  })
  const unknown = { ...rule, when: { fieldId: ids.contact, equals: 'phone' } }
  assert.throws(() => validate(project([[ids.Text1, 'Alex']]), [ids.Text1], [unknown]), (error: unknown) => {
    assert.ok(error instanceof FormConditionError); assert.equal(error.issues[0].code, 'condition_unknown'); return true
  })
  assert.deepEqual(validate(project([[ids.Text1, '']]), [ids.Text1]).retainedInactiveFieldIds, [])
  assert.deepEqual(validate(doc, []).retainedInactiveFieldIds, [ids.Text1])
  const dropdown = { ...rule, when: { fieldId: ids.choice, equals: 'second' } }
  assert.equal(validate(project([[ids.choice, 'second'], [ids.Text1, 'Alex']]), [ids.Text1, ids.choice], [dropdown]).evaluated, 1)
  const readOnly = { ...doc, formFields: doc.formFields!.map(field => field.id === ids.accepted ? { ...field, readOnly: true } : field) }
  assert.deepEqual(checkFormConditions(readOnly, readOnly, new Set(), [rule]).retainedInactiveFieldIds, [ids.Text1])
  assert.throws(() => validate(doc, [], Array.from({ length: 101 }, () => rule)), /No fields were changed/)
})

test('inactive fields must be empty by default even when not submitted; authorized clearing is explicit and atomic', async () => {
  const doc = await loadPdfDocument(await acroformFixture())
  const ids = Object.fromEntries(doc.formFields!.map(field => [field.name, field.id!]))
  const rule: FormCondition = { fieldIds: [ids.Text1], when: { fieldId: ids.accepted, equals: true },
    evidence: { page: 1, quote: 'If accepted, complete the name' } }
  for (const onInactive of [undefined, 'require-empty'] as const) {
    assert.throws(() => checkFormConditions(doc, doc, new Set(), [{ ...rule, onInactive }]), (error: unknown) => {
      assert.ok(error instanceof FormConditionError)
      assert.equal(error.issues[0].code, 'condition_not_met')
      assert.equal(error.issues[0].fieldId, ids.Text1)
      assert.match(error.issues[0].hint, /automatically cleared/)
      return true
    })
  }
  assert.equal(doc.formFields![0].value, 'Demo', 'Validation never deletes retained values')
  const cleared = projectFormOperations(doc, [{ type: 'set-field', fieldId: ids.Text1, value: '' }])
  assert.deepEqual(checkFormConditions(doc, cleared, new Set([ids.Text1]), [rule]).retainedInactiveFieldIds, [])
})

test('condition rules reject unknown/self targets, bad options/types, absent controlling pages and malformed input', async () => {
  const doc = await loadPdfDocument(await acroformFixture())
  const ids = Object.fromEntries(doc.formFields!.map(field => [field.name, field.id!]))
  const rule: FormCondition = { fieldIds: [ids.Text1], when: { fieldId: ids.accepted, equals: true },
    evidence: { page: 1, quote: 'If yes, provide details' } }
  for (const invalid of [
    { ...rule, when: { fieldId: 'missing', equals: true } },
    { ...rule, fieldIds: ['missing'] }, { ...rule, fieldIds: [ids.accepted] },
    { ...rule, fieldIds: [ids.Text1, ids.Text1] },
    { ...rule, when: { fieldId: ids.accepted, equals: 'Yes' } },
    { ...rule, when: { fieldId: ids.contact, equals: 'fax' } },
    { ...rule, evidence: { ...rule.evidence, page: 2 } }, { ...rule, evidence: { ...rule.evidence, page: 3 } },
  ]) assert.throws(() => checkFormConditions(doc, doc, new Set(), [invalid]), (error: unknown) => {
    assert.ok(error instanceof FormConditionError); assert.equal(error.issues[0].code, 'invalid_condition'); return true
  })
})
