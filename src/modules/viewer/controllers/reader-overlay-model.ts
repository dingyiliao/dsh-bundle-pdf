import type { ReaderViewProps } from '../components/ReaderView.js'
import type { useReaderAnnotations } from './use-reader-annotations.js'
import type { useReaderExplanation } from './use-reader-explanation.js'
import { MAX_EXPLANATION_EXCERPTS } from '../../explanation/index.js'

export interface ReaderOverlayModelOptions {
  explanation: ReturnType<typeof useReaderExplanation>
  annotations: ReturnType<typeof useReaderAnnotations>
  viewport: HTMLElement | null
  mode: 'text' | 'region' | 'note'
  regionPurpose: 'explanation' | 'screenshot' | null
  editable: boolean
  readOnly: boolean
  getExplanationAnchor(): DOMRect | null
  getCommentAnchor(): DOMRect | null
  getCommentPosition(): DOMRect | null
  getNoteAnchor(): DOMRect | null
  moveNote(delta: { x: number; y: number }): boolean | Promise<boolean>
  moveCommentCard(delta: { x: number; y: number }, position: { left: number; top: number }): boolean | Promise<boolean>
  applyComment(): void
  closeComment(): void
  applyNote(): void
  t(key: string): string
}

type OverlayModel = Pick<ReaderViewProps, 'question' | 'comment' | 'note'> & {
  explanationStatus: ReaderViewProps['floating']['explanation']
}

/** Convert feature-owned draft/editor state into anchored overlay bindings. */
export function readerOverlayModel(options: ReaderOverlayModelOptions): OverlayModel {
  const { explanation, annotations, viewport, mode, regionPurpose, editable, readOnly,
    getExplanationAnchor, getCommentAnchor, getCommentPosition, getNoteAnchor, moveNote, moveCommentCard,
    applyComment, closeComment, applyNote, t } = options
  const { active, editor, sending, saving, imageAvailability } = explanation
  const { selected, selectedNote, pendingNote, commentCardOpen, noteCardOpen, noteMode, noteText,
    noteTextarea, commentMode, editingCommentId, thread, comment, commentTextarea } = annotations
  const explanationStatus = active ? {
    count: active.excerpts.length, max: MAX_EXPLANATION_EXCERPTS,
    sending: sending || saving, disabled: !!editor,
    imageAvailable: imageAvailability?.status === 'available',
    imageReason: imageAvailability?.status === 'unavailable' ? imageAvailability.reason
      : imageAvailability?.status === 'available' ? imageAvailability.limitation
        : t('reader.explain.imageChecking'),
    selectingArea: mode === 'region' && regionPurpose === 'explanation',
    onSelectArea: explanation.beginRegion, error: explanation.error, t,
    onSend: () => { void explanation.submit() }, onExit: explanation.cancel,
  } : undefined
  const question = editor ? {
    key: editor.kind === 'new' ? editor.draftId : editor.excerptId,
    props: {
      viewport, getAnchor: getExplanationAnchor, mode: editor.kind,
      index: editor.kind === 'new' ? (active?.excerpts.length ?? 0) + 1
        : (active?.excerpts.findIndex(item => item.id === editor.excerptId) ?? -1) + 1,
      question: editor.question, disabled: sending || saving, t,
      onChange: (value: string) => explanation.setEditor(current => current && current.key === explanation.key
        ? { ...current, question: value } : current),
      onSave: () => { void explanation.saveQuestion() }, onCancel: explanation.cancelEditor,
      onDelete: editor.kind === 'edit' ? explanation.deleteQuestion : undefined,
    },
  } : undefined
  const commentBinding = commentCardOpen && selected && selected.subtype !== 'Text' ? {
    key: selected.id,
    viewport, getAnchor: getCommentAnchor, getPosition: getCommentPosition,
    onMove: annotations.canPersistCommentPosition ? (delta: { x: number; y: number }, position: { left: number; top: number }) =>
      moveCommentCard(delta, position) : undefined,
    onVisible: annotations.onCommentCardVisible,
    editor: {
      comments: thread?.comments ?? [], mode: commentMode, editingCommentId,
      blockedDeleteIds: annotations.blockedCommentDeleteIds,
      readOnly, editable: editable && !!selected.editable,
      comment, textarea: commentTextarea,
      onComment: annotations.setComment,
      onAdd: annotations.openCommentEditor, onEdit: annotations.editComment,
      onDeleteComment: (id: string) => { void annotations.deleteComment(id) }, onApply: applyComment,
      onClose: closeComment, onDismiss: annotations.dismissCommentCard, t,
    },
  } : undefined
  const noteBinding = noteCardOpen && (selectedNote || pendingNote) ? {
    key: selectedNote?.id ?? pendingNote!.id,
    viewport, getAnchor: getNoteAnchor, onVisible: annotations.onNoteCardVisible,
    onMove: moveNote,
    editor: {
      note: selectedNote, mode: noteMode, readOnly,
      editable: editable && (!!pendingNote || !!selectedNote?.editable),
      value: noteText, textarea: noteTextarea,
      onChange: annotations.setNoteText, onEdit: annotations.editNote,
      onSave: applyNote, onCancel: annotations.cancelNoteEdit,
      onDismiss: annotations.dismissNoteCard,
      onDelete: () => { void annotations.deleteNote() }, t,
    },
  } : undefined
  return { explanationStatus, question, comment: commentBinding, note: noteBinding }
}
