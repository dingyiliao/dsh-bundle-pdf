import assert from 'node:assert/strict'
import test from 'node:test'
import { numberedFillFormSchema, numberedReference, resolveNumberedFormInput } from '../../../../src/adapters/host/dsh/form-input.ts'
import { createFormInspectionRegistry, inspectFormPage } from '../../../../src/modules/forms/index.ts'
import { loadPdfDocument } from '../../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { acroformFixture } from '../../../fixtures/acroform.ts'

test('numbered input stays bounded and maps fallback diagnostic references without exposing native identities', async () => {
  const document = await loadPdfDocument(await acroformFixture())
  const store = createFormInspectionRegistry(), identity = { sessionId: 'owner', documentId: 'doc', revision: 1,
    contentVersion: 'version', sourceDigest: 'digest' }
  const page = inspectFormPage(document, 1), id = store.issue(identity, page, document), bindings = store.resolve(id, identity, 1)
  const input = numberedFillFormSchema.parse({ documentId: 'doc', expectedRevision: 1, inspectionId: id,
    fields: [{ label: 'F01', value: 'Alex' }] })
  assert.deepEqual(numberedReference(input, bindings, page.fields[1].fieldId), { label: 'F02' })
  assert.equal(numberedReference(input, bindings, 'missing'), null)
  assert.equal(resolveNumberedFormInput(input, bindings, 1).fields[0].fieldId, page.fields[0].fieldId)
  assert.equal(numberedFillFormSchema.safeParse({ ...input, fields: [] }).success, false)
  assert.equal(numberedFillFormSchema.safeParse({ ...input, dryRun: true }).success, false)
  assert.equal(numberedFillFormSchema.safeParse({ ...input, inspectionIds: [id] }).success, false)
  assert.equal(numberedFillFormSchema.safeParse({ ...input, fields: [{ page: 1, label: 'F01', value: 'Alex' }] }).success, false)
  assert.equal(numberedFillFormSchema.safeParse({ ...input, fields: [{ fieldId: 'pdf-field:1:0', value: 'Alex' }] }).success, false)
  const condition = { fields: [{ label: 'F01' }], when: { sharedFieldKey: 'G2', equals: true }, evidence: { quote: 'Only if selected' } }
  assert.equal(numberedFillFormSchema.safeParse({ ...input, conditions: [condition] }).success, true)
  for (const when of [{ label: 'F02', sharedFieldKey: 'G2', equals: true }, { equals: true },
    { page: 2, label: 'F02', equals: true }, { sharedFieldKey: 'field-id', equals: true }]) {
    assert.equal(numberedFillFormSchema.safeParse({ ...input, conditions: [{ ...condition, when }] }).success, false)
  }
  assert.equal(numberedFillFormSchema.safeParse({ ...input,
    conditions: [{ ...condition, evidence: { page: 2, quote: 'Only if selected' } }] }).success, false)
  assert.equal(numberedFillFormSchema.safeParse({ ...input, answers: [{ page: 1, questionId: 'Q1', value: 'Alex' }] }).success, false)
  assert.equal(numberedFillFormSchema.safeParse({ ...input,
    fields: Array.from({ length: 8 }, () => ({ label: 'F01', value: 'x'.repeat(8000) })) }).success, false)
  store.dispose()
})
