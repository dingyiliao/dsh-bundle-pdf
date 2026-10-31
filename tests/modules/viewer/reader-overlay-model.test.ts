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
    beginRegion() { calls.push('region') }, selectText() { calls.push('text') },
    removeQuestion(id: string) { calls.push(`remove-question:${id}`) }, async submit() { calls.push('submit') },
    cancel() { calls.push('cancel') }, saveQuestion() { calls.push('save') },
    cancelEditor() { calls.push('cancel-editor') }, deleteQuestion() { calls.push('delete-question') },
    setEditor() {},
  } as unknown as ReaderOverlayModelOptions['explanation']
  const annotations = {
    selected: undefined, selectedNote: undefined, pendingNote: null, commentCardOpen: false,
    noteCardOpen: false, noteMode: 'read', noteText: '', noteColor: '#ffd900', noteTextarea: { current: null }, commentMode: 'read',
    thread: undefined, editingCommentId: undefined, comment: '',
    commentTextarea: { current: null },
    onCommentCardVisible() {}, onNoteCardVisible() {}, setComment() {}, setNoteText() {}, updateColor() {},
    deleteAnnotation() {}, openCommentEditor() {}, editComment() {}, deleteComment() {}, dismissCommentCard() {},
    editNote() {}, cancelNoteEdit() {}, dismissNoteCard() {}, deleteNote() {}, updateNoteColor(color: string) { calls.push(`note-color:${color}`) },
  } as unknown as ReaderOverlayModelOptions['annotations']
  const options: ReaderOverlayModelOptions = {
    explanation, annotations, viewport: null, mode: 'text', regionPurpose: null,
    editable: true, readOnly: false, getExplanationAnchor: () => null, onEditExplanationQuestion: id => { calls.push(`edit-explanation:${id}`) },
    getCommentAnchor: () => null, getCommentPosition: () => null, getNoteAnchor: () => null,
    moveCommentCard: (_delta, position) => { calls.push(`move-comment:${position.left},${position.top}`); return true },
    applyComment: () => calls.push('apply-comment'),
    moveNote: delta => { calls.push(`move-note:${delta.x},${delta.y}`); return true },
    closeComment: () => calls.push('close-comment'), applyNote: () => calls.push('apply-note'), t: key => key,
  }
  return { options, calls }
}

test('explanation overlay exposes live count, image affordance and submit action', async () => {
  const { options, calls } = fixture()
  const model = readerOverlayModel(options)
  assert.equal(model.explanationStatus?.excerpts.length, 1)
  assert.equal(model.explanationStatus?.imageAvailable, true)
  assert.equal(model.explanationStatus?.imageReason, 'visual model')
  model.explanationStatus?.onSend()
  model.explanationStatus?.onSelectText()
  model.explanationStatus?.onSelectArea()
  model.explanationStatus?.onEditQuestion('first')
  model.explanationStatus?.onRemoveQuestion('first')
  await Promise.resolve()
  assert.deepEqual(calls, ['submit', 'text', 'region', 'edit-explanation:first', 'remove-question:first'])
  assert.equal(model.question, undefined)
  assert.equal(model.comment, undefined)
  assert.equal(model.note, undefined)
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

test('comment overlay does not expose annotation color as a note-composition requirement', () => {
  const { options, calls } = fixture()
  const annotations = { ...options.annotations, commentCardOpen: true,
    selected: { id: 'annotation-1', subtype: 'Highlight', page: 1 }, commentMode: 'new',
    updateColor: (color: string) => calls.push(`update:${color}`),
  } as unknown as ReaderOverlayModelOptions['annotations']
  const model = readerOverlayModel({ ...options, annotations })
  assert.ok(model.comment)
  assert.equal('onColor' in model.comment!.editor, false)
  assert.equal('color' in model.comment!.editor, false)
  model.comment?.editor.onApply()
  assert.deepEqual(calls, ['apply-comment'])
})

test('a saved markup comment card exposes its persisted move callback', async () => {
  const { options, calls } = fixture()
  const annotations = { ...options.annotations, commentCardOpen: true,
    selected: { id: 'annotation-1', subtype: 'Highlight', page: 1 },
    canPersistCommentPosition: true,
  } as unknown as ReaderOverlayModelOptions['annotations']
  const model = readerOverlayModel({ ...options, annotations,
    getCommentPosition: () => ({ left: 120, top: 240 } as DOMRect),
  })
  assert.deepEqual([model.comment?.getPosition?.()?.left, model.comment?.getPosition?.()?.top], [120, 240])
  assert.equal(await model.comment?.onMove?.({ x: 8, y: 9 }, { left: 128, top: 249 }), true)
  assert.deepEqual(calls, ['move-comment:128,249'])
})

test('a standalone note gets a distinct card with no comment-thread editor', () => {
  const { options, calls } = fixture()
  const note = { id: 'note', subtype: 'Text', page: 1, contents: 'A sticky note', editable: false }
  const annotations = { ...options.annotations, selected: note, selectedNote: note,
    noteCardOpen: true, noteMode: 'read', noteText: 'A sticky note',
  } as unknown as ReaderOverlayModelOptions['annotations']
  const model = readerOverlayModel({ ...options, annotations })
  assert.equal(model.comment, undefined)
  assert.equal(model.note?.editor.note?.id, 'note')
  assert.equal(model.note?.editor.editable, false)
  assert.equal(model.note?.editor.mode, 'read')
  assert.equal(model.note?.noteColor, '#ffd900')
  model.note?.editor.onColorChange('#ff99aa')
  assert.deepEqual(calls, ['note-color:#ff99aa'])
  assert.ok(model.note?.onMove)
  model.note?.onMove({ x: 12, y: -4 })
  assert.deepEqual(options.annotations.deleteNote instanceof Function, true)
})
