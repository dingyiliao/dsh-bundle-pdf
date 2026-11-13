import { useLayoutEffect, useRef } from 'react'
import type { OutlineNameEdit } from '../controllers/use-outline-editing.js'

export function OutlineNameEditor({ editor, busy, stale, onChange, onSubmit, onCancel, t }: {
  editor: OutlineNameEdit; busy: boolean; stale: boolean
  onChange(title: string): void; onSubmit(): void; onCancel(): void; t(key: string): string
}) {
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { input.current?.focus(); input.current?.select() }, [editor.id])
  return <form className="dsh-pdf-outline-name-editor" aria-label={t(editor.kind === 'create' ? 'reader.sidebar.addPdfBookmark' : 'reader.sidebar.renameBookmark')}
    onSubmit={event => { event.preventDefault(); onSubmit() }} onClick={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel() } }}>
    <input ref={input} aria-label={t('reader.sidebar.bookmarkName')} title={t('reader.sidebar.bookmarkNameKeys')}
      value={editor.title} maxLength={1024} disabled={busy || stale} onChange={event => onChange(event.target.value)} />
    <button type="submit" disabled={busy || stale || !editor.title.trim()} aria-label={t('reader.sidebar.applyBookmarkName')} title={t('reader.sidebar.applyBookmarkName')}>✓</button>
    <button type="button" disabled={busy} onClick={onCancel} aria-label={t('reader.cancel')} title={t('reader.cancel')}>×</button>
  </form>
}
