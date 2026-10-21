import React, { type RefObject } from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import { formatAnnotationDate } from '../model/reader-dates.js'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface ReaderCommentEditorProps {
  comments: readonly PdfAnnotation[]
  mode: 'read' | 'new' | 'edit'
  editingCommentId?: string
  blockedDeleteIds?: ReadonlySet<string>
  readOnly: boolean
  editable: boolean
  comment: string
  textarea: RefObject<HTMLTextAreaElement>
  onComment(value: string): void
  onAdd(): void
  onEdit(id: string): void
  onDeleteComment(id: string): void
  onApply(): void
  onDismiss(): void
  onClose(): void
  t(key: string): string
}

/** A mark owns one thread; each PDF /IRT reply remains an independent message. */
export function ReaderCommentEditor(props: ReaderCommentEditorProps) {
  const { comments, mode, editingCommentId, blockedDeleteIds, readOnly, editable,
    comment, textarea, onComment, onAdd, onEdit, onDeleteComment,
    onApply, onDismiss, onClose, t } = props
  const canWrite = editable && !readOnly
  return <section className="dsh-pdf-comment-editor" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
  }}>
    <header className="dsh-pdf-comment-editor-header">
      <span className="dsh-pdf-comment-editor-title" data-comment-card-drag-handle="">
        <ToolbarIcon name="comment" />{t('reader.comments')}
      </span>
      <div className="dsh-pdf-comment-editor-header-actions">
        <button type="button" className="dsh-pdf-comment-editor-move" data-comment-card-drag-handle=""
          title={t('reader.moveCommentCard')} aria-label={t('reader.moveCommentCard')}>
          <ToolbarIcon name="move" />
        </button>
        <button type="button" className="dsh-pdf-comment-editor-close" title={t('reader.closeComments')}
          aria-label={t('reader.closeComments')} onClick={onDismiss}><ToolbarIcon name="close" /></button>
      </div>
    </header>
    {comments.length > 0 && <ol className="dsh-pdf-comment-thread" aria-label={t('reader.comments')}>
      {comments.map(entry => {
        const editing = mode === 'edit' && editingCommentId === entry.id
        const date = entry.modifiedAt || entry.createdAt
        return <li key={entry.id} className="dsh-pdf-comment-message" data-comment-id={entry.id}>
          <div className="dsh-pdf-comment-message-heading">
            <strong>{entry.author || t('reader.commentAuthorUnknown')}</strong>
            {date && <time dateTime={date} title={date}>{formatAnnotationDate(date)}</time>}
          </div>
          {editing ? <label className="dsh-pdf-comment-editor-field"><span>{t('reader.commentText')}</span>
            <textarea ref={textarea} value={comment} onChange={event => onComment(event.target.value)}
              disabled={!canWrite} rows={3} /></label>
            : <p className="dsh-pdf-comment-message-body">{entry.contents}</p>}
          {editing && entry.hasRichText && <p className="dsh-pdf-comment-format-warning" role="note">
            {t('reader.richTextConversionWarning')}</p>}
          {entry.readOnlyReason && <p className="dsh-pdf-muted">{t(`reader.reason.${entry.readOnlyReason}`)}</p>}
          {mode === 'read' && canWrite && entry.editable && <div className="dsh-pdf-comment-message-actions">
            <button type="button" aria-label={`${t('reader.editComment')}: ${entry.author || t('reader.commentAuthorUnknown')}`}
              onClick={() => onEdit(entry.id)}>{t('reader.editComment')}</button>
            <button type="button" className="dsh-pdf-comment-editor-delete"
              aria-label={`${t('reader.deleteComment')}: ${entry.author || t('reader.commentAuthorUnknown')}`}
              disabled={!!entry.replyToId && !!blockedDeleteIds?.has(entry.id)}
              title={entry.replyToId && blockedDeleteIds?.has(entry.id)
                ? t('reader.commentHasReplies') : t('reader.deleteComment')}
              onClick={() => onDeleteComment(entry.id)}><ToolbarIcon name="discard" /></button>
          </div>}
        </li>
      })}
    </ol>}
    {mode === 'new' && <label className="dsh-pdf-comment-editor-field"><span>{t('reader.commentText')}</span>
      <textarea ref={textarea} value={comment} onChange={event => onComment(event.target.value)}
        disabled={!canWrite} rows={3} placeholder={t('reader.writeComment')} /></label>}
    {mode === 'read' ? canWrite && <footer className="dsh-pdf-comment-editor-actions">
      <button type="button" className="dsh-pdf-comment-editor-add" onClick={onAdd}>{t('reader.addComment')}</button>
    </footer> : <footer className="dsh-pdf-comment-editor-actions">
      <button type="button" className="dsh-pdf-comment-editor-cancel" onClick={onClose}>{t('reader.cancel')}</button>
      <button type="button" className="dsh-pdf-comment-editor-apply" disabled={!canWrite || !comment.trim()}
        onClick={onApply}>{t('reader.saveComment')}</button>
    </footer>}
  </section>
}
