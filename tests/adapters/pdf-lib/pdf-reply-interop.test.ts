import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString,
} from 'pdf-lib'
import { applyPdfOperations, loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.js'

/**
 * A PDF authored outside DSH: one highlight, a popup, sibling comments, and
 * a reply to a reply. No private DSH IDs are present in its annotation graph.
 */
async function importedThread() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 600])
  page.drawText('A passage with comments from multiple readers', { x: 50, y: 450 })
  const root = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Highlight', Rect: [45, 440, 305, 460],
    QuadPoints: [45, 460, 305, 460, 45, 440, 305, 440], C: [1, 1, 0],
    NM: PDFString.of('external-mark'), T: PDFHexString.fromText('Document owner'),
  }))
  const popup = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Popup', Rect: [310, 420, 390, 530], Parent: root,
  }))
  pdf.context.lookup(root, PDFDict).set(PDFName.of('Popup'), popup)
  const alice = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [50, 440, 70, 460], IRT: root, RT: 'R',
    Contents: PDFHexString.fromText('Alice 的问题'), T: PDFHexString.fromText('Alice'),
    CreationDate: PDFString.of('D:20261017100500+08\'00\''),
    M: PDFString.of('D:20261017100500+08\'00\''),
    VendorNote: PDFString.of('retain Alice metadata'),
  }))
  const bob = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [50, 440, 70, 460], IRT: root,
    Contents: PDFHexString.fromText('Bob answers'), T: PDFHexString.fromText('Bob'),
    CreationDate: PDFString.of('D:20261017102000+08\'00\''),
    M: PDFString.of('D:20261017102000+08\'00\''),
    RC: PDFString.of('<body>Bob answers</body>'),
  }))
  const carol = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [50, 440, 70, 460], IRT: alice, RT: 'R',
    Contents: PDFHexString.fromText('Carol follows up'), T: PDFHexString.fromText('Carol'),
    CreationDate: PDFString.of('D:20261017103000+08\'00\''),
  }))
  const unrelated = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Stamp', Rect: [100, 120, 200, 170],
    Contents: PDFString.of('External stamp'),
  }))
  // Deliberately put the grandchild before its parent; /IRT, not array order,
  // defines the thread. A Popup is not a fourth comment.
  page.node.set(PDFName.of('Annots'), pdf.context.obj([root, popup, bob, carol, alice, unrelated]))
  return { bytes: await pdf.save({ useObjectStreams: false }), root, popup, alice, bob, carol, unrelated }
}

function required<T>(value: T | undefined, message: string): T {
  assert.ok(value, message)
  return value
}

test('imports a third-party multi-reply PDF thread with per-comment author and dates', async () => {
  const fixture = await importedThread()
  const info = await loadPdfDocument(fixture.bytes)
  const [root, popup, bob, carol, alice, stamp] = info.annotations
  assert.equal(info.annotations.length, 6)
  assert.equal(root.subtype, 'Highlight')
  assert.equal(root.contents, undefined, 'the mark is not itself a comment')
  assert.equal(root.author, 'Document owner')
  assert.equal(root.editable, true)
  assert.equal(popup.subtype, 'Popup')
  assert.equal(popup.replyToId, undefined)
  assert.equal(popup.editable, false)
  assert.equal(stamp.subtype, 'Stamp')
  assert.equal(stamp.replyToId, undefined)
  assert.equal(bob.replyToId, root.id)
  assert.equal(bob.replyType, 'R', 'PDF /RT omitted means a normal reply')
  assert.equal(bob.hasRichText, true)
  assert.equal(carol.replyToId, alice.id)
  assert.equal(alice.replyToId, root.id)
  assert.deepEqual([bob.author, carol.author, alice.author], ['Bob', 'Carol', 'Alice'])
  assert.deepEqual([bob.contents, carol.contents, alice.contents],
    ['Bob answers', 'Carol follows up', 'Alice 的问题'])
  assert.equal(alice.createdAt, 'D:20261017100500+08\'00\'')
  assert.equal(alice.modifiedAt, alice.createdAt)
  assert.equal(bob.createdAt, 'D:20261017102000+08\'00\'')
  assert.equal(carol.createdAt, 'D:20261017103000+08\'00\'')
  assert.ok([alice, bob, carol].every(comment => comment.editable))
})

test('editing then deleting one imported reply preserves its siblings, nested replies, and PDF links on reopen', async () => {
  const fixture = await importedThread()
  const before = await loadPdfDocument(fixture.bytes)
  const [root, , bob, carol, alice] = before.annotations
  const changed = await applyPdfOperations(fixture.bytes, [
    { type: 'update', id: bob.id, patch: { contents: 'Bob updated his answer ✓' } },
  ], ['2026-10-19T08:30:00.000Z'])
  const reopened = await loadPdfDocument(changed.bytes)
  const editedBob = required(reopened.annotations.find(item => item.id === bob.id), 'edited reply survives')
  assert.equal(editedBob.contents, 'Bob updated his answer ✓')
  assert.equal(editedBob.author, 'Bob')
  assert.equal(editedBob.createdAt, bob.createdAt, 'editing retains original creation date')
  assert.notEqual(editedBob.modifiedAt, bob.modifiedAt)
  assert.equal(editedBob.hasRichText, undefined, 'stale /RC is removed only from the edited comment')
  assert.deepEqual(reopened.annotations.filter(item => item.replyToId === root.id).map(item => item.author), ['Bob', 'Alice'])
  assert.equal(reopened.annotations.find(item => item.id === carol.id)?.replyToId, alice.id)

  const intermediate = await PDFDocument.load(changed.bytes)
  const editedDictionary = intermediate.context.lookup(fixture.bob, PDFDict)
  assert.equal(editedDictionary.has(PDFName.of('RC')), false)
  assert.equal(editedDictionary.get(PDFName.of('IRT'))?.toString(), fixture.root.toString())
  assert.equal(intermediate.context.lookup(fixture.alice, PDFDict).lookup(PDFName.of('VendorNote'), PDFString).decodeText(),
    'retain Alice metadata')

  const removed = await applyPdfOperations(changed.bytes, [{ type: 'delete', id: bob.id }])
  const final = await loadPdfDocument(removed.bytes)
  assert.equal(final.annotations.some(item => item.id === bob.id), false)
  assert.deepEqual(final.annotations.filter(item => item.replyToId === root.id).map(item => item.author), ['Alice'])
  assert.equal(final.annotations.find(item => item.id === carol.id)?.replyToId, alice.id)
  assert.equal(final.annotations.find(item => item.id === alice.id)?.createdAt, alice.createdAt)
  assert.equal(final.annotations.find(item => item.id === alice.id)?.modifiedAt, alice.modifiedAt)
  assert.equal(final.annotations.find(item => item.id === carol.id)?.createdAt, carol.createdAt)
  assert.equal(final.annotations.some(item => item.subtype === 'Popup'), true)
  assert.equal(final.annotations.some(item => item.subtype === 'Stamp'), true)

  const saved = await PDFDocument.load(removed.bytes)
  const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  const actualRefs = Array.from({ length: annots.size() }, (_, index) => annots.get(index))
    .filter((value): value is PDFRef => value instanceof PDFRef).map(value => value.toString())
  assert.equal(actualRefs.includes(fixture.bob.toString()), false)
  for (const retained of [fixture.root, fixture.popup, fixture.alice, fixture.carol, fixture.unrelated]) {
    assert.ok(actualRefs.includes(retained.toString()), `${retained} remains in page Annots`)
  }
  const retainedAlice = saved.context.lookup(fixture.alice, PDFDict)
  const retainedCarol = saved.context.lookup(fixture.carol, PDFDict)
  assert.equal(retainedAlice.get(PDFName.of('IRT'))?.toString(), fixture.root.toString())
  assert.equal(retainedCarol.get(PDFName.of('IRT'))?.toString(), fixture.alice.toString())
  assert.equal(retainedAlice.lookup(PDFName.of('RT'), PDFName).toString(), '/R')
  assert.equal(retainedAlice.lookup(PDFName.of('VendorNote'), PDFString).decodeText(), 'retain Alice metadata')
  assert.equal(saved.context.lookup(fixture.root, PDFDict).get(PDFName.of('Popup'))?.toString(), fixture.popup.toString())
  assert.equal(saved.context.lookup(fixture.popup, PDFDict).get(PDFName.of('Parent'))?.toString(), fixture.root.toString())
})

test('a newly added comment joins an imported PDF thread using standard reply fields', async () => {
  const fixture = await importedThread()
  const imported = await loadPdfDocument(fixture.bytes)
  const root = imported.annotations[0]
  const added = await applyPdfOperations(fixture.bytes, [{
    type: 'add', annotation: {
      id: 'dsh-follow-up', replyToId: root.id, page: 1, subtype: 'Text',
      rect: [50, 440, 51, 441], contents: '我的追问', author: '本地读者',
    },
  }], ['2026-10-19T09:00:00.000Z'])
  const reread = await loadPdfDocument(added.bytes)
  const comment = required(reread.annotations.find(item => item.id === 'dsh-follow-up'), 'new reply survives reload')
  assert.equal(comment.replyToId, root.id)
  assert.equal(comment.replyType, 'R')
  assert.equal(comment.contents, '我的追问')
  assert.equal(comment.author, '本地读者')
  assert.equal(comment.createdAt, 'D:20261019090000Z')
  assert.equal(comment.modifiedAt, comment.createdAt)
  assert.equal(comment.flags, 32, 'NoView hides the separate reply icon on the PDF page')
  assert.equal(reread.annotations.filter(item => item.replyToId === root.id).length, 3)

  const pdf = await PDFDocument.load(added.bytes)
  const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  const written = annots.lookup(annots.size() - 1, PDFDict)
  assert.equal(written.get(PDFName.of('IRT'))?.toString(), fixture.root.toString())
  assert.equal(written.lookup(PDFName.of('RT'), PDFName).toString(), '/R')
  assert.equal(written.lookup(PDFName.of('F'), PDFNumber).asNumber(), 32)
  assert.equal(written.lookup(PDFName.of('T'), PDFHexString).decodeText(), '本地读者')
  assert.equal(written.has(PDFName.of('AP')), false)
})
