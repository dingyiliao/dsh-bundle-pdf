import React, { useEffect, useState } from 'react'
import type { ReaderDocument, ReaderOutlineItem } from '../ports/reader-document.js'
import type { OutlineEditing } from '../controllers/use-outline-editing.js'
import { safeLinkUrl } from '../model/reader-links.js'
import { OutlineNameEditor } from './OutlineNameEditor.js'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface OutlineRow { key: string; path: string; depth: number; item: ReaderOutlineItem; children: boolean }
const destinationKinds = new Set(['XYZ', 'Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR'])

export function OutlineEntry({ pdf, row, index, expanded, current, editing, revision, dropPlacement, dragging,
  toggle, onNavigateDestination, onMoved, onCancelName, onDragStart, onDragEnd, onDragOver, onDrop, t }: {
  pdf: ReaderDocument; row: OutlineRow; index: number; expanded: boolean; current: boolean
  editing: OutlineEditing; revision?: number; dropPlacement?: string; dragging?: boolean
  toggle(key: string): void; onNavigateDestination(destination: unknown): void
  onMoved(id: string, parentId?: string, revision?: number): void
  onCancelName(): void
  onDragStart(event: React.DragEvent, id: string): void; onDragEnd(): void
  onDragOver(event: React.DragEvent, row: OutlineRow): void; onDrop(event: React.DragEvent, row: OutlineRow): void
  t(key: string): string
}) {
  const href = safeLinkUrl(row.item.url ?? undefined)
  const [resolvedTarget, setTarget] = useState<{ destination: unknown; valid: boolean; reason?: string }>()
  const target = resolvedTarget?.destination === row.item.dest ? resolvedTarget : undefined
  const editor = editing.editor?.id === row.item.id ? editing.editor : undefined
  const editable = editing.editable && !!row.item.id
  useEffect(() => {
    if (row.item.dest === undefined || row.item.dest === null) return
    let cancelled = false
    const resolve = async () => {
      const value = typeof row.item.dest === 'string' ? await pdf.getDestination(row.item.dest) : row.item.dest
      if (!Array.isArray(value) || value.length < 2 || !destinationKinds.has(value[1]?.name)) throw new Error(t('reader.sidebar.bookmarkUnavailable'))
      const page = typeof value[0] === 'number' ? value[0] : await pdf.getPageIndex(value[0])
      if (!Number.isInteger(page) || page < 0 || page >= pdf.numPages) throw new Error(t('reader.sidebar.bookmarkUnavailable'))
      if (!cancelled) setTarget({ destination: row.item.dest, valid: true })
    }
    void resolve().catch(cause => { if (!cancelled) setTarget({ destination: row.item.dest, valid: false,
      reason: cause instanceof Error ? cause.message : t('reader.sidebar.bookmarkUnavailable') }) })
    return () => { cancelled = true }
  }, [pdf, row.item.dest, t])

  const title = row.item.title || t('reader.sidebar.untitledBookmark')
  const navigate = () => { if (!dragging && !editor && target?.valid) onNavigateDestination(row.item.dest) }
  return <div className={`dsh-pdf-bookmark-row${current ? ' is-current' : ''}${editor ? ' is-editing' : ''}${dragging ? ' is-dragging' : ''}`}
    role="treeitem" tabIndex={0} aria-label={title} aria-level={row.depth} aria-current={current ? 'location' : undefined}
    aria-keyshortcuts={editable ? 'F2 Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft' : undefined}
    aria-expanded={row.children ? expanded : undefined} data-outline-id={row.item.id} data-drop-placement={dropPlacement}
    onClick={event => { if (!(event.target as HTMLElement).closest('button, a, input, form')) navigate() }}
    onContextMenu={event => { if (editable && !editor) { event.preventDefault(); editing.openPopup(row.item.id!, event.currentTarget.querySelector<HTMLElement>('.dsh-pdf-outline-more') ?? event.currentTarget) } }}
    onKeyDown={event => {
      if (editor || !row.item.id) return
      if (event.key === 'F2' && editable) { event.preventDefault(); editing.beginRename(row.item.id) }
      else if (event.altKey && editable && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const id = row.item.id
        const direction = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'outdent', ArrowRight: 'indent' } as const)[event.key as 'ArrowUp']
        void editing.move(id, direction).then(operation => { if (operation) onMoved(id, operation.parentId) })
      } else if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); navigate() }
      else if (event.target === event.currentTarget && event.key === 'ArrowRight' && row.children && !expanded) { event.preventDefault(); toggle(row.key) }
      else if (event.target === event.currentTarget && event.key === 'ArrowLeft' && row.children && expanded) { event.preventDefault(); toggle(row.key) }
    }} onDragOver={event => onDragOver(event, row)} onDrop={event => onDrop(event, row)}
    style={{ top: index * 36, height: 36, paddingLeft: Math.min((row.depth - 1) * 14, 98) }}>
    {row.children ? <button type="button" className="dsh-pdf-bookmark-toggle" aria-label={t(expanded ? 'reader.sidebar.collapseBookmark' : 'reader.sidebar.expandBookmark')}
      aria-expanded={expanded} onClick={() => toggle(row.key)}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
    </button> : <span className="dsh-pdf-bookmark-spacer" />}
    {editor ? <OutlineNameEditor editor={editor} busy={editing.busy} stale={revision !== editor.revision}
      onChange={editing.setTitle} onSubmit={() => { void editing.submitName().then(result => { if (result) onMoved(result.id, result.parentId, result.revision) }) }} onCancel={onCancelName} t={t} />
      : row.item.dest !== undefined && row.item.dest !== null ? <button type="button" className="dsh-pdf-bookmark-link" disabled={!target?.valid}
        title={target?.reason ?? title} onClick={navigate}><span className="dsh-pdf-bookmark-title">{title}</span></button>
        : href ? <a draggable={false} className="dsh-pdf-bookmark-link" href={href} target="_blank" rel="noopener noreferrer"><span className="dsh-pdf-bookmark-title">{title}</span></a>
          : <span className="dsh-pdf-bookmark-label" title={title}>{title}</span>}
    {!editor && target?.valid === false && <span className="dsh-pdf-bookmark-unavailable" title={target.reason}>{t('reader.sidebar.bookmarkUnavailable')}</span>}
    {editable && !editor && <button type="button" className="dsh-pdf-outline-grip" draggable={!editing.busy && !editing.editor}
      disabled={editing.busy || !!editing.editor} aria-label={`${t('reader.sidebar.dragBookmark')}: ${title}`} title={t('reader.sidebar.dragBookmarkKeys')}
      onDragStart={event => onDragStart(event, row.item.id!)} onDragEnd={onDragEnd}><ToolbarIcon name="move" /></button>}
    {editable && !editor && <button type="button" className="dsh-pdf-bookmark-action dsh-pdf-outline-more"
      disabled={editing.busy || !!editing.editor} aria-label={`${t('reader.sidebar.moreBookmarkActions')}: ${title}`}
      title={t('reader.sidebar.moreBookmarkActions')} aria-haspopup="menu" aria-expanded={editing.popup?.id === row.item.id}
      onClick={event => editing.openPopup(row.item.id!, event.currentTarget)}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" /></svg>
    </button>}
  </div>
}
