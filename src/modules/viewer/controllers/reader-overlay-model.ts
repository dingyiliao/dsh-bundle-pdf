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
  applyComment(): void
  closeComment(): void
  t(key: string): string
}

type OverlayModel = Pick<ReaderViewProps, 'question' | 'comment'> & {
  explanationStatus: ReaderViewProps['floating']['explanation']
}

/** Convert feature-owned draft/editor state into anchored overlay bindings. */
export function readerOverlayModel(options: ReaderOverlayModelOptions): OverlayModel {
  const { explanation, annotations, viewport, mode, regionPurpose, editable, readOnly,
    getExplanationAnchor, getCommentAnchor, applyComment, closeComment, t } = options
  const { active, editor, sending, saving, imageAvailability } = explanation
  const { selected, pendingNote, commentCardOpen, commentMode, editingCommentId,
    thread, comment, commentColor, commentTextarea } = annotations
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
  const commentBinding = commentCardOpen && (selected || pendingNote) ? {
    key: selected?.id ?? pendingNote!.id,
    viewport, getAnchor: getCommentAnchor, onVisible: annotations.onCommentCardVisible,
    editor: {
      comments: thread?.comments ?? [], mode: commentMode, editingCommentId,
      blockedDeleteIds: annotations.blockedCommentDeleteIds, pendingNote: !!pendingNote,
      readOnly, editable: editable && (!!pendingNote || !!selected?.editable),
      comment, color: commentColor, textarea: commentTextarea,
      onComment: annotations.setComment,
      onColor: annotations.setCommentColor,
      onAdd: annotations.openCommentEditor, onEdit: annotations.editComment,
      onDeleteComment: (id: string) => { void annotations.deleteComment(id) }, onApply: applyComment,
      onClose: closeComment, onDismiss: annotations.dismissCommentCard, t,
    },
  } : undefined
  return { explanationStatus, question, comment: commentBinding }
}
