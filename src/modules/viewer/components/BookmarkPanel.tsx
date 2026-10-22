import React, { useEffect, useMemo, useRef, useState } from 'react'
import { currentOutlineKey, outlineAncestorKeys } from '../model/bookmark-current.js'
import { outlineDrop, type OutlinePlacement } from '../model/outline-editing.js'
import type { ReaderDocument, ReaderOutlineItem } from '../ports/reader-document.js'
import type { OutlineAccess } from '../ports/outline.js'
import { useOutlineEditing, type OutlineNameEdit } from '../controllers/use-outline-editing.js'
import { useVirtualRows } from '../controllers/use-virtual-rows.js'
import { OutlineEntry, type OutlineRow } from './OutlineEntry.js'
import { OutlineActions } from './OutlineActions.js'

export type { OutlineAccess } from '../ports/outline.js'

const rowHeight = 36
function outlineRows(items: readonly ReaderOutlineItem[], expanded?: ReadonlySet<string>): OutlineRow[] {
  const result: OutlineRow[] = []
  const stack = items.map((item, index) => ({ item, path: String(index), depth: 1 })).reverse()
  while (stack.length) {
    const next = stack.pop()!
    const key = next.item.id ?? next.path
    result.push({ ...next, key, children: next.item.items.length > 0 })
    if (!expanded || expanded.has(key)) {
      for (let index = next.item.items.length - 1; index >= 0; index--) {
        stack.push({ item: next.item.items[index]!, path: `${next.path}/${index}`, depth: next.depth + 1 })
      }
    }
  }
  return result
}

/** An unsubmitted name is a temporary row, not a PDF mutation. Escape removes it. */
function withNewBookmark(items: readonly ReaderOutlineItem[], draft?: OutlineNameEdit): readonly ReaderOutlineItem[] {
  if (!draft || draft.kind !== 'create') return items
  const placeholder: ReaderOutlineItem = { id: draft.id, title: draft.title, items: [] }
  const insert = (list: readonly ReaderOutlineItem[], parentId?: string): ReaderOutlineItem[] => {
    if (parentId === draft.parentId) {
      const result = [...list]; result.splice(draft.index ?? result.length, 0, placeholder); return result
    }
    return list.map(item => ({ ...item, items: insert(item.items, item.id) }))
  }
  return insert(items)
}

export function BookmarkPanel({ pdf, active, currentPage, outlineAccess, onNavigateDestination, t }: {
  pdf: ReaderDocument | null; active: boolean; currentPage: number
  outlineAccess?: OutlineAccess
  onNavigateDestination(destination: unknown): void; t(key: string): string
}) {
  const [loaded, setLoaded] = useState<{ pdf: ReaderDocument; revision?: number; items: ReaderOutlineItem[] | null; error?: string }>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [drag, setDrag] = useState<{ id: string; revision: number }>()
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: OutlinePlacement }>()
  const revealed = useRef(false)
  const pendingReveal = useRef<string>()
  const pendingRevision = useRef<number>()
  const focusAfterReveal = useRef(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const editing = useOutlineEditing(outlineAccess, currentPage, t)
  const outline = loaded?.pdf === pdf ? loaded : undefined
  const allRows = useMemo(() => outlineRows(outline?.items ?? []), [outline?.items])
  const rows = useMemo(() => outlineRows(withNewBookmark(outline?.items ?? [], editing.editor), expanded), [outline?.items, editing.editor, expanded])
  const currentPath = useMemo(() => currentOutlineKey(outline?.items ?? [], currentPage, pdf?.numPages ?? 0), [outline?.items, currentPage, pdf?.numPages])
  const currentKey = allRows.find(row => row.path === currentPath)?.key
  const dropIndicator = useMemo(() => {
    if (!dropTarget) return
    let index = rows.findIndex(row => row.item.id === dropTarget.id)
    if (index < 0) return
    const depth = rows[index]!.depth
    // "After" a branch means after the whole branch, including visible children.
    if (dropTarget.placement === 'after') while (rows[index + 1] && rows[index + 1]!.depth > depth) index++
    return { key: rows[index]!.key, placement: dropTarget.placement }
  }, [rows, dropTarget])
  const { root, start, end, scrollToRow, totalHeight } = useVirtualRows(rows.length, rowHeight, active)

  useEffect(() => {
    setExpanded(new Set()); setLoaded(undefined); revealed.current = false
    pendingReveal.current = undefined; pendingRevision.current = undefined; focusAfterReveal.current = false
    setDrag(undefined); setDropTarget(undefined)
  }, [pdf])
  useEffect(() => {
    if (!active) { editing.closePopup(); setDrag(undefined); setDropTarget(undefined) }
  }, [active])
  useEffect(() => {
    if (!active || !pdf || loaded?.pdf === pdf && loaded.revision === outlineAccess?.revision) return
    let cancelled = false
    void pdf.getOutline().then(items => {
      if (!cancelled) setLoaded({ pdf, revision: outlineAccess?.revision, items })
    }).catch(error => {
      if (!cancelled) setLoaded({ pdf, revision: outlineAccess?.revision, items: null, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true }
  }, [active, pdf, loaded, outlineAccess?.revision])
  useEffect(() => {
    if (!active) { revealed.current = false; return }
    if (!outline?.items || revealed.current) return
    revealed.current = true
    if (!currentPath || !currentKey) return
    pendingReveal.current = currentKey
    const ancestors = new Set(outlineAncestorKeys(currentPath))
    setExpanded(previous => new Set([...previous, ...allRows.filter(row => ancestors.has(row.path)).map(row => row.key)]))
  }, [active, outline?.items, currentPath, currentKey, allRows])
  useEffect(() => {
    const key = pendingReveal.current
    if (!active || !key) return
    if (pendingRevision.current !== undefined && (outline?.revision ?? -1) < pendingRevision.current) return
    const index = rows.findIndex(row => row.key === key)
    if (index < 0) return
    scrollToRow(index, true)
    if (focusAfterReveal.current) root.current?.querySelectorAll<HTMLElement>('[data-outline-id]').forEach(row => {
      if (row.dataset.outlineId === key) { row.focus(); focusAfterReveal.current = false }
    })
    if (!focusAfterReveal.current) { pendingReveal.current = undefined; pendingRevision.current = undefined }
  }, [active, rows, scrollToRow, start, end, outline?.revision])

  const toggle = (key: string) => setExpanded(previous => {
    const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next
  })
  const reveal = (id: string, parentId?: string, revision = (outlineAccess?.revision ?? 0) + 1) => {
    const ancestors: string[] = []
    let ancestor = parentId ?? editing.locations.get(id)?.parentId
    while (ancestor) { ancestors.push(ancestor); ancestor = editing.locations.get(ancestor)?.parentId }
    setExpanded(previous => new Set([...previous, ...ancestors]))
    pendingReveal.current = id; focusAfterReveal.current = true
    pendingRevision.current = revision
  }
  const beginCreate = (parentId?: string, index?: number) => {
    editing.beginCreate(parentId, index)
    if (parentId) setExpanded(previous => new Set([...previous, parentId]))
  }
  useEffect(() => {
    if (editing.editor) { pendingReveal.current = editing.editor.id; pendingRevision.current = undefined; focusAfterReveal.current = false }
  }, [editing.editor?.id])

  const dragOver = (event: React.DragEvent, row: OutlineRow) => {
    if (!drag || !row.item.id || editing.busy || editing.editor || drag.revision !== outlineAccess?.revision) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientY - bounds.top) / bounds.height
    const placement: OutlinePlacement = fraction < .27 ? 'before' : fraction > .73 ? 'after' : 'inside'
    if (!outlineDrop(editing.locations, drag.id, row.item.id, placement)) {
      setDropTarget(undefined); event.dataTransfer.dropEffect = 'none'; return
    }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'
    setDropTarget(previous => previous && previous.id === row.item.id && previous.placement === placement ? previous : { id: row.item.id!, placement })
  }
  const stopDrag = () => { setDrag(undefined); setDropTarget(undefined) }

  return <div className="dsh-pdf-bookmark-panel">
    <div className="dsh-pdf-panel-heading dsh-pdf-bookmark-heading">
      <h3>{t('reader.sidebar.bookmarks')}</h3>
      {editing.editable && <button ref={addButton} type="button" disabled={editing.busy || !!editing.editor}
        title={t('reader.sidebar.addPdfBookmark')} aria-label={t('reader.sidebar.addPdfBookmark')} onClick={() => beginCreate()}>+</button>}
    </div>
    {outlineAccess?.readOnlyReason && <p className="dsh-pdf-sidebar-empty" role="status">{outlineAccess.readOnlyReason}</p>}
    {(editing.error && !editing.popup || editing.editor && editing.editor.revision !== outlineAccess?.revision) && <div className="dsh-pdf-outline-error" role="alert">
      <span>{editing.editor && editing.editor.revision !== outlineAccess?.revision ? t('reader.sidebar.outlineChanged') : editing.error}</span>
      <button type="button" aria-label={t('reader.dismiss')} onClick={editing.clearError}>×</button>
    </div>}
    {!pdf ? <p className="dsh-pdf-sidebar-empty">{t('reader.loading')}</p>
      : !outline ? <p className="dsh-pdf-sidebar-empty" role="status">{t('reader.sidebar.bookmarksLoading')}</p>
        : outline.error ? <div className="dsh-pdf-sidebar-empty" role="alert">{t('reader.sidebar.bookmarksError')}: {outline.error}
          <button type="button" onClick={() => setLoaded(undefined)}>{t('reader.sidebar.retryBookmarks')}</button></div>
          : <div ref={root} className="dsh-pdf-bookmark-scroll" role="tree" tabIndex={0} aria-label={t('reader.sidebar.bookmarks')}
            onDragOver={event => {
              if (!drag || !root.current) return
              const bounds = root.current.getBoundingClientRect()
              if (event.clientY < bounds.top + 32) root.current.scrollTop -= 12
              else if (event.clientY > bounds.bottom - 32) root.current.scrollTop += 12
            }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined) }}>
            {!rows.length && <p className="dsh-pdf-sidebar-empty">{t('reader.sidebar.bookmarksEmpty')}</p>}
            <div className="dsh-pdf-bookmark-virtual" style={{ height: totalHeight }}>
              {rows.slice(start, end).map((row, offset) => <OutlineEntry key={row.key} pdf={pdf} row={row}
                index={start + offset} expanded={expanded.has(row.key)} current={row.key === currentKey} toggle={toggle}
                editing={editing} revision={outlineAccess?.revision} dragging={!!drag && drag.id === row.item.id}
                dropPlacement={dropIndicator?.key === row.key ? dropIndicator?.placement : undefined}
                onMoved={reveal} onNavigateDestination={onNavigateDestination}
                onCancelName={() => {
                  const editor = editing.editor
                  editing.cancelEditor()
                  if (editor?.kind === 'rename') reveal(editor.id, undefined, outlineAccess?.revision)
                  else requestAnimationFrame(() => addButton.current?.focus())
                }}
                onDragStart={(event, id) => {
                  if (!outlineAccess || editing.busy || editing.editor) { event.preventDefault(); return }
                  editing.closePopup(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id)
                  const rowElement = event.currentTarget.closest<HTMLElement>('[data-outline-id]')
                  if (rowElement) {
                    const bounds = rowElement.getBoundingClientRect()
                    event.dataTransfer.setDragImage(rowElement,
                      Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
                      Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)))
                  }
                  setDrag({ id, revision: outlineAccess.revision })
                }} onDragEnd={stopDrag} onDragOver={dragOver}
                onDrop={(event, target) => {
                  event.preventDefault(); event.stopPropagation()
                  if (drag && dropTarget && dropTarget.id === target.item.id) {
                    const operation = outlineDrop(editing.locations, drag.id, dropTarget.id, dropTarget.placement)
                    void editing.drop(drag.id, dropTarget.id, dropTarget.placement, drag.revision).then(success => {
                      if (success) reveal(drag.id, operation?.parentId)
                    })
                  }
                  stopDrag()
                }} t={t} />)}
            </div>
          </div>}
    {active && editing.popup && outlineAccess && <OutlineActions key={`${editing.popup.id}:${editing.popup.kind}`} editing={editing}
      access={outlineAccess} currentPage={currentPage} pageCount={pdf?.numPages ?? 0} onCreate={beginCreate} onMoved={reveal} t={t} />}
  </div>
}
