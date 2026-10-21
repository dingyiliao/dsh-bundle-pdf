import React, { type RefObject } from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import { formatAnnotationDate } from '../model/reader-dates.js'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface ReaderNoteEditorProps {
  note?: PdfAnnotation
  mode: 'read' | 'new' | 'edit'
  readOnly: boolean
  editable: boolean
  value: string
  textarea: RefObject<HTMLTextAreaElement>
  onChange(value: string): void
  onEdit(): void
  onSave(): void
  onCancel(): void
  onDismiss(): void
  onDelete(): void
  t(key: string): string
}

/** A standalone PDF sticky note: independent text, no markup color or comment thread. */
export function ReaderNoteEditor(props: ReaderNoteEditorProps) {
  const { note, mode, readOnly, editable, value, textarea, onChange, onEdit, onSave, onCancel, onDismiss, onDelete, t } = props
  const canWrite = editable && !readOnly
  const date = note?.modifiedAt || note?.createdAt
  return <section className="dsh-pdf-note-editor" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
  }}>
    <header className="dsh-pdf-comment-editor-header">
      <span className="dsh-pdf-comment-editor-title" {...(canWrite ? { 'data-comment-card-drag-handle': '' } : {})}>
        <ToolbarIcon name="note" />{t('reader.note')}
      </span>
      <div className="dsh-pdf-comment-editor-header-actions">
        {canWrite && mode !== 'new' && <button type="button" className="dsh-pdf-comment-editor-delete"
          title={t('reader.delete')} aria-label={t('reader.delete')} onClick={onDelete}><ToolbarIcon name="discard" /></button>}
        <button type="button" className="dsh-pdf-comment-editor-move" data-comment-card-drag-handle=""
          title={t('reader.moveNoteCard')} aria-label={t('reader.moveNoteCard')} disabled={!canWrite}>
          <ToolbarIcon name="move" />
        </button>
        <button type="button" className="dsh-pdf-comment-editor-close" title={t('reader.closeNote')}
          aria-label={t('reader.closeNote')} onClick={onDismiss}><ToolbarIcon name="close" /></button>
      </div>
    </header>
    {mode === 'read' ? <>
      <p className="dsh-pdf-note-body">{note?.contents}</p>
      {(note?.author || date) && <div className="dsh-pdf-note-meta">
        {note?.author && <span>{note.author}</span>}
        {date && <time dateTime={date}>{formatAnnotationDate(date)}</time>}
      </div>}
      {canWrite && <footer className="dsh-pdf-comment-editor-actions">
        <button type="button" className="dsh-pdf-comment-editor-add" onClick={onEdit}>{t('reader.editNote')}</button>
      </footer>}
    </> : <>
      <label className="dsh-pdf-comment-editor-field"><span>{t('reader.note')}</span>
        <textarea ref={textarea} value={value} onChange={event => onChange(event.target.value)}
          disabled={!canWrite} rows={4} placeholder={t('reader.writeNote')} />
      </label>
      <footer className="dsh-pdf-comment-editor-actions">
        <button type="button" className="dsh-pdf-comment-editor-cancel" onClick={onCancel}>{t('reader.cancel')}</button>
        <button type="button" className="dsh-pdf-comment-editor-apply" disabled={!canWrite || !value.trim()}
          onClick={onSave}>{t('reader.saveNote')}</button>
      </footer>
    </>}
  </section>
}
