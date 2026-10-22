import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectFormPage } from '../../../src/modules/forms/index.ts'
import { paintFormLabels } from '../../../src/adapters/host/pdfium/form-labels.ts'
import type { PdfDocumentInfo } from '../../../src/core/pdf-types.ts'

function document(rotation = 0): PdfDocumentInfo {
  return { pageCount: 1, pages: [{ page: 1, cropBox: [10, 20, 210, 420], userUnit: 2, rotation }],
    signed: false, encrypted: false, readOnly: false, formKind: 'acroform', annotations: [],
    formFields: [{ name: 'Text1', type: 'text', value: 'Do not expose by default', readOnly: false,
      required: true, maxLength: 32, widgets: [{ page: 1, rect: [50, 100, 100, 130] }] }] }
}

test('form numbering maps exact IDs without default values and respects all rotations, crop and UserUnit', () => {
  const expected = [[51.2, 371.2, 115.2, 409.6], [102.4, 51.2, 140.8, 115.2],
    [140.8, 102.4, 204.8, 140.8], [371.2, 140.8, 409.6, 204.8]]
  for (let index = 0; index < 4; index++) {
    const inspection = inspectFormPage(document(index * 90), 1, index % 2 ? 512 : 256, index % 2 ? 256 : 512)
    const field = inspection.fields[0], control = field.controls[0]
    assert.equal(field.fieldId, 'Text1'); assert.equal(field.required, true); assert.equal(field.maxLength, 32)
    assert.equal('value' in field, false)
    assert.equal(control.label, 'F01'); assert.equal(control.fieldId, field.fieldId)
    control.rectImage.forEach((value, position) => assert.ok(Math.abs(value - expected[index][position]) < 0.001))
    assert.ok(control.labelRect[0] >= 0 && control.labelRect[2] <= inspection.width)
    assert.ok(control.labelRect[1] >= 0 && control.labelRect[3] <= inspection.height)
  }
  assert.equal(inspectFormPage(document(), 1, 256, 512, true).fields[0].value, 'Do not expose by default')
})

test('read-only, unsupported, off-page and fully clipped widgets are not marked; radio options stay distinct', () => {
  const pdf = document()
  pdf.formFields!.push({ ...pdf.formFields![0], name: 'locked', readOnly: true },
    { ...pdf.formFields![0], name: 'unknown', type: 'unsupported' },
    { ...pdf.formFields![0], name: 'outside', widgets: [{ page: 1, rect: [-100, -100, 0, 0] }] },
    { name: 'contact', type: 'radio', value: '', options: ['a', 'b'], readOnly: false, required: false,
      widgets: [{ page: 1, option: 'a', rect: [100, 200, 110, 210] }, { page: 1, option: 'b', rect: [150, 200, 160, 210] },
        { page: 2, option: 'b', rect: [150, 200, 160, 210] }] })
  const inspection = inspectFormPage(pdf, 1, 256, 512)
  assert.deepEqual(inspection.fields.map(field => field.fieldId), ['Text1', 'contact'])
  assert.deepEqual(inspection.fields[1].controls.map(control => [control.label, control.fieldId, control.option]),
    [['F02', 'contact', 'a'], ['F03', 'contact', 'b']])
  assert.deepEqual(inspectFormPage({ ...pdf, readOnly: true }, 1, 256, 512).fields, [])
})

test('numbered raster decoration is bounded, readable and does not modify document metadata', () => {
  const pdf = document(), before = structuredClone(pdf)
  const inspection = inspectFormPage(pdf, 1, 256, 512)
  const raster = new Uint8Array(256 * 512 * 4).fill(255)
  const marker = inspection.fields[0].controls[0]
  paintFormLabels(raster, 256, 512, [marker])
  const at = (x: number, y: number) => [...raster.slice((Math.floor(y) * 256 + Math.floor(x)) * 4,
    (Math.floor(y) * 256 + Math.floor(x)) * 4 + 4)]
  assert.deepEqual(at(marker.labelRect[0] + 1, marker.labelRect[1] + 1), [24, 83, 201, 255])
  assert.deepEqual(at(marker.labelRect[0] + 4, marker.labelRect[1] + 3), [255, 255, 255, 255])
  assert.deepEqual(at(marker.rectImage[0] + 1, marker.rectImage[1] + 1), [24, 83, 201, 255])
  assert.deepEqual(pdf, before)
  assert.throws(() => paintFormLabels(new Uint8Array(1), 256, 512, [marker]), /raster/)
})

test('a control against the top page edge places its number below the control', () => {
  const pdf = document()
  pdf.formFields![0].widgets = [{ page: 1, rect: [50, 400, 100, 420] }]
  const marker = inspectFormPage(pdf, 1, 256, 512).fields[0].controls[0]
  assert.equal(marker.rectImage[1], 0)
  assert.equal(marker.labelRect[1], marker.rectImage[3] + 2)
  assert.ok(marker.labelRect[3] <= 512)
})

test('inspection fails closed instead of truncating ambiguous or oversized mappings', () => {
  assert.throws(() => inspectFormPage(document(), 2, 256, 512), /outside/)
  assert.throws(() => inspectFormPage(document(), 1, 0, 512), /size/)
  assert.throws(() => inspectFormPage(document(), 1, 20, 512), /narrow/)
  const duplicate = document(); duplicate.formFields!.push(duplicate.formFields![0])
  assert.throws(() => inspectFormPage(duplicate, 1, 256, 512), /Duplicate/)
  const crowded = document()
  crowded.formFields![0].widgets = Array.from({ length: 101 }, () => ({ page: 1, rect: [50, 100, 100, 130] }))
  assert.throws(() => inspectFormPage(crowded, 1, 256, 512), /100 visible/)
})
