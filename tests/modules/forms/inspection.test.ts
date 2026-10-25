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

test('in-field numbering respects all rotations, crop and UserUnit without exposing values by default', () => {
  const expected = [[.2, .725, .45, .8], [.2, .2, .275, .45],
    [.55, .2, .8, .275], [.725, .55, .8, .8]]
  for (let index = 0; index < 4; index++) {
    const inspection = inspectFormPage(document(index * 90), 1, 512)
    const field = inspection.fields[0], control = field.controls[0]
    assert.equal(field.fieldId, 'Text1'); assert.equal(field.required, true); assert.equal(field.maxLength, 32)
    assert.equal(field.valueContract.valueType, 'string'); assert.equal('value' in field, false)
    assert.equal(control.label, 'F01'); assert.equal(control.fieldId, field.fieldId)
    assert.deepEqual(inspection.pageRect, [0, 0, inspection.width, inspection.height])
    control.rectImage.forEach((value, position) => {
      const normalized = value / (position % 2 ? inspection.height : inspection.width)
      assert.ok(Math.abs(normalized - expected[index][position]) < .001)
      assert.ok(position < 2 ? control.labelRect[position] > value : control.labelRect[position] < value)
    })
  }
  assert.equal(inspectFormPage(document(), 1, 512, true).fields[0].value, 'Do not expose by default')
})

test('read-only, unsupported, off-page and clipped widgets are not marked; radio options stay distinct', () => {
  const pdf = document()
  pdf.formFields!.push({ ...pdf.formFields![0], name: 'locked', readOnly: true },
    { ...pdf.formFields![0], name: 'unknown', type: 'unsupported' },
    { ...pdf.formFields![0], name: 'outside', widgets: [{ page: 1, rect: [-100, -100, 0, 0] }] },
    { name: 'contact', type: 'radio', value: '', options: ['a', 'b'], readOnly: false, required: false,
      widgets: [{ page: 1, option: 'a', rect: [100, 200, 110, 210] }, { page: 1, option: 'b', rect: [150, 200, 160, 210] },
        { page: 2, option: 'b', rect: [150, 200, 160, 210] }] })
  const inspection = inspectFormPage(pdf, 1, 1024)
  assert.deepEqual(inspection.fields.map(field => field.fieldId), ['Text1', 'contact'])
  assert.deepEqual(inspection.fields[1].controls.map(control => [control.label, control.fieldId, control.option]),
    [['F02', 'contact', 'a'], ['F03', 'contact', 'b']])
  assert.deepEqual(inspection.fields[1].valueContract.examples, ['a'])
  assert.deepEqual(inspectFormPage({ ...pdf, readOnly: true }, 1, 512).fields, [])
})

test('small translucent glyphs modify only their widget interiors without backgrounds or mutating input', () => {
  const pdf = document(), before = structuredClone(pdf), inspection = inspectFormPage(pdf, 1, 512)
  const { width, height } = inspection, marker = inspection.fields[0].controls[0]
  const raster = new Uint8Array(width * height * 4)
  for (let offset = 0; offset < raster.length; offset += 4) raster.set([120, 180, 240, 255], offset)
  const [left, top, right, bottom] = marker.labelRect
  // Place black printed ink below an actual glyph. Multiply must not erase it.
  const ink = (Math.ceil(top) * width + Math.ceil(left)) * 4
  raster.set([0, 0, 0, 255], ink)
  const original = raster.slice(), decorated = paintFormLabels(raster, width, height, inspection)
  let tinted = 0
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4, x = pixel % width, y = Math.floor(pixel / width)
    if (!decorated.subarray(offset, offset + 4).every((value, index) => value === original[offset + index])) {
      tinted++
      assert.ok(x >= Math.floor(left) && x < Math.ceil(right) && y >= Math.floor(top) && y < Math.ceil(bottom))
      assert.ok(decorated[offset] <= original[offset] && decorated[offset + 2] <= original[offset + 2])
    }
  }
  assert.ok(tinted > 50); assert.deepEqual(decorated.subarray(ink, ink + 4), new Uint8Array([0, 0, 0, 255]))
  assert.deepEqual(raster, original); assert.deepEqual(pdf, before)
  assert.throws(() => paintFormLabels(new Uint8Array(1), width, height, inspection), /raster/)
  assert.throws(() => paintFormLabels(raster, width, height, { ...inspection, width: 2049 }), /raster/)
  marker.labelRect[0] = -1
  assert.throws(() => paintFormLabels(raster, width, height, inspection), /label/)
})

test('page-edge controls retain their bounds and complete IDs inside the page', () => {
  const pdf = document()
  pdf.formFields![0].widgets = [{ page: 1, rect: [10, 400, 30, 420] }, { page: 1, rect: [190, 20, 210, 40] }]
  const inspection = inspectFormPage(pdf, 1, 512), [first, last] = inspection.fields[0].controls
  assert.equal(first.rectImage[0], 0); assert.equal(first.rectImage[1], 0)
  assert.equal(last.rectImage[2], inspection.width); assert.equal(last.rectImage[3], inspection.height)
  assert.ok(first.labelRect[0] > 0 && last.labelRect[2] < inspection.width)
  assert.ok(first.labelRect[1] > 0 && last.labelRect[3] < inspection.height)
  assert.equal(paintFormLabels(new Uint8Array(inspection.width * inspection.height * 4).fill(255),
    inspection.width, inspection.height, inspection).length, inspection.width * inspection.height * 4)
})

test('100 dense controls retain complete nonoverlapping in-field IDs, including landscape pages', () => {
  for (const rotation of [0, 90]) {
    const pdf = document(rotation)
    pdf.formFields![0].widgets = Array.from({ length: 100 }, (_, index) => ({ page: 1,
      rect: [15 + index % 10 * 19, 25 + Math.floor(index / 10) * 38,
        31 + index % 10 * 19, 55 + Math.floor(index / 10) * 38] }))
    const inspection = inspectFormPage(pdf, 1), controls = inspection.fields[0].controls
    assert.equal(controls.length, 100); assert.equal(controls[99].label, 'F100')
    assert.ok(inspection.width <= 2048 && inspection.height <= 2048)
    for (const marker of controls) {
      const a = marker.labelRect, r = marker.rectImage
      assert.ok(a[0] > r[0] && a[1] > r[1] && a[2] < r[2] && a[3] < r[3])
    }
    assert.throws(() => inspectFormPage(pdf, 1, 256), /too small for a readable in-field ID/)
  }
})

test('inspection fails closed on tiny, overlapping, invalid or oversized mappings instead of truncating', () => {
  assert.throws(() => inspectFormPage(document(), 2, 512), /outside/)
  for (const size of [0, 20, 2049]) assert.throws(() => inspectFormPage(document(), 1, size), /size/)
  const duplicate = document(); duplicate.formFields!.push(duplicate.formFields![0])
  assert.throws(() => inspectFormPage(duplicate, 1, 512), /Duplicate/)
  const overlap = document(); overlap.formFields![0].widgets.push(overlap.formFields![0].widgets[0])
  assert.throws(() => inspectFormPage(overlap, 1), /Overlapping/)
  const tiny = document(); tiny.formFields![0].widgets[0].rect = [50, 100, 51, 101]
  assert.throws(() => inspectFormPage(tiny, 1), /too small/)
  const crowded = document()
  crowded.formFields![0].widgets = Array.from({ length: 101 }, () => ({ page: 1, rect: [50, 100, 100, 130] }))
  assert.throws(() => inspectFormPage(crowded, 1, 512), /100 visible/)
})
