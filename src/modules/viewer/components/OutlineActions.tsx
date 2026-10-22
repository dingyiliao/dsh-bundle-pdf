import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OutlineEditing } from '../controllers/use-outline-editing.js'
import type { OutlineAccess } from '../ports/outline.js'
import { outlineKeyboardMove } from '../model/outline-editing.js'

/** Escape the sidebar's clipped/virtualized rows, but keep reader theme and bounds. */
export function OutlineActions({ editing, access, currentPage, pageCount, onCreate, onMoved, t }: {
  editing: OutlineEditing; access: OutlineAccess; currentPage: number; pageCount: number
  onCreate(parentId?: string, index?: number): void
  onMoved(id: string, parentId?: string): void
  t(key: string): string
}) {
  const { popup } = editing
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 400 })
  const selected = popup && editing.locations.get(popup.id)
  const [page, setPage] = useState(String(selected?.item.page ?? ''))
  const host = popup?.anchor.closest<HTMLElement>('.dsh-pdf-reader')
  const stale = popup?.revision !== access.revision
  const disabled = editing.busy || stale

  useLayoutEffect(() => {
    if (!popup || !host || !panel.current) return
    const place = () => {
      if (!popup.anchor.isConnected) { editing.closePopup(); return }
      const bounds = host.getBoundingClientRect(), anchor = popup.anchor.getBoundingClientRect()
      const width = Math.min(252, Math.max(0, bounds.width - 16))
      const height = Math.min(panel.current?.scrollHeight ?? 0, bounds.height - 16)
      const below = anchor.bottom - bounds.top + 5
      setPosition({ left: Math.max(8, Math.min(anchor.right - bounds.left - width, bounds.width - width - 8)),
        top: Math.max(8, below + height <= bounds.height - 8 ? below : anchor.top - bounds.top - height - 5),
        maxHeight: Math.max(0, bounds.height - 16) })
    }
    place()
    panel.current.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !popup.anchor.contains(event.target)) editing.closePopup()
    }
    const observer = new ResizeObserver(place)
    observer.observe(host)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside)
    }
  }, [popup?.id, popup?.kind, host])

  if (!popup || !host || !selected) return null
  const move = async (direction: 'up' | 'down' | 'indent' | 'outdent') => {
    const operation = outlineKeyboardMove(editing.locations, access.items ?? [], popup.id, direction)
    if (await editing.move(popup.id, direction)) onMoved(popup.id, operation?.parentId)
  }
  const remove = async () => {
    if (await editing.change([{ type: 'outline-delete', id: popup.id }], popup.revision)) editing.closePopup(true)
  }
  const setTarget = async (value: number) => {
    if (await editing.change([{ type: 'outline-update', id: popup.id, patch: { page: value } }], popup.revision)) editing.closePopup(true)
  }
  const menuItem = (key: string, action: () => void, unavailable = false, shortcut?: string) =>
    <button key={key} type="button" role="menuitem" aria-label={t(`reader.sidebar.${key}`)} disabled={disabled || unavailable} onClick={action}>
      <span>{t(`reader.sidebar.${key}`)}</span>{shortcut && <kbd>{shortcut}</kbd>}
    </button>
  const moves = (['up', 'down', 'indent', 'outdent'] as const).map((direction, index) => ({ direction, index }))
    .filter(({ direction }) => outlineKeyboardMove(editing.locations, access.items ?? [], popup.id, direction))

  return createPortal(<div ref={panel} className="dsh-pdf-outline-popover dsh-pdf-glass" data-outline-popup={popup.kind}
    style={{ ...position, width: 'min(252px, calc(100% - 16px))' }} role={popup.kind === 'menu' ? 'menu' : 'dialog'}
    aria-label={t(popup.kind === 'target' ? 'reader.sidebar.bookmarkTargetPage' : popup.kind === 'delete' ? 'reader.sidebar.deletePdfBookmark' : 'reader.sidebar.moreBookmarkActions')}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing.closePopup(true); return }
      if (popup.kind !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
        && !popup.anchor.contains(event.relatedTarget)) editing.closePopup()
    }}>
    <div className="dsh-pdf-outline-popover-title" title={selected.item.title}>{selected.item.title}</div>
    {popup.kind === 'menu' ? <>
      {menuItem('renameBookmark', () => editing.beginRename(popup.id), false, 'F2')}
      {menuItem('changeBookmarkTarget', () => editing.setPopupKind('target'))}
      <div className="dsh-pdf-outline-menu-separator" role="separator" />
      {menuItem('addSiblingBookmark', () => onCreate(selected.parentId, selected.index + 1))}
      {menuItem('addChildBookmark', () => onCreate(popup.id))}
      {!!moves.length && <div className="dsh-pdf-outline-menu-separator" role="separator" />}
      {moves.map(({ direction, index }) => menuItem(
        ['moveBookmarkUp', 'moveBookmarkDown', 'indentBookmark', 'outdentBookmark'][index]!, () => { void move(direction) },
        false, ['⌥↑', '⌥↓', '⌥→', '⌥←'][index]))}
      <div className="dsh-pdf-outline-menu-separator" role="separator" />
      {menuItem('deleteBookmark', () => { if (selected.item.children.length) editing.setPopupKind('delete'); else void remove() })}
    </> : popup.kind === 'target' ? <form onSubmit={event => { event.preventDefault(); if (/^\d+$/.test(page) && +page >= 1 && +page <= pageCount) void setTarget(+page) }}>
      <p>{t(selected.item.page ? 'reader.sidebar.currentBookmarkTarget' : 'reader.sidebar.keepBookmarkTarget')}{selected.item.page ? ` ${selected.item.page}` : ''}</p>
      <button type="button" disabled={disabled} onClick={() => { void setTarget(currentPage) }}>{t('reader.sidebar.useCurrentPage')} · {currentPage}</button>
      <label>{t('reader.sidebar.bookmarkTargetPage')}<input type="number" min={1} max={pageCount} value={page}
        disabled={disabled} onChange={event => setPage(event.target.value)} /></label>
      <div className="dsh-pdf-outline-popover-actions">
        <button type="submit" disabled={disabled || !/^\d+$/.test(page) || +page < 1 || +page > pageCount}>{t('reader.sidebar.applyBookmarkTarget')}</button>
        <button type="button" disabled={editing.busy} onClick={() => editing.closePopup(true)}>{t('reader.cancel')}</button>
      </div>
    </form> : <>
      <p>{t('reader.sidebar.deleteBookmarkSubtree')}</p>
      <div className="dsh-pdf-outline-popover-actions">
        <button type="button" disabled={disabled} onClick={() => { void remove() }}>{t('reader.sidebar.confirmDeleteBookmark')}</button>
        <button type="button" disabled={editing.busy} onClick={() => editing.closePopup(true)}>{t('reader.cancel')}</button>
      </div>
    </>}
    {(stale || editing.error) && <p role="alert">{stale ? t('reader.sidebar.outlineChanged') : editing.error}</p>}
  </div>, host)
}
