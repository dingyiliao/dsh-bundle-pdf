import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib'
import { applyFormChanges, inspectFormFields } from '../../../src/adapters/host/pdf-lib/form-fields.js'

const fontPath = new URL('../../../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)

test('full save replay survives cleared histories and radio-only edits without a fatal fontkit exception', async () => {
  const run = promisify(execFile)
  for (const mode of ['history-clear', 'radio-only', 'plain-clear']) {
    const { stdout, stderr } = await run(process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../../fixtures/form-save-replay.ts', import.meta.url)), mode],
      { timeout: 15_000, maxBuffer: 128_000 })
    assert.equal(stderr, '')
    assert.deepEqual(JSON.parse(stdout), { text: '', checkbox: false, radio: mode === 'radio-only' ? 'second' : '' })
  }
})

test('author-supplied field hints remain metadata, support Unicode and are bounded', async () => {
  const document = await fixture(), field = document.getForm().getTextField('name')
  field.acroField.dict.set(PDFName.of('TU'), PDFString.of('Name hint'))
  assert.equal(inspectFormFields(document)[0].description, 'Name hint')
  field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('姓名'.repeat(200)))
  assert.equal(inspectFormFields(document)[0].description!.length, 256)
  field.acroField.dict.set(PDFName.of('TU'), PDFName.of('NotText'))
  assert.equal(inspectFormFields(document)[0].description, undefined)
})

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

test('font selection accounts for final list options, including a cleared Unicode list', async () => {
  const document = await fixture(), form = document.getForm()
  const list = form.createOptionList('unicode-list')
  list.addToPage(document.getPages()[0], { x: 20, y: 300, width: 140, height: 60 })
  list.setOptions(['第一项', '第二项']); list.select('第一项')
  await applyFormChanges(document, [{ name: 'unicode-list', value: [] }], new Uint8Array(await readFile(fontPath)))
  const reopened = (await PDFDocument.load(await document.save({ updateFieldAppearances: false }))).getForm()
  assert.deepEqual(reopened.getOptionList('unicode-list').getSelected(), [])
  assert.deepEqual(reopened.getOptionList('unicode-list').getOptions(), ['第一项', '第二项'])
})

test('an unchanged Unicode field with missing appearance is included in the font plan', async () => {
  const document = await fixture(), field = document.getForm().getTextField('name')
  field.setText('保留文字')
  field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'))
  document.getForm().markFieldAsClean(field.ref)
  await applyFormChanges(document, [{ name: 'agreed', value: true }], new Uint8Array(await readFile(fontPath)))
  const reopened = (await PDFDocument.load(await document.save({ updateFieldAppearances: false }))).getForm()
  assert.equal(reopened.getTextField('name').getText(), '保留文字')
  assert.ok(reopened.getTextField('name').acroField.getWidgets()[0].getAppearances()?.normal)
})

test('widgetless values and multiline control-only text do not allocate an unused CJK subset', async () => {
  const document = await fixture(), form = document.getForm()
  form.createTextField('not-rendered')
  form.getTextField('name').enableMultiline()
  await applyFormChanges(document, [{ name: 'not-rendered', value: '未绘制' }, { name: 'name', value: '\n\r\b\v\f' }],
    new Uint8Array(await readFile(fontPath)))
  const reopened = (await PDFDocument.load(await document.save({ updateFieldAppearances: false }))).getForm()
  assert.equal(reopened.getTextField('not-rendered').getText(), '未绘制')
  assert.equal(reopened.getTextField('name').getText(), '\n\r\b\v\f')
})

test('AcroForm rejects unsupported choices and does not modify read-only fields', async () => {
  const document = await fixture()
  const font = new Uint8Array(await readFile(fontPath))
  await assert.rejects(applyFormChanges(document, [{ name: 'choice', value: 'missing' }], font), /Invalid dropdown option/)
  document.getForm().getTextField('name').enableReadOnly()
  await assert.rejects(applyFormChanges(document, [{ name: 'name', value: 'changed' }], font), /read only/)
})

test('clearing radio, dropdown and list choices survives materialization and reopening without resurrecting defaults', async () => {
  const document = await fixture(), form = document.getForm(), page = document.getPages()[0]
  const radio = form.createRadioGroup('radio')
  radio.addOptionToPage('first', page, { x: 20, y: 300, width: 20, height: 20 })
  const list = form.createOptionList('list')
  list.addOptions(['first']); list.addToPage(page, { x: 20, y: 250, width: 120, height: 30 })
  const dropdown = form.getDropdown('choice')
  radio.select('first'); dropdown.select('second'); list.select('first')
  for (const field of [radio, dropdown, list]) field.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('first'))
  await applyFormChanges(document, [{ name: 'radio', value: '' }, { name: 'choice', value: '' }, { name: 'list', value: [] }],
    new Uint8Array(await readFile(fontPath)))
  const reopened = await PDFDocument.load(await document.save({ updateFieldAppearances: false }))
  assert.equal(reopened.getForm().getRadioGroup('radio').getSelected(), undefined)
  assert.deepEqual(reopened.getForm().getDropdown('choice').getSelected(), [])
  assert.deepEqual(reopened.getForm().getOptionList('list').getSelected(), [])
  for (const field of reopened.getForm().getFields().filter(field => field.getName() !== 'name' && field.getName() !== 'agreed')) {
    assert.ok(field.acroField.dict.has(PDFName.of('V')))
    assert.ok(field.acroField.dict.has(PDFName.of('DV')), 'Clearing does not rewrite the PDF reset default')
  }
})

test('canonical writer validates a whole history before changing any native field', async () => {
  const document = await fixture()
  document.getForm().getTextField('name').setText('before')
  await assert.rejects(applyFormChanges(document, [
    { name: 'name', value: 'after' }, { name: 'agreed', value: 'Yes' }, { name: 'choice', value: 'unknown' },
  ], new Uint8Array()), error => {
    assert.ok(error instanceof Error && 'issues' in error)
    assert.equal((error.issues as unknown[]).length, 2)
    return true
  })
  assert.equal(document.getForm().getTextField('name').getText(), 'before')
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
