import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'
import { annotationRoot, annotationThread, createAnnotationThreadIndex, isReply } from '../../../src/modules/viewer/model/annotation-thread.ts'

const mark = (id: string, overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id, page: 1, subtype: 'Highlight', flags: 4, supported: true, editable: true,
  rect: [10, 20, 40, 30], ...overrides,
})

test('PDF IRT replies belong to one markup thread, including nested replies', () => {
  const root = mark('mark', { contents: 'A comment' })
  const first = mark('first', { subtype: 'Text', replyToId: 'mark', contents: 'A reply', author: 'Alice' })
  const second = mark('second', { subtype: 'Text', replyToId: 'first', contents: 'Nested reply', author: 'Bob' })
  const group = mark('group', { subtype: 'Text', replyToId: 'mark', replyType: 'Group', contents: 'Grouped mark' })
  const all = [second, first, root, group]
  const byId = new Map(all.map(item => [item.id, item]))
  assert.equal(annotationRoot(second, byId), root)
  assert.deepEqual(annotationThread(root, all).comments.map(item => item.id), ['mark', 'first', 'second'])
  assert.equal(isReply(group), false)
})

test('a deep out-of-order reply chain resolves parent-first without recursive stack growth', () => {
  const root = mark('root', { contents: 'Root' })
  const replies = Array.from({ length: 1200 }, (_, index) => mark(`reply-${index}`, {
    subtype: 'Text', replyToId: index === 0 ? root.id : `reply-${index - 1}`,
    contents: `Comment ${index}`,
  }))
  const index = createAnnotationThreadIndex([...replies].reverse().concat(root))
  assert.equal(index.rootOf(replies.at(-1)!), root)
  const comments = index.thread(root).comments
  assert.equal(comments.length, replies.length + 1)
  assert.deepEqual(comments.slice(0, 3).map(item => item.id), ['root', 'reply-0', 'reply-1'])
  assert.equal(comments.at(-1)?.id, 'reply-1199')
})

test('blank root can still expose replies while broken and cyclic links remain bounded', () => {
  const root = mark('root')
  const reply = mark('reply', { subtype: 'Text', replyToId: 'root', contents: 'Only reply' })
  const crossPage = mark('cross', { page: 2, subtype: 'Text', replyToId: 'root', contents: 'Wrong page' })
  const a = mark('a', { subtype: 'Text', replyToId: 'b', contents: 'A' })
  const b = mark('b', { subtype: 'Text', replyToId: 'a', contents: 'B' })
  const all = [root, reply, crossPage, a, b]
  const byId = new Map(all.map(item => [item.id, item]))
  assert.deepEqual(annotationThread(root, all).comments.map(item => item.id), ['reply'])
  assert.equal(annotationRoot(crossPage, byId), crossPage)
  assert.equal(annotationRoot(a, byId).id, annotationRoot(b, byId).id)
  const index = createAnnotationThreadIndex(all)
  assert.equal(index.rootOf(a).id, index.rootOf(b).id)
})
