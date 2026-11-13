import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectFixturePdf, materializeFixturePdf } from '../../fixtures/native-document.ts'
import { onePagePdf, pdfArray, pdfDict, pdfHex, pdfString, ref } from '../../fixtures/pdf-fixture-kit.ts'

function importedThread() {
  const extra = [
    pdfDict({ Type: '/Annot', Subtype: '/Highlight', Rect: '[45 440 305 460]', QuadPoints: '[45 460 305 460 45 440 305 440]', C: '[1 1 0]', NM: pdfString('external-mark'), T: pdfHex('Document owner'), Popup: ref(8) }),
    pdfDict({ Type: '/Annot', Subtype: '/Popup', Rect: '[310 420 390 530]', Parent: ref(7) }),
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[50 440 70 460]', IRT: ref(7), RT: '/R', Contents: pdfHex('Alice 的问题'), T: pdfHex('Alice'), CreationDate: pdfString("D:20261017100500+08'00'"), M: pdfString("D:20261017100500+08'00'"), VendorNote: pdfString('retain Alice metadata') }),
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[50 440 70 460]', IRT: ref(7), Contents: pdfHex('Bob answers'), T: pdfHex('Bob'), CreationDate: pdfString('D:20261017102000Z'), RC: pdfString('<body>Bob answers</body>') }),
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[50 440 70 460]', IRT: ref(9), RT: '/R', Contents: pdfHex('Carol follows up'), T: pdfHex('Carol'), CreationDate: pdfString('D:20261017103000Z') }),
    pdfDict({ Type: '/Annot', Subtype: '/Stamp', Rect: '[100 120 200 170]', Contents: pdfString('External stamp') }),
  ]
  return onePagePdf({ pageEntries: { Annots: pdfArray([7, 8, 10, 11, 9, 12].map(ref)) }, extraObjects: extra })
}

test('imports a third-party multi-reply PDF thread with per-comment author and dates', async () => {
  const info = await inspectFixturePdf(importedThread())
  const [root, popup, bob, carol, alice, stamp] = info.annotations
  assert.equal(info.annotations.length, 6)
  assert.equal(root.subtype, 'Highlight'); assert.equal(root.contents, undefined); assert.equal(root.author, 'Document owner')
  assert.equal(popup.subtype, 'Popup'); assert.equal(popup.editable, false); assert.equal(stamp.subtype, 'Stamp')
  assert.equal(bob.replyToId, root.id); assert.equal(carol.replyToId, alice.id); assert.equal(alice.replyToId, root.id)
  assert.deepEqual([bob.author, carol.author, alice.author], ['Bob', 'Carol', 'Alice'])
  assert.deepEqual([bob.contents, carol.contents, alice.contents], ['Bob answers', 'Carol follows up', 'Alice 的问题'])
})

test('editing and deleting one imported reply preserves its siblings and nested replies', async () => {
  const bytes = importedThread(), before = await inspectFixturePdf(bytes)
  const root = before.annotations[0]!, bob = before.annotations.find(item => item.author === 'Bob')!
  const changed = await materializeFixturePdf(bytes, [{ type: 'update', id: bob.id, patch: { contents: 'Bob updated his answer' } }])
  const edited = await inspectFixturePdf(changed.bytes)
  assert.equal(edited.annotations.find(item => item.id === bob.id)?.contents, 'Bob updated his answer')
  assert.equal(edited.annotations.filter(item => item.replyToId === root.id).length, 2)
  const removed = await materializeFixturePdf(changed.bytes, [{ type: 'delete', id: bob.id }])
  const final = await inspectFixturePdf(removed.bytes)
  assert.equal(final.annotations.some(item => item.id === bob.id), false)
  assert.equal(final.annotations.some(item => item.subtype === 'Popup'), true)
  assert.equal(final.annotations.some(item => item.subtype === 'Stamp'), true)
})
