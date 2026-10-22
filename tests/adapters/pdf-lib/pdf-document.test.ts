import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, degrees } from 'pdf-lib'
import { applyPdfOperations, loadPdfDocument, PdfDocumentError, type NewPdfAnnotation } from '../../../src/adapters/host/pdf-lib/pdf-document.js'

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
  assert.equal(highlight.hasRichText, true)
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
  const createdHighlight = array.lookup(4, PDFDict)
  assert.equal(createdHighlight.lookup(PDFName.of('CA'), PDFNumber).asNumber(), 0.4)
  const appearance = output.context.lookup(createdHighlight.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')))
  assert.ok(appearance instanceof PDFRawStream)
  const mark = appearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of('Mark'))
  assert.ok(mark instanceof PDFRef)
  const form = output.context.lookup(mark)
  assert.ok(form instanceof PDFRawStream)
  const group = form.dict.lookup(PDFName.of('Group'), PDFDict)
  assert.equal(group.lookup(PDFName.of('S'), PDFName).toString(), '/Transparency')
  const outputUnknown = output.context.lookup(unknown)
  const sourceUnknown = source.context.lookup(unknown)
  const outputLink = output.context.lookup(link)
  const sourceLink = source.context.lookup(link)
  assert.ok(outputUnknown && sourceUnknown && outputLink && sourceLink)
  assert.equal(outputUnknown.toString(), sourceUnknown.toString())
  assert.equal(outputLink.toString(), sourceLink.toString())
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
  assert.equal(changed.document.annotations.find((annotation) => annotation.id === id)!.hasRichText, undefined)
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

test('moving a standalone note updates its PDF Rect and survives reload', async () => {
  const { bytes } = await fixture()
  const added = await applyPdfOperations(bytes, [{ type: 'add', annotation: newMarkup('movable-note', 'Text') }])
  const before = added.document.annotations.find(annotation => annotation.id === 'movable-note')!
  const movedRect = [180, 220, 200, 240] as const
  const changed = await applyPdfOperations(added.bytes, [{ type: 'update', id: before.id, patch: { rect: [...movedRect] } }])
  assert.deepEqual(changed.document.annotations.find(annotation => annotation.id === before.id)?.rect, movedRect)
  assert.deepEqual((await loadPdfDocument(changed.bytes)).annotations.find(annotation => annotation.id === before.id)?.rect, movedRect)
  await assert.rejects(applyPdfOperations(bytes, [{ type: 'update', id: 'nonexistent', patch: { rect: [...movedRect] } }]),
    (error: unknown) => error instanceof PdfDocumentError && error.code === 'unknown-annotation')
})

test('recoloring a standalone note updates its PDF color and survives reload', async () => {
  const { bytes } = await fixture()
  const added = await applyPdfOperations(bytes, [{ type: 'add', annotation: newMarkup('colored-note', 'Text') }])
  const changed = await applyPdfOperations(added.bytes, [{ type: 'update', id: 'colored-note',
    patch: { color: [0.2, 0.4, 0.8] } }])
  assert.deepEqual(changed.document.annotations.find(annotation => annotation.id === 'colored-note')?.color, [0.2, 0.4, 0.8])
  assert.deepEqual((await loadPdfDocument(changed.bytes)).annotations
    .find(annotation => annotation.id === 'colored-note')?.color, [0.2, 0.4, 0.8])
})

test('comment-card placement survives saving and reloading the PDF', async () => {
  const { bytes } = await fixture()
  const before = await loadPdfDocument(bytes)
  const mark = before.annotations.find(annotation => annotation.subtype === 'Highlight')!
  const position: [number, number] = [240, 310]
  const changed = await applyPdfOperations(bytes, [
    { type: 'update', id: mark.id, patch: { commentPosition: position } },
  ])
  assert.deepEqual(changed.document.annotations.find(annotation => annotation.id === mark.id)?.commentPosition, position)
  assert.deepEqual((await loadPdfDocument(changed.bytes)).annotations.find(annotation => annotation.id === mark.id)?.commentPosition, position)
})

test('deleting an annotation detaches its own popup and retains unrelated links and stamps', async () => {
  const { bytes } = await fixture()
  const id = (await loadPdfDocument(bytes)).annotations.find((annotation) => annotation.subtype === 'Highlight')!.id
  const result = await applyPdfOperations(bytes, [{ type: 'delete', id }])
  assert.deepEqual(result.document.annotations.map((annotation) => annotation.subtype), ['Stamp', 'Link'])
})

test('locked annotations remain read only; standard external reply chains are individually editable', async () => {
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
  const reply = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: highlight, RT: 'R',
    Contents: PDFHexString.fromText('First reply'), T: PDFHexString.fromText('Alice'),
    CreationDate: PDFString.of('D:20261019120000Z'),
  }))
  const second = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: highlight,
    Contents: PDFHexString.fromText('Second reply'), T: PDFHexString.fromText('Bob'),
  }))
  doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).push(reply)
  doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).push(second)
  const source = await doc.save()
  const info = await loadPdfDocument(source)
  const root = info.annotations[0]
  assert.equal(root.editable, true)
  assert.equal(info.annotations[1].subtype, 'Popup')
  const replies = info.annotations.filter(annotation => annotation.replyToId === root.id)
  assert.deepEqual(replies.map(annotation => annotation.contents), ['First reply', 'Second reply'])
  assert.deepEqual(replies.map(annotation => annotation.author), ['Alice', 'Bob'])
  assert.deepEqual(replies.map(annotation => annotation.replyType), ['R', 'R'])
  assert.equal(replies[0].createdAt, 'D:20261019120000Z')
  assert.ok(replies.every(annotation => annotation.editable))
  assert.ok(!info.annotations[1].replyToId, 'Popup is not a comment reply')
  const edited = await applyPdfOperations(source, [{ type: 'update', id: replies[1].id, patch: { contents: 'Updated external reply' } }])
  const reread = await loadPdfDocument(edited.bytes)
  assert.deepEqual(reread.annotations.filter(annotation => annotation.replyToId === root.id).map(annotation => annotation.contents),
    ['First reply', 'Updated external reply'])
})

test('a reply is written as an invisible PDF /IRT /RT Text annotation and survives save/reload', async () => {
  const { bytes, highlight } = await fixture()
  const rootId = (await loadPdfDocument(bytes)).annotations[0].id
  const first = await applyPdfOperations(bytes, [
    { type: 'add', annotation: { id: 'reply-one', replyToId: rootId, page: 1, subtype: 'Text', rect: [40, 440, 41, 441], contents: 'A question', author: 'Reader' } },
    { type: 'add', annotation: { id: 'reply-two', replyToId: rootId, page: 1, subtype: 'Text', rect: [40, 440, 41, 441], contents: 'Another question', author: 'Colleague' } },
  ], ['2026-10-19T12:00:00.000Z', '2026-10-19T12:01:00.000Z'])
  const info = await loadPdfDocument(first.bytes)
  const replies = info.annotations.filter(annotation => annotation.replyToId === rootId)
  assert.deepEqual(replies.map(annotation => annotation.id), ['reply-one', 'reply-two'])
  assert.deepEqual(replies.map(annotation => annotation.contents), ['A question', 'Another question'])
  assert.deepEqual(replies.map(annotation => annotation.author), ['Reader', 'Colleague'])
  assert.ok(replies.every(annotation => annotation.flags === 32 && annotation.replyType === 'R'))
  const output = await PDFDocument.load(first.bytes)
  const array = output.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  for (const index of [4, 5]) {
    const dictionary = array.lookup(index, PDFDict)
    assert.equal(dictionary.get(PDFName.of('IRT'))?.toString(), highlight.toString())
    assert.equal(dictionary.lookup(PDFName.of('RT'), PDFName).toString(), '/R')
    assert.equal(dictionary.lookup(PDFName.of('F'), PDFNumber).asNumber(), 32)
    assert.equal(dictionary.has(PDFName.of('AP')), false)
  }
  await assert.rejects(applyPdfOperations(first.bytes, [{ type: 'delete', id: rootId }]),
    (error: unknown) => error instanceof PdfDocumentError && error.code === 'annotation-read-only')
  const edited = await applyPdfOperations(first.bytes, [
    { type: 'update', id: 'reply-one', patch: { contents: 'Edited first reply' } },
    { type: 'delete', id: 'reply-two' },
  ])
  const editedInfo = await loadPdfDocument(edited.bytes)
  assert.deepEqual(editedInfo.annotations.filter(annotation => annotation.replyToId === rootId).map(annotation => annotation.contents), ['Edited first reply'])
  const cleared = await applyPdfOperations(edited.bytes, [
    { type: 'delete', id: 'reply-one' },
    { type: 'delete', id: rootId },
  ])
  assert.equal((await loadPdfDocument(cleared.bytes)).annotations.some(annotation => annotation.id === rootId), false)
})

test('direct parent annotations gain a stable reference before a reply is attached', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 200])
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], Contents: PDFHexString.fromText('Root'),
  })]))
  const input = await doc.save()
  const parentId = (await loadPdfDocument(input)).annotations[0].id
  const result = await applyPdfOperations(input, [{ type: 'add', annotation: {
    id: 'direct-reply', replyToId: parentId, page: 1, subtype: 'Text', rect: [20, 30, 21, 31], contents: 'Reply',
  } }])
  const reread = await loadPdfDocument(result.bytes)
  assert.equal(reread.annotations[0].id, parentId)
  assert.equal(reread.annotations[1].replyToId, parentId)
  const output = await PDFDocument.load(result.bytes)
  const array = output.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  const parentRef = array.get(0)
  assert.ok(parentRef instanceof PDFRef)
  assert.equal(array.lookup(1, PDFDict).get(PDFName.of('IRT'))?.toString(), parentRef.toString())
})

test('a reply to a duplicate same-page alias targets the canonical surviving parent ID', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 200])
  const shared = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50] }))
  page.node.set(PDFName.of('Annots'), doc.context.obj([shared, shared]))
  const input = await doc.save()
  const before = await loadPdfDocument(input)
  assert.equal(before.annotations.length, 2)
  assert.notEqual(before.annotations[0].id, before.annotations[1].id)
  const result = await applyPdfOperations(input, [{ type: 'add', annotation: {
    id: 'alias-reply', replyToId: before.annotations[1].id, page: 1, subtype: 'Text',
    rect: [20, 30, 21, 31], contents: 'Reply to second alias',
  } }])
  assert.equal(result.document.annotations.at(-1)?.replyToId, before.annotations[0].id)
  const after = await loadPdfDocument(result.bytes)
  assert.equal(after.annotations.at(-1)?.replyToId, after.annotations[0].id)
  assert.equal(after.annotations.at(-1)?.replyToId, result.document.annotations.at(-1)?.replyToId)
})

test('a cross-page /IRT orphan risk marks the referenced parent read-only before operations', async () => {
  const { bytes, highlight } = await fixture()
  const doc = await PDFDocument.load(bytes)
  const wrongPage = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: highlight,
    Contents: PDFString.of('Wrong page'),
  }))
  doc.getPage(1).node.set(PDFName.of('Annots'), doc.context.obj([wrongPage]))
  const source = await doc.save()
  const info = await loadPdfDocument(source)
  const parent = info.annotations[0]
  assert.equal(parent.readOnlyReason, 'reply-chain')
  assert.equal(info.annotations.at(-1)?.replyToId, undefined)
  await assert.rejects(applyPdfOperations(source, [{ type: 'delete', id: parent.id }]),
    (error: unknown) => error instanceof PdfDocumentError && error.code === 'annotation-read-only')
})

test('PDF reply groups and malformed cross-page replies are preserved without editable threading', async () => {
  const { bytes, highlight } = await fixture()
  const doc = await PDFDocument.load(bytes)
  const group = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: highlight, RT: 'Group',
    Contents: PDFHexString.fromText('Grouped annotation, not a comment'),
  }))
  const crossPage = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: highlight,
    Contents: PDFHexString.fromText('Wrong page'),
  }))
  doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).push(group)
  doc.getPage(1).node.set(PDFName.of('Annots'), doc.context.obj([crossPage]))
  const written = await doc.save()
  const annotations = (await loadPdfDocument(written)).annotations
  assert.equal(annotations[0].readOnlyReason, 'reply-chain')
  const groupModel = annotations.find(annotation => annotation.contents === 'Grouped annotation, not a comment')!
  assert.equal(groupModel.replyType, 'Group')
  assert.equal(groupModel.replyToId, annotations[0].id)
  assert.equal(groupModel.editable, false)
  const malformed = annotations.find(annotation => annotation.contents === 'Wrong page')!
  assert.equal(malformed.replyToId, undefined)
  assert.equal(malformed.readOnlyReason, 'reply-chain')
  await assert.rejects(applyPdfOperations(written, [{ type: 'delete', id: groupModel.id }]),
    (error: unknown) => error instanceof PdfDocumentError && error.code === 'annotation-read-only')
})

test('cyclic external /IRT data cannot create a cyclic comment thread', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 200])
  const first = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], Contents: PDFString.of('First'),
  }))
  const second = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [20, 30, 40, 50], IRT: first, Contents: PDFString.of('Second'),
  }))
  doc.context.lookup(first, PDFDict).set(PDFName.of('IRT'), second)
  page.node.set(PDFName.of('Annots'), doc.context.obj([first, second]))
  const info = await loadPdfDocument(await doc.save())
  assert.ok(info.annotations.every(annotation => annotation.replyToId === undefined && annotation.readOnlyReason === 'reply-chain'))
})

test('reply validation rejects missing, cross-page, non-Text and empty replies', async () => {
  const { bytes } = await fixture()
  const root = (await loadPdfDocument(bytes)).annotations[0]
  const base: NewPdfAnnotation = {
    id: 'reply', page: root.page, subtype: 'Text', rect: [40, 440, 41, 441],
    replyToId: root.id, contents: 'Comment',
  }
  const invalid = [
    { ...base, replyToId: 'absent' },
    { ...base, page: 2 },
    { ...base, subtype: 'Highlight' as const, quadPoints: [40, 441, 41, 441, 40, 440, 41, 440] },
    { ...base, contents: '  ' },
  ]
  for (const annotation of invalid) {
    await assert.rejects(applyPdfOperations(bytes, [{ type: 'add', annotation }]),
      (error: unknown) => error instanceof PdfDocumentError && ['invalid-operation', 'unknown-annotation'].includes(error.code))
  }
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

test('AcroForm metadata exposes editable fields while leaving widget annotations independently read-only', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  doc.getForm().createTextField('applicant').addToPage(page, { x: 30, y: 80, width: 180, height: 28 })
  const bytes = await doc.save()
  const info = await loadPdfDocument(bytes)
  assert.equal(info.formKind, 'acroform')
  assert.equal(info.readOnly, false)
  assert.equal(info.formFields?.[0]?.name, 'applicant')
  assert.equal(info.formFields?.[0]?.readOnly, false)
  assert.equal(info.annotations.find(item => item.subtype === 'Widget')?.readOnlyReason, 'unsupported-annotation-type')
  assert.deepEqual((await applyPdfOperations(bytes, [])).bytes, bytes)
  const changed = await applyPdfOperations(bytes, [{ type: 'set-field', name: 'applicant', value: '申请人' }])
  assert.equal(changed.document.formFields?.[0]?.value, '申请人')
  assert.equal((await loadPdfDocument(changed.bytes)).formFields?.[0]?.value, '申请人')
})

test('XFA form metadata cannot enter the annotation writer', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([300, 400])
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: PDFString.of('<xfa/>') }))
  const bytes = await doc.save()
  assert.equal((await loadPdfDocument(bytes)).formKind, 'xfa')
  await assert.rejects(applyPdfOperations(bytes, []), { code: 'read-only' })
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
  const existing = (await loadPdfDocument(bytes)).annotations[0]!
  await assert.rejects(applyPdfOperations(bytes, [{ type: 'update', id: existing.id,
    patch: { forbidden: true } } as never]),
  (error: unknown) => error instanceof PdfDocumentError && error.code === 'invalid-operation')
  assert.deepEqual(bytes, original)
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
