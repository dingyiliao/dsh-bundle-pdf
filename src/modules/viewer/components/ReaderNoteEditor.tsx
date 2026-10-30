import { useRef, useState, type RefObject } from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import { formatAnnotationDate } from '../model/reader-dates.js'
import { ToolbarIcon } from './ToolbarIcon.js'
import { AnnotationColorBar } from './AnnotationColorBar.js'
import { ReaderPopover } from './ReaderPopover.js'

export interface ReaderNoteEditorProps {
  note?: PdfAnnotation
  mode: 'read' | 'new' | 'edit'
  readOnly: boolean
  editable: boolean
  value: string
  color: string
  textarea: RefObject<HTMLTextAreaElement>
  onChange(value: string): void
  onColorChange(color: string): void
  onEdit(): void
  onSave(): void
  onCancel(): void
  onDismiss(): void
  onDelete(): void
  t(key: string): string
}

/** A standalone PDF sticky note: independent text and paper color, no markup or comment thread. */
export function ReaderNoteEditor(props: ReaderNoteEditorProps) {
  const { note, mode, readOnly, editable, value, color, textarea, onChange, onColorChange,
    onEdit, onSave, onCancel, onDismiss, onDelete, t } = props
  const canWrite = editable && !readOnly
  const date = note?.modifiedAt || note?.createdAt
  const [colorsOpen, setColorsOpen] = useState(false)
  const colorsRef = useRef<HTMLButtonElement>(null)
  return <section className="dsh-pdf-note-editor" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
  }}>
    <header className="dsh-pdf-comment-editor-header">
      <span className="dsh-pdf-comment-editor-title" {...(canWrite ? { 'data-comment-card-drag-handle': '' } : {})}>
        <ToolbarIcon name="note" />{t('reader.note')}
      </span>
      <div className="dsh-pdf-comment-editor-header-actions">
        {canWrite && mode !== 'new' && <div className="dsh-pdf-note-color-control">
          <button ref={colorsRef} type="button" className="dsh-pdf-note-color" aria-label={t('reader.changeNoteColor')}
            title={t('reader.changeNoteColor')} aria-expanded={colorsOpen} aria-haspopup="dialog"
            onClick={() => setColorsOpen(open => !open)}>
            <span className="dsh-pdf-note-color-core" style={{ backgroundColor: color }} aria-hidden="true" />
          </button>
          {colorsOpen && <ReaderPopover anchor={colorsRef} open onClose={() => setColorsOpen(false)}
            className="dsh-pdf-note-color-popover dsh-pdf-glass" role="dialog" aria-label={t('reader.changeNoteColor')}>
            <AnnotationColorBar palette="note" value={color} label={t('reader.colorPalette')} t={t}
              onQuickColor={hex => { onColorChange(hex); setColorsOpen(false) }}
              onPaletteColor={onColorChange} />
          </ReaderPopover>}
        </div>}
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
