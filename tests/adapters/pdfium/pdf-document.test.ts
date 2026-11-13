import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectFixturePdf, materializeFixturePdf } from '../../fixtures/native-document.ts'
import { acroformFixture } from '../../fixtures/acroform.ts'
import { onePagePdf, pdfArray, pdfDict, pdfHex, pdfString, pdfStream, ref } from '../../fixtures/pdf-fixture-kit.ts'
import { PdfDocumentError, type NewPdfAnnotation } from '../../../src/core/pdf-types.ts'

function fixture() {
  const extra = [
    pdfStream('q 1 0 0 rg 0 0 100 20 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 100 20]' }),
    pdfDict({ Type: '/Annot', Subtype: '/Highlight', Rect: '[40 440 140 460]', QuadPoints: '[40 460 140 460 40 440 140 440]', C: '[1 0 0]', Contents: pdfHex('已有中文批注'), T: pdfHex('作者'), RC: pdfString('<body>old rich text</body>'), AP: pdfDict({ N: ref(7) }), PrivateVendorValue: pdfString('keep me'), Popup: ref(9) }),
    pdfDict({ Type: '/Annot', Subtype: '/Popup', Rect: '[200 400 300 500]', Parent: ref(8) }),
    pdfDict({ Type: '/Annot', Subtype: '/Stamp', Rect: '[100 200 200 300]', Contents: pdfHex('保留印章'), AP: pdfDict({ N: ref(7) }), PrivateVendorValue: pdfDict({ Keep: pdfString('all vendor data') }) }),
    pdfDict({ Type: '/Annot', Subtype: '/Link', Rect: '[20 100 100 120]', Dest: `[${ref(5)} /XYZ 0 500 0]` }),
  ]
  return onePagePdf({ width: 400, height: 600, pageEntries: { Annots: pdfArray([8, 9, 10, 11].map(ref)) }, catalogEntries: { CustomData: pdfDict({ Sentinel: pdfString('preserve catalog') }) }, extraObjects: extra })
}

function newMarkup(id = 'new-id', subtype: NewPdfAnnotation['subtype'] = 'Highlight'): NewPdfAnnotation {
  return { id, page: 1, subtype, rect: [50, 300, 160, 340], quadPoints: subtype === 'Text' ? undefined : [50, 340, 160, 340, 50, 300, 160, 300], color: [0.3, 0.7, 1], contents: '中文、日本語、emoji', author: '阅读者' }
}

test('loads geometry, native comment metadata and unknown annotations without inventing fields', async () => {
  const info = await inspectFixturePdf(fixture())
  assert.equal(info.pageCount, 1)
  const highlight = info.annotations.find(item => item.subtype === 'Highlight')!
  assert.equal(highlight.contents, '已有中文批注'); assert.equal(highlight.hasRichText, true); assert.equal(highlight.author, '作者')
  assert.equal(info.annotations.find(item => item.subtype === 'Stamp')?.editable, false)
})

test('saves supported annotations with Unicode comments and preserves unrelated annotations', async () => {
  const result = await materializeFixturePdf(fixture(), (['Highlight', 'Underline', 'StrikeOut', 'Text'] as const).map(subtype => ({ type: 'add' as const, annotation: newMarkup(`created-${subtype}`, subtype) })))
  assert.equal(result.document.annotations.filter(item => item.editable).length, 5)
  assert.ok(result.document.annotations.some(item => item.subtype === 'Stamp'))
  assert.ok(result.document.annotations.some(item => item.subtype === 'Link'))
})

test('editing and recoloring annotations retain geometry and survive reload', async () => {
  const before = await inspectFixturePdf(fixture()), mark = before.annotations.find(item => item.subtype === 'Highlight')!
  const changed = await materializeFixturePdf(fixture(), [{ type: 'update', id: mark.id, patch: { contents: '更新内容', color: [0, 1, 0], commentPosition: [240, 310] } }])
  const after = (await inspectFixturePdf(changed.bytes)).annotations.find(item => item.id === mark.id)!
  assert.equal(after.contents, '更新内容'); assert.deepEqual(after.color, [0, 1, 0]); assert.deepEqual(after.commentPosition, [240, 310]); assert.deepEqual(after.quadPoints, mark.quadPoints)
})

test('replies are individually editable and deletable without deleting their parent', async () => {
  const source = fixture(), root = (await inspectFixturePdf(source)).annotations[0]!
  const added = await materializeFixturePdf(source, [{ type: 'add', annotation: { id: 'reply-one', replyToId: root.id, page: 1, subtype: 'Text', rect: [40, 440, 41, 441], contents: 'A question', author: 'Reader' } }])
  const reply = (await inspectFixturePdf(added.bytes)).annotations.find(item => item.id === 'reply-one')!
  assert.equal(reply.replyToId, root.id); assert.equal(reply.flags, 32)
  const removed = await materializeFixturePdf(added.bytes, [{ type: 'delete', id: reply.id }])
  assert.ok((await inspectFixturePdf(removed.bytes)).annotations.some(item => item.id === root.id))
})

test('direct parent annotations gain a stable reference before a reply is attached', async () => {
  const source = onePagePdf({ pageEntries: { Annots: '[7 0 R]' }, extraObjects: [pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[20 30 40 50]', Contents: pdfHex('Root') })] })
  const parent = (await inspectFixturePdf(source)).annotations[0]!
  const result = await materializeFixturePdf(source, [{ type: 'add', annotation: { id: 'direct-reply', replyToId: parent.id, page: 1, subtype: 'Text', rect: [20, 30, 21, 31], contents: 'Reply' } }])
  assert.equal((await inspectFixturePdf(result.bytes)).annotations[1]?.replyToId, parent.id)
})

test('AcroForm metadata exposes editable fields and writes through the same document port', async () => {
  const bytes = await acroformFixture(), info = await inspectFixturePdf(bytes)
  assert.equal(info.formKind, 'acroform'); assert.equal(info.readOnly, false)
  const text = info.formFields!.find(field => field.name === 'Text1')!
  const changed = await materializeFixturePdf(bytes, [{ type: 'set-field', fieldId: text.id!, value: '申请人' }])
  assert.equal((await inspectFixturePdf(changed.bytes)).formFields?.find(field => field.name === 'Text1')?.value, '申请人')
})

test('invalid batches are atomic and geometry validation refuses malformed annotations', async () => {
  const source = fixture(), original = source.slice()
  await assert.rejects(materializeFixturePdf(source, [{ type: 'add', annotation: newMarkup() }, { type: 'delete', id: 'missing' }]), (error: unknown) => error instanceof PdfDocumentError)
  assert.deepEqual(source, original)
  await assert.rejects(materializeFixturePdf(source, [{ type: 'add', annotation: { ...newMarkup(), rect: [0, 0, 0, 10] } }]), (error: unknown) => error instanceof PdfDocumentError)
})
