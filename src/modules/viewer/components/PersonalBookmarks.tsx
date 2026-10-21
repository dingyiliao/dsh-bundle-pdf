import React, { useEffect, useRef, useState } from 'react'
import type { NavigationPosition } from '../../../navigation/index.js'
import type { PdfClientApi, PdfUserBookmark } from '../../../shared/contracts.js'
import type { ReaderDocument } from '../ports/reader-document.js'
import { useVirtualRows } from '../controllers/use-virtual-rows.js'

const rowHeight = 52

export interface BookmarkAccess {
  api: PdfClientApi
  sessionId: string
  documentId: string
  capturePosition(): NavigationPosition
  onNavigatePosition(position: NavigationPosition): void
}

export function PersonalBookmarks({ access, document, active, t }: {
  access?: BookmarkAccess
  document: ReaderDocument | null
  active: boolean
  t(key: string): string
}) {
  const [items, setItems] = useState<PdfUserBookmark[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [editTitle, setEditTitle] = useState('')
  const [deletingId, setDeletingId] = useState<string>()
  const [actionsId, setActionsId] = useState<string>()
  const operation = useRef<AbortController | null>(null)
  const listing = useRef<AbortController | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const api = access?.api, sessionId = access?.sessionId, documentId = access?.documentId
  const { root, start, end, totalHeight } = useVirtualRows(items?.length ?? 0, rowHeight, active)

  useEffect(() => {
    setItems(undefined)
    setError('')
    setCreating(false)
    setEditingId(undefined)
    setDeletingId(undefined)
    setActionsId(undefined)
    operation.current?.abort()
  }, [api, sessionId, documentId, document])

  useEffect(() => {
    if (!active || !api || !sessionId || !documentId) return
    const controller = new AbortController()
    listing.current = controller
    setError('')
    void api.bookmarks.list(sessionId, documentId, controller.signal).then(next => {
      if (!controller.signal.aborted) setItems(next)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { controller.abort(); if (listing.current === controller) listing.current = null }
  }, [active, api, sessionId, documentId, document, listRevision])

  useEffect(() => () => operation.current?.abort(), [api, sessionId, documentId])

  const update = async (run: (signal: AbortSignal) => Promise<PdfUserBookmark[]>): Promise<boolean> => {
    if (busy) return false
    listing.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    try {
      const next = await run(controller.signal)
      if (controller.signal.aborted) return false
      setItems(next)
      return true
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false) } }
  }

  const beginCreate = () => {
    if (!access) return
    const page = access.capturePosition().page
    setNewTitle(`${t('reader.page')} ${page}`)
    setCreating(true)
    setEditingId(undefined)
    setActionsId(undefined)
  }
  const create = () => {
    if (!access || !newTitle.trim()) return
    const { documentVersion: _documentVersion, ...position } = access.capturePosition()
    void update(signal => access.api.bookmarks.add(access.sessionId, access.documentId, newTitle.trim(), position, signal))
      .then(success => { if (success) setCreating(false) })
  }
  const rename = (bookmarkId: string) => {
    if (!access || !editTitle.trim()) return
    void update(signal => access.api.bookmarks.rename(access.sessionId, access.documentId, bookmarkId, editTitle.trim(), signal))
      .then(success => { if (success) setEditingId(undefined) })
  }
  const remove = (bookmarkId: string) => {
    if (!access) return
    void update(signal => access.api.bookmarks.remove(access.sessionId, access.documentId, bookmarkId, signal))
      .then(success => { if (success) setDeletingId(undefined) })
  }

  return <section className="dsh-pdf-personal-bookmarks" aria-label={t('reader.sidebar.myBookmarks')}>
    <div className="dsh-pdf-bookmark-section-heading">
      <div className="dsh-pdf-bookmark-heading-title">
        <h4>{t('reader.sidebar.myBookmarks')}</h4>
        <details className="dsh-pdf-bookmark-info"
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false }}>
          <summary aria-label={t('reader.sidebar.bookmarkStorageInfo')} title={t('reader.sidebar.bookmarkStorageInfo')}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="8" cy="8" r="6.25" /><path d="M8 7v4M8 4.5v.5" strokeLinecap="round" />
            </svg>
          </summary>
          <p>{t('reader.sidebar.bookmarkStorage')}</p>
        </details>
      </div>
      <button type="button" disabled={!access || busy} onClick={beginCreate} title={t('reader.sidebar.addBookmark')}
        aria-label={t('reader.sidebar.addBookmark')}>+</button>
    </div>
    {creating && <form className="dsh-pdf-bookmark-form" onSubmit={event => { event.preventDefault(); create() }}>
      <input autoFocus aria-label={t('reader.sidebar.bookmarkName')} value={newTitle} onChange={event => setNewTitle(event.target.value)} maxLength={200} />
      <button type="submit" disabled={busy || !newTitle.trim()}>{t('reader.sidebar.add')}</button>
      <button type="button" onClick={() => setCreating(false)}>{t('reader.cancel')}</button>
    </form>}
    {error && <div className="dsh-pdf-sidebar-empty" role="alert">{error} <button type="button"
      onClick={() => setListRevision(value => value + 1)}>{t('reader.sidebar.retryBookmarks')}</button></div>}
    {active && access && !items && !error && <p className="dsh-pdf-sidebar-empty" role="status">{t('reader.sidebar.bookmarksLoading')}</p>}
    {items?.length === 0 && <p className="dsh-pdf-sidebar-empty">{t('reader.sidebar.myBookmarksEmpty')}</p>}
    {!!items?.length && <div ref={root} className="dsh-pdf-personal-bookmark-list" tabIndex={0} aria-label={t('reader.sidebar.myBookmarks')}>
      <div className="dsh-pdf-personal-bookmark-virtual" style={{ height: totalHeight }}>
      {items.slice(start, end).map((item, offset) => <div key={item.id} className="dsh-pdf-personal-bookmark-row"
        style={{ position: 'absolute', top: (start + offset) * rowHeight, left: 6, right: 6, height: rowHeight }}
        onClick={event => {
          if (busy || item.stale === 'page-missing' || editingId === item.id || deletingId === item.id
            || (event.target as HTMLElement).closest('button, a, input, select, textarea, summary, [role="menuitem"]')) return
          access?.onNavigatePosition({ ...item.position, documentVersion: access.capturePosition().documentVersion })
        }}>
        {editingId === item.id ? <form className="dsh-pdf-bookmark-form" onSubmit={event => { event.preventDefault(); rename(item.id) }}>
          <input autoFocus aria-label={t('reader.sidebar.bookmarkName')} value={editTitle} onChange={event => setEditTitle(event.target.value)} maxLength={200} />
          <button disabled={busy || !editTitle.trim()}>{t('reader.sidebar.saveBookmark')}</button>
          <button type="button" onClick={() => setEditingId(undefined)}>{t('reader.cancel')}</button>
        </form> : <>
          <div className="dsh-pdf-personal-bookmark-details">
            <button type="button" className="dsh-pdf-personal-bookmark-jump" disabled={item.stale === 'page-missing' || busy}
              title={item.stale === 'page-missing' ? t('reader.sidebar.bookmarkPageMissing') : item.title}
              onClick={() => access?.onNavigatePosition({ ...item.position, documentVersion: access.capturePosition().documentVersion })}>
              <span className="dsh-pdf-personal-bookmark-title">{item.title}</span>
            </button>
            <span className="dsh-pdf-personal-bookmark-page">{t('reader.page')} {item.position.page}{item.stale === 'content-changed' ? ` · ${t('reader.sidebar.bookmarkChanged')}`
              : item.stale === 'page-missing' ? ` · ${t('reader.sidebar.bookmarkPageMissing')}` : ''}</span>
          </div>
          {deletingId === item.id ? <>
            <button type="button" className="dsh-pdf-bookmark-action" disabled={busy} onClick={() => remove(item.id)}>{t('reader.sidebar.confirmDeleteBookmark')}</button>
            <button type="button" className="dsh-pdf-bookmark-action" onClick={() => setDeletingId(undefined)}>{t('reader.cancel')}</button>
          </> : <div className="dsh-pdf-bookmark-actions"
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsId(undefined) }}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              setActionsId(undefined)
              event.currentTarget.querySelector<HTMLButtonElement>('.dsh-pdf-bookmark-more')?.focus()
            }}>
            <button type="button" className="dsh-pdf-bookmark-action dsh-pdf-bookmark-more" disabled={busy}
              title={t('reader.sidebar.moreBookmarkActions')} aria-label={`${t('reader.sidebar.moreBookmarkActions')}: ${item.title}`}
              aria-expanded={actionsId === item.id} onClick={() => setActionsId(actionsId === item.id ? undefined : item.id)}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                <circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" />
              </svg>
            </button>
            {actionsId === item.id && <>
              <button type="button" className="dsh-pdf-bookmark-action" disabled={busy} title={t('reader.sidebar.renameBookmark')}
                aria-label={`${t('reader.sidebar.renameBookmark')}: ${item.title}`}
                onClick={() => { setEditingId(item.id); setEditTitle(item.title); setActionsId(undefined) }}>✎</button>
              <button type="button" className="dsh-pdf-bookmark-action" disabled={busy} title={t('reader.sidebar.deleteBookmark')}
                aria-label={`${t('reader.sidebar.deleteBookmark')}: ${item.title}`}
                onClick={() => { setDeletingId(item.id); setActionsId(undefined) }}>×</button>
            </>}
          </div>}
        </>}
      </div>)}
      </div>
    </div>}
  </section>
}
