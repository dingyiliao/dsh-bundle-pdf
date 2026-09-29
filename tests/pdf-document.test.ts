import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, degrees } from 'pdf-lib'
import { applyPdfOperations, loadPdfDocument, PdfDocumentError, type NewPdfAnnotation } from '../src/core/pdf-document.js'

async function fixture() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 600])
  page.setCropBox(20, 30, 320, 500)
  page.setRotation(degrees(90))
  page.drawText('Original text remains selectable', { x: 40, y: 450 })
  doc.addPage([300, 500])
  const originalAppearance = doc.context.register(doc.context.flateStream('q 1 0 0 rg 0 0 100 20 re f Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20],
  }))
  const highlight = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Highlight', Rect: [40, 440, 140, 460],
    QuadPoints: [40, 460, 140, 460, 40, 440, 140, 440], C: [1, 0, 0],
    Contents: PDFHexString.fromText('已有中文批注'), T: PDFHexString.fromText('作者'),
    RC: PDFString.of('<body>old rich text</body>'),
    AP: { N: originalAppearance }, PrivateVendorValue: PDFString.of('keep me'),
  }))
  const popup = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Popup', Rect: [200, 400, 300, 500], Parent: highlight,
  }))
  doc.context.lookup(highlight, PDFDict).set(PDFName.of('Popup'), popup)
  const unknown = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Stamp', Rect: [100, 200, 200, 300],
    Contents: PDFHexString.fromText('保留印章'), AP: { N: originalAppearance },
    PrivateVendorValue: doc.context.obj({ Keep: PDFString.of('all vendor data') }),
  }))
  const link = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [20, 100, 100, 120],
    Dest: [doc.getPage(1).ref, 'XYZ', 0, 500, 0],
  }))
  page.node.set(PDFName.of('Annots'), doc.context.obj([highlight, popup, unknown, link]))
  doc.catalog.set(PDFName.of('CustomData'), doc.context.obj({ Sentinel: PDFString.of('preserve catalog') }))
  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes, highlight, popup, unknown, link, originalAppearance }
}

function newMarkup(id = 'new-id', subtype: NewPdfAnnotation['subtype'] = 'Highlight'): NewPdfAnnotation {
  return {
    id, page: 1, subtype, rect: [50, 300, 160, 340],
    quadPoints: subtype === 'Text' ? undefined : [50, 340, 160, 340, 50, 300, 160, 300],
    color: [0.3, 0.7, 1], contents: '中文\n日本語 😀 𝄞', author: '阅读者',
  }
}

test('loads geometry, native comment metadata and unknown annotations without inventing fields', async () => {
  const { bytes } = await fixture()
  const info = await loadPdfDocument(bytes)
  assert.equal(info.pageCount, 2)
  assert.deepEqual(info.pages[0], { page: 1, mediaBox: [0, 0, 400, 600], cropBox: [20, 30, 340, 530], rotation: 90, userUnit: 1 })
  const highlight = info.annotations.find((annotation) => annotation.subtype === 'Highlight')!
  assert.equal(highlight.contents, '已有中文批注')
  assert.equal(highlight.author, '作者')
  assert.equal(highlight.createdAt, undefined)
  assert.equal(highlight.editable, true)
  const unknown = info.annotations.find((annotation) => annotation.subtype === 'Stamp')!
  assert.equal(unknown.editable, false)
  assert.equal(unknown.readOnlyReason, 'unsupported-annotation-type')
})

test('saves all supported annotations with Unicode comments and explicit native appearances', async () => {
  const { bytes, unknown, link } = await fixture()
  const source = await PDFDocument.load(bytes)
  const operations = (['Highlight', 'Underline', 'StrikeOut', 'Text'] as const).map((subtype) => ({
    type: 'add' as const, annotation: newMarkup(`created-${subtype}`, subtype),
  }))
  const result = await applyPdfOperations(bytes, operations)
  const output = await PDFDocument.load(result.bytes)
  assert.equal(result.document.annotations.length, 8)
  for (const operation of operations) {
    const added = result.document.annotations.find((annotation) => annotation.id === operation.annotation.id)!
    assert.equal(added.contents, operation.annotation.contents)
    assert.equal(added.author, '阅读者')
    assert.equal(added.editable, true)
    assert.deepEqual(added.rect, operation.annotation.rect)
  }
  const array = output.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  for (let index = 4; index < array.size(); index++) {
    assert.ok(array.lookup(index, PDFDict).lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) instanceof PDFRef)
  }
  assert.equal(output.context.lookup(unknown).toString(), source.context.lookup(unknown).toString())
  assert.equal(output.context.lookup(link).toString(), source.context.lookup(link).toString())
  assert.equal(output.catalog.lookup(PDFName.of('CustomData'), PDFDict).toString(), source.catalog.lookup(PDFName.of('CustomData'), PDFDict).toString())
  assert.equal(output.getPage(0).node.get(PDFName.of('Contents'))!.toString(), source.getPage(0).node.get(PDFName.of('Contents'))!.toString())
  assert.equal(output.getPageCount(), 2)
})

test('editing comment preserves appearance, vendor metadata and reference identity', async () => {
  const { bytes, highlight, originalAppearance } = await fixture()
  const first = await loadPdfDocument(bytes)
  const id = first.annotations.find((annotation) => annotation.subtype === 'Highlight')!.id
  const changed = await applyPdfOperations(bytes, [{ type: 'update', id, patch: { contents: '更新\n内容 📝' } }])
  assert.equal(changed.document.annotations.find((annotation) => annotation.id === id)!.contents, '更新\n内容 📝')
  const output = await PDFDocument.load(changed.bytes)
  const dict = output.context.lookup(highlight, PDFDict)
  assert.equal(dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))!.toString(), originalAppearance.toString())
  assert.equal(dict.lookup(PDFName.of('PrivateVendorValue'), PDFString).decodeText(), 'keep me')
  assert.equal(dict.has(PDFName.of('RC')), false)
})

test('recoloring regenerates the appearance and retains original quadrilaterals', async () => {
  const { bytes, highlight, originalAppearance } = await fixture()
  const before = (await loadPdfDocument(bytes)).annotations[0]
  const changed = await applyPdfOperations(bytes, [{ type: 'update', id: before.id, patch: { color: [0, 1, 0] } }])
  const after = changed.document.annotations.find((annotation) => annotation.id === before.id)!
  assert.deepEqual(after.color, [0, 1, 0])
  assert.deepEqual(after.quadPoints, before.quadPoints)
  const output = await PDFDocument.load(changed.bytes)
  assert.notEqual(output.context.lookup(highlight, PDFDict).lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))!.toString(), originalAppearance.toString())
})

test('deleting an annotation detaches its own popup and retains unrelated links and stamps', async () => {
  const { bytes } = await fixture()
  const id = (await loadPdfDocument(bytes)).annotations.find((annotation) => annotation.subtype === 'Highlight')!.id
  const result = await applyPdfOperations(bytes, [{ type: 'delete', id }])
  assert.deepEqual(result.document.annotations.map((annotation) => annotation.subtype), ['Stamp', 'Link'])
})

test('locked annotations and reply chains remain read only', async () => {
  const { bytes, highlight } = await fixture()
  for (const flags of [64, 128, 512]) {
    const doc = await PDFDocument.load(bytes)
    doc.context.lookup(highlight, PDFDict).set(PDFName.of('F'), doc.context.obj(flags))
    const locked = await doc.save()
    const item = (await loadPdfDocument(locked)).annotations[0]
    assert.equal(item.readOnlyReason, 'annotation-locked')
    await assert.rejects(applyPdfOperations(locked, [{ type: 'delete', id: item.id }]), (error: unknown) => error instanceof PdfDocumentError && error.code === 'annotation-read-only')
  }
  const doc = await PDFDocument.load(bytes)
  const reply = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: highlight }))
  doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).push(reply)
  const info = await loadPdfDocument(await doc.save())
  assert.equal(info.annotations[0].readOnlyReason, 'reply-chain')
  assert.equal(info.annotations.at(-1)!.readOnlyReason, 'reply-chain')
})

test('signed documents are detected even with direct signature dictionaries and cannot be saved', async () => {
  const { bytes } = await fixture()
  const doc = await PDFDocument.load(bytes)
  doc.catalog.set(PDFName.of('Perms'), doc.context.obj({ DocMDP: { Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: PDFHexString.of('abc123') } }))
  const signed = await doc.save({ useObjectStreams: false })
  const info = await loadPdfDocument(signed)
  assert.equal(info.signed, true)
  assert.equal(info.readOnlyReason, 'signed-document')
  await assert.rejects(applyPdfOperations(signed, [{ type: 'add', annotation: newMarkup() }]), (error: unknown) => error instanceof PdfDocumentError && error.code === 'read-only')
})

test('encrypted input is rejected without bypassing encryption', async () => {
  const doc = await PDFDocument.create()
  doc.addPage()
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }))
  await assert.rejects(loadPdfDocument(await doc.save()), (error: unknown) => error instanceof PdfDocumentError && error.code === 'encrypted')
})

test('an invalid batch is atomic and preserves the caller bytes', async () => {
  const { bytes } = await fixture()
  const original = bytes.slice()
  await assert.rejects(applyPdfOperations(bytes, [
    { type: 'add', annotation: newMarkup() },
    { type: 'delete', id: 'missing' },
  ]), (error: unknown) => error instanceof PdfDocumentError && error.code === 'unknown-annotation')
  assert.deepEqual(bytes, original)
  assert.equal((await loadPdfDocument(bytes)).annotations.length, 4)
  await assert.rejects(applyPdfOperations(bytes, [
    { type: 'add', annotation: newMarkup() },
    { type: 'add', annotation: newMarkup() },
  ]), (error: unknown) => error instanceof PdfDocumentError && error.code === 'invalid-operation')
})

test('geometry validation refuses invalid page, color and nonfinite or degenerate quads', async () => {
  const { bytes } = await fixture()
  const invalid: NewPdfAnnotation[] = [
    { ...newMarkup(), page: 0 },
    { ...newMarkup(), color: [1, 0, 2] },
    { ...newMarkup(), rect: [0, 0, 0, 10] },
    { ...newMarkup(), quadPoints: [50, 340, 160, 340, 50, NaN, 160, 300] },
    { ...newMarkup(), quadPoints: [50, 340, 50, 340, 50, 340, 50, 340] },
  ]
  for (const annotation of invalid) {
    await assert.rejects(applyPdfOperations(bytes, [{ type: 'add', annotation }]), (error: unknown) => error instanceof PdfDocumentError && error.code === 'invalid-operation')
  }
})
