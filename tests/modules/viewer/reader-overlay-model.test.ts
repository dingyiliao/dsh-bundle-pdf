import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ReaderOverlayModelOptions } from '../../../src/modules/viewer/controllers/reader-overlay-model.ts'
import { readerOverlayModel } from '../../../src/modules/viewer/controllers/reader-overlay-model.ts'

function fixture() {
  const calls: string[] = []
  const explanation = {
    key: 'explain-1', active: { excerpts: [{ id: 'first', question: 'why' }] },
    editor: null, sending: false, saving: false,
    imageAvailability: { status: 'available', limitation: 'visual model' }, error: '',
    beginRegion() { calls.push('region') }, async submit() { calls.push('submit') },
    cancel() { calls.push('cancel') }, saveQuestion() { calls.push('save') },
    cancelEditor() { calls.push('cancel-editor') }, deleteQuestion() { calls.push('delete-question') },
    setEditor() {},
  } as unknown as ReaderOverlayModelOptions['explanation']
  const annotations = {
    selected: undefined, pendingNote: null, commentCardOpen: false, commentMode: 'read',
    thread: undefined, editingCommentId: undefined, comment: '',
    commentColor: '#ffff00', commentTextarea: { current: null },
    onCommentCardVisible() {}, setComment() {}, updateColor() {}, setCommentColor() {},
    deleteAnnotation() {}, openCommentEditor() {}, editComment() {}, deleteComment() {}, dismissCommentCard() {},
  } as unknown as ReaderOverlayModelOptions['annotations']
  const options: ReaderOverlayModelOptions = {
    explanation, annotations, viewport: null, mode: 'text', regionPurpose: null,
    editable: true, readOnly: false, getExplanationAnchor: () => null,
    getCommentAnchor: () => null, applyComment: () => calls.push('apply-comment'),
    closeComment: () => calls.push('close-comment'), t: key => key,
  }
  return { options, calls }
}

test('explanation overlay exposes live count, image affordance and submit action', async () => {
  const { options, calls } = fixture()
  const model = readerOverlayModel(options)
  assert.equal(model.explanationStatus?.count, 1)
  assert.equal(model.explanationStatus?.imageAvailable, true)
  assert.equal(model.explanationStatus?.imageReason, 'visual model')
  model.explanationStatus?.onSend()
  await Promise.resolve()
  assert.deepEqual(calls, ['submit'])
  assert.equal(model.question, undefined)
  assert.equal(model.comment, undefined)
})

test('question overlay keeps draft identity and edit index tied to the active excerpt', () => {
  const { options } = fixture()
  const explanation = { ...options.explanation,
    editor: { key: 'explain-1', kind: 'edit', excerptId: 'first', question: 'Explain this' },
  } as ReaderOverlayModelOptions['explanation']
  const model = readerOverlayModel({ ...options, explanation })
  assert.equal(model.question?.key, 'first')
  assert.equal(model.question?.props.mode, 'edit')
  assert.equal(model.question?.props.index, 1)
  assert.ok(model.question?.props.onDelete)
})

test('comment overlay gives new note color to its draft, not annotation color', () => {
  const { options, calls } = fixture()
  const annotations = { ...options.annotations, commentCardOpen: true,
    selected: { id: 'annotation-1', subtype: 'Highlight', page: 1 }, commentMode: 'new',
    pendingNote: { id: 'note-1', subtype: 'Text', page: 1 },
    updateColor: (color: string) => calls.push(`update:${color}`),
    setCommentColor: (color: string) => calls.push(`draft:${color}`),
  } as unknown as ReaderOverlayModelOptions['annotations']
  const model = readerOverlayModel({ ...options, annotations })
  assert.ok(model.comment)
  model.comment?.editor.onColor('#123456')
  model.comment?.editor.onApply()
  assert.deepEqual(calls, ['draft:#123456', 'apply-comment'])
})

test('a locked or Group root can be read but cannot offer Add comment', () => {
  const { options } = fixture()
  const annotations = { ...options.annotations, commentCardOpen: true,
    selected: { id: 'group', subtype: 'Text', page: 1, editable: false },
    thread: { comments: [{ id: 'group', contents: 'Imported comment' }] },
  } as unknown as ReaderOverlayModelOptions['annotations']
  const model = readerOverlayModel({ ...options, annotations })
  assert.equal(model.comment?.editor.editable, false)
  assert.equal(model.comment?.editor.comments.length, 1)
})
