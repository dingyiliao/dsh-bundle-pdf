import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from 'pdf-lib'
import { applyFormChanges, inspectFormFields } from '../../../src/adapters/host/pdf-lib/form-fields.js'

const fontPath = new URL('../../../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)

async function fixture() {
  const document = await PDFDocument.create()
  const page = document.addPage([400, 600])
  const form = document.getForm()
  form.createTextField('name').addToPage(page, { x: 20, y: 500, width: 180, height: 24 })
  form.createCheckBox('agreed').addToPage(page, { x: 20, y: 460, width: 20, height: 20 })
  const choice = form.createDropdown('choice')
  choice.addOptions(['first', 'second'])
  choice.addToPage(page, { x: 20, y: 420, width: 120, height: 24 })
  return document
}

test('AcroForm inspection maps canonical fields to page widgets and respects document locks', async () => {
  const document = await fixture()
  const fields = inspectFormFields(document)
  assert.deepEqual(fields.map(field => [field.name, field.type]), [
    ['name', 'text'], ['agreed', 'checkbox'], ['choice', 'dropdown'],
  ])
  assert.deepEqual(fields[0].widgets, [{ page: 1, rect: [19.5, 499.5, 200.5, 524.5] }])
  assert.ok(fields.every(field => !field.readOnly))
  assert.ok(inspectFormFields(document, true).every(field => field.readOnly))
})

test('AcroForm changes preserve Unicode values and regenerate widget appearances on save', async () => {
  const document = await fixture()
  const font = new Uint8Array(await readFile(fontPath))
  await applyFormChanges(document, [
    { name: 'name', value: '测试表单' },
    { name: 'agreed', value: true },
    { name: 'choice', value: 'second' },
  ], font)
  const reopened = await PDFDocument.load(await document.save({ updateFieldAppearances: false }))
  assert.equal(reopened.getForm().getTextField('name').getText(), '测试表单')
  assert.equal(reopened.getForm().getCheckBox('agreed').isChecked(), true)
  assert.deepEqual(reopened.getForm().getDropdown('choice').getSelected(), ['second'])
  for (const field of reopened.getForm().getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      const appearance = widget.dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))
      assert.ok(appearance instanceof PDFRef || appearance instanceof PDFDict)
    }
  }
})

test('clearing a text field persists an explicit empty value and saves without an empty CFF subset', async () => {
  const document = await fixture()
  const field = document.getForm().getTextField('name')
  field.setText('remove this value')
  field.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('default value'))
  await applyFormChanges(document, [{ name: 'name', value: '' }], new Uint8Array(await readFile(fontPath)))

  const reopened = await PDFDocument.load(await document.save({ updateFieldAppearances: false }))
  const cleared = reopened.getForm().getTextField('name')
  assert.equal(cleared.getText(), '')
  assert.equal(cleared.acroField.getValue()?.decodeText(), '')
  assert.ok(cleared.acroField.dict.get(PDFName.of('DV')) instanceof PDFHexString)
})

test('AcroForm rejects unsupported choices and does not modify read-only fields', async () => {
  const document = await fixture()
  const font = new Uint8Array(await readFile(fontPath))
  await assert.rejects(applyFormChanges(document, [{ name: 'choice', value: 'missing' }], font), /Invalid dropdown option/)
  document.getForm().getTextField('name').enableReadOnly()
  await assert.rejects(applyFormChanges(document, [{ name: 'name', value: 'changed' }], font), /read only/)
})

test('the canonical writer refuses overlong values before changing a field', async () => {
  const document = await fixture()
  const field = document.getForm().getTextField('name')
  field.setMaxLength(4)
  field.setText('kept')
  await assert.rejects(applyFormChanges(document, [{ name: 'name', value: 'too long' }], new Uint8Array()),
    { code: 'invalid-operation' })
  assert.equal(field.getText(), 'kept')
})
