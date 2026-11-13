import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectFixturePdf, materializeFixturePdf } from '../../fixtures/native-document.ts'
import { recoverableOutlineFixture } from '../../fixtures/recoverable-outline.ts'
import { plainPdf } from '../../fixtures/plain-pdf.ts'

test('repairs imported nested outlines and preserves destinations during edits', async () => {
  const source = await recoverableOutlineFixture(), before = await inspectFixturePdf(source)
  assert.deepEqual(before.outline?.map(item => item.title), ['Imported chapter', 'Reference'])
  assert.equal(before.outline?.[0]?.children[0]?.title, 'Imported section')
  const changed = await materializeFixturePdf(source, [
    { type: 'outline-update', id: before.outline![0]!.id, patch: { title: '新章节' } },
    { type: 'outline-add', id: 'nested', title: '新小节', page: 2, parentId: before.outline![0]!.children[0]!.id },
  ])
  const after = await inspectFixturePdf(changed.bytes)
  assert.equal(after.outline?.[0]?.title, '新章节')
  assert.equal(after.outline?.[0]?.children[0]?.children[0]?.title, '新小节')
  assert.equal(after.outline?.[0]?.children[0]?.page, 2)
})

test('outline deletion and addition keep the document editable after reopen', async () => {
  const source = await recoverableOutlineFixture(), before = await inspectFixturePdf(source)
  const removed = await materializeFixturePdf(source, [{ type: 'outline-delete', id: before.outline![1]!.id }])
  const added = await materializeFixturePdf(removed.bytes, [{ type: 'outline-add', id: 'again', title: '再次添加', page: 1 }])
  const reopened = await inspectFixturePdf(added.bytes)
  assert.deepEqual(reopened.outline?.map(item => item.title), ['Imported chapter', '再次添加'])
  assert.equal(reopened.outlineReadOnlyReason, undefined)
})

test('empty documents can receive a bookmark through the same native writer', async () => {
  const source = plainPdf([{ size: [300, 400] }])
  const added = await materializeFixturePdf(source, [{ type: 'outline-add', id: 'first', title: '第一章', page: 1 }])
  assert.equal((await inspectFixturePdf(added.bytes)).outline?.[0]?.title, '第一章')
})
