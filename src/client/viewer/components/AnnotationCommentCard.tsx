import React, { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { readingViewportBounds } from '../rendering/pdf-viewport-geometry.js'
import { MIN_NOTE_CARD_HEIGHT, MIN_NOTE_CARD_WIDTH, readNoteCardSize, saveNoteCardSize,
  type NoteCardSize } from '../model/note-card-size.js'

export interface AnnotationCommentCardProps {
  /** Full PDF scrollport; its measured padding reserves space for the floating rails. */
  viewport: HTMLElement | null
  /** Current annotation geometry in window coordinates. */
  getAnchor(): DOMRect | null
  /** Optional persisted top-left card position in window coordinates. */
  getPosition?(): DOMRect | null
  label: string
  children: ReactNode
  connectorColor?: string
  /** Notes use the same bounded floating-card placement, but never draw a connector. */
  connector?: boolean
  cardKind?: 'comment' | 'note'
  noteColor?: string
  sizeKey?: string
  resizeLabel?: string
  /** Persist a note anchor or comment-card placement after a drag. */
  onMove?(delta: { x: number; y: number }, position: { left: number; top: number }): boolean | Promise<boolean>
  /** Fired once when a previously hidden card becomes visible. */
  onVisible?(): void
}

const EDGE = 12
const GAP = 12
const MAX_WIDTH = 300
const MIN_SIDE_WIDTH = 220

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)))
}

/** Keep one comment attached to its PDF mark without making the page wider. */
export function AnnotationCommentCard({ viewport, getAnchor, getPosition, label, children, connectorColor,
  connector: connectorEnabled = true, cardKind = 'comment', noteColor, sizeKey, resizeLabel, onMove, onVisible }: AnnotationCommentCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const connectorRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const refreshRef = useRef<(() => void) | null>(null)
  const scheduleRef = useRef<(() => void) | null>(null)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; offsetX: number; offsetY: number } | null>(null)
  const sizeRef = useRef<NoteCardSize | null>(null)
  const resizeRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null)
  const anchorRef = useRef(getAnchor)
  anchorRef.current = getAnchor
  const positionRef = useRef(getPosition)
  positionRef.current = getPosition
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove
  const movingRef = useRef(false)
  const markerId = `dsh-pdf-comment-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const readerRoot = viewport?.closest<HTMLElement>('.dsh-pdf-reader') ?? null

  // A reused floating-card instance must not carry a note drag into a mark's
  // comment placement (or vice versa). They have different anchors and owners.
  useLayoutEffect(() => { dragOffsetRef.current = { x: 0, y: 0 } }, [cardKind])
  useLayoutEffect(() => { sizeRef.current = readNoteCardSize(sizeKey); refreshRef.current?.() }, [sizeKey])

  useLayoutEffect(() => {
    const card = cardRef.current
    const connector = connectorRef.current
    const path = pathRef.current
    if (!viewport || !readerRoot || !card || (connectorEnabled && (!connector || !path))) return
    let frame = 0
    let missingAnchorTimer: ReturnType<typeof setTimeout> | null = null
    const hide = () => {
      if (card.contains(document.activeElement)) {
        viewport.focus({ preventScroll: true })
        // A non-focusable embedder viewport must not retain focus inside an
        // aria-hidden dialog after its annotation scrolls out of sight.
        if (card.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }
      card.dataset.visible = 'false'
      card.setAttribute('aria-hidden', 'true')
      if (connector) connector.dataset.visible = 'false'
    }
    const clearMissingAnchor = () => {
      if (missingAnchorTimer !== null) clearTimeout(missingAnchorTimer)
      missingAnchorTimer = null
    }
    const update = () => {
      frame = 0
      const anchor = anchorRef.current()
      const bounds = readingViewportBounds(viewport)
      const rootBounds = readerRoot.getBoundingClientRect()
      if (!anchor) {
        // Zoom briefly unbinds and rebinds a PageView. Keep the old card in
        // place through that short gap rather than flashing it off and on.
        if (card.dataset.visible === 'true' && missingAnchorTimer === null) {
          missingAnchorTimer = setTimeout(() => {
            missingAnchorTimer = null
            if (!anchorRef.current()) hide()
            else schedule()
          }, 120)
        }
        return
      }
      clearMissingAnchor()
      if (![anchor.left, anchor.top, anchor.right, anchor.bottom, anchor.width, anchor.height].every(Number.isFinite)
        || anchor.bottom <= bounds.top || anchor.top >= bounds.bottom
        || anchor.right <= bounds.left || anchor.left >= bounds.right) { hide(); return }

      const leftEdge = Math.max(bounds.left + EDGE, rootBounds.left + EDGE)
      const rightEdge = Math.min(bounds.right - EDGE, rootBounds.right - EDGE)
      const topEdge = Math.max(bounds.top + EDGE, rootBounds.top + EDGE)
      const bottomEdge = Math.min(bounds.bottom - EDGE, rootBounds.bottom - EDGE)
      const rightRoom = rightEdge - anchor.right - GAP
      const leftRoom = anchor.left - leftEdge - GAP
      const sideRoom = rightRoom >= MIN_SIDE_WIDTH ? rightRoom : leftRoom >= MIN_SIDE_WIDTH ? leftRoom : 0
      const availableWidth = rightEdge - leftEdge
      const width = Math.min(cardKind === 'note' ? sizeRef.current?.width ?? MAX_WIDTH : MAX_WIDTH,
        cardKind === 'note' ? availableWidth : sideRoom || availableWidth)
      if (width < 80 || bottomEdge - topEdge < 60) { hide(); return }

      // Measure the real content after constraining it to this reader viewport.
      // No state update is needed on scroll or zoom; only the DOM position moves.
      const scrollTop = card.scrollTop
      card.style.width = `${width}px`
      // Expanding max-height just to measure would clamp a scrolled editor
      // back toward its beginning. Its scroll extent exposes the full content
      // without changing the current height or the user's scroll position.
      const naturalHeight = Math.max(card.offsetHeight, card.scrollHeight + card.offsetHeight - card.clientHeight)
      const preferredHeight = cardKind === 'note' && sizeRef.current ? sizeRef.current.height : naturalHeight
      let maximumHeight = bottomEdge - topEdge
      let height = Math.min(maximumHeight, Math.max(cardKind === 'note' ? MIN_NOTE_CARD_HEIGHT : 0, preferredHeight))
      const belowRoom = bottomEdge - anchor.bottom - GAP
      const aboveRoom = anchor.top - topEdge - GAP
      let side = rightRoom >= MIN_SIDE_WIDTH ? 'right'
        : leftRoom >= MIN_SIDE_WIDTH ? 'left'
          : belowRoom >= height ? 'below'
            : aboveRoom >= height ? 'above'
              : rightRoom >= leftRoom ? 'right' : 'left'
      let left = side === 'right' ? clamp(anchor.right + GAP, leftEdge, rightEdge - width)
        : side === 'left' ? clamp(anchor.left - GAP - width, leftEdge, rightEdge - width)
          : clamp(anchor.left + anchor.width / 2 - width / 2, leftEdge, rightEdge - width)
      let top = side === 'below' ? clamp(anchor.bottom + GAP, topEdge, bottomEdge - height)
        : side === 'above' ? clamp(anchor.top - GAP - height, topEdge, bottomEdge - height)
          : clamp(anchor.top - 4, topEdge, bottomEdge - height)

      const savedPosition = positionRef.current?.()
      if (savedPosition && Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.top)) {
        left = clamp(savedPosition.left, leftEdge, rightEdge - width)
        top = clamp(savedPosition.top, topEdge, bottomEdge - height)
        side = left >= anchor.right + 2 ? 'right' : left + width <= anchor.left - 2 ? 'left'
          : top >= anchor.bottom + 2 ? 'below' : top + height <= anchor.top - 2 ? 'above' : side
      }

      // The mark action bar and the comment card can be visible together. On a
      // narrow PDF column their preferred placements may overlap; move the
      // card to the nearest free side before drawing its connector.
      const toolbar = readerRoot.querySelector<HTMLElement>('.dsh-pdf-context-toolbar[data-visible="true"]')
      const toolbarBounds = toolbar?.getBoundingClientRect()
      if (toolbarBounds && left < toolbarBounds.right + GAP && left + width > toolbarBounds.left - GAP
        && top < toolbarBounds.bottom + GAP && top + height > toolbarBounds.top - GAP) {
        if (toolbarBounds.bottom + GAP + height <= bottomEdge) top = toolbarBounds.bottom + GAP
        else if (toolbarBounds.top - GAP - height >= topEdge) top = toolbarBounds.top - GAP - height
        else if (toolbarBounds.left - GAP - width >= leftEdge) left = toolbarBounds.left - GAP - width
        else if (toolbarBounds.right + GAP + width <= rightEdge) left = toolbarBounds.right + GAP
        else {
          // A short, narrow column may have no room for the full editor on
          // either side of the actions. Keep both usable by scrolling the
          // card within the larger free vertical region instead of covering it.
          const below = bottomEdge - toolbarBounds.bottom - GAP
          const above = toolbarBounds.top - GAP - topEdge
          const availableHeight = Math.max(below, above)
          if (availableHeight >= 60) {
            maximumHeight = availableHeight
            height = Math.min(height, maximumHeight)
            top = below >= above ? toolbarBounds.bottom + GAP : toolbarBounds.top - GAP - height
          }
        }
      }

      card.style.maxHeight = `${maximumHeight}px`
      card.style.minHeight = cardKind === 'note' ? `${Math.min(MIN_NOTE_CARD_HEIGHT, maximumHeight)}px` : ''
      card.style.height = cardKind === 'note' && sizeRef.current ? `${Math.min(sizeRef.current.height, maximumHeight)}px` : ''
      height = card.offsetHeight

      // Keep a user-placed card at the same offset from its mark as the PDF
      // scrolls or zooms. Clamp the card to the reader without snapping it back.
      const baseLeft = left, baseTop = top
      left = clamp(left + dragOffsetRef.current.x, leftEdge, rightEdge - width)
      top = clamp(top + dragOffsetRef.current.y, topEdge, bottomEdge - height)
      dragOffsetRef.current = { x: left - baseLeft, y: top - baseTop }

      card.style.left = `${left - rootBounds.left}px`
      card.style.top = `${top - rootBounds.top}px`
      card.scrollTop = scrollTop
      const wasVisible = card.dataset.visible === 'true'
      card.dataset.visible = 'true'
      card.setAttribute('aria-hidden', 'false')
      if (connectorEnabled && connector && path) {
        const centerX = anchor.left + anchor.width / 2
        const centerY = anchor.top + anchor.height / 2
        // If a narrow viewport forced the card over the mark, connect along the
        // actual free axis rather than drawing an arrow through the card itself.
        const edge = left >= anchor.right + 2 ? 'right'
          : left + width <= anchor.left - 2 ? 'left'
            : top >= anchor.bottom + 2 ? 'below'
              : top + height <= anchor.top - 2 ? 'above'
                : side
        let startX: number, startY: number, endX: number, endY: number
        if (edge === 'right' || edge === 'left') {
          startX = clamp(edge === 'right' ? anchor.right : anchor.left, bounds.left, bounds.right)
          startY = clamp(centerY, bounds.top, bounds.bottom)
          endX = edge === 'right' ? left : left + width
          endY = clamp(startY, top + Math.min(20, height / 2), top + Math.max(height - 20, height / 2))
        } else {
          startX = clamp(centerX, bounds.left, bounds.right)
          startY = clamp(edge === 'below' ? anchor.bottom : anchor.top, bounds.top, bounds.bottom)
          endX = clamp(startX, left + Math.min(20, width / 2), left + Math.max(width - 20, width / 2))
          endY = edge === 'below' ? top : top + height
        }
        const x1 = startX - rootBounds.left, y1 = startY - rootBounds.top
        const x2 = endX - rootBounds.left, y2 = endY - rootBounds.top
        const horizontal = edge === 'right' || edge === 'left'
        const curve = horizontal ? clamp(Math.abs(x2 - x1) * .42, 12, 80) : clamp(Math.abs(y2 - y1) * .42, 12, 80)
        const direction = horizontal ? Math.sign(x2 - x1) || 1 : Math.sign(y2 - y1) || 1
        const d = horizontal
          ? `M ${x1} ${y1} C ${x1 + direction * curve} ${y1}, ${x2 - direction * curve} ${y2}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${y1 + direction * curve}, ${x2} ${y2 - direction * curve}, ${x2} ${y2}`
        connector.setAttribute('viewBox', `0 0 ${rootBounds.width} ${rootBounds.height}`)
        path.setAttribute('d', d)
        connector.dataset.visible = 'true'
      }
      if (!wasVisible) onVisibleRef.current?.()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const onWindowScroll = (event: Event) => {
      // Scrolling the card or its textarea cannot change the PDF anchor.
      // Repositioning in response would feed editor scroll back into layout.
      if (event.composedPath().includes(card)) return
      schedule()
    }
    // React-driven geometry changes (notably zoom) update before paint; scroll
    // and ResizeObserver bursts still share one animation-frame measurement.
    refreshRef.current = update
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    scheduleRef.current = schedule
    observer?.observe(viewport)
    observer?.observe(readerRoot)
    observer?.observe(card)
    viewport.addEventListener('scroll', schedule, { passive: true })
    viewport.addEventListener('pdfviewchange', schedule)
    viewport.addEventListener('pdflayoutchange', schedule)
    viewport.addEventListener('pdfcontextchange', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', onWindowScroll, true)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      clearMissingAnchor()
      refreshRef.current = null
      scheduleRef.current = null
      observer?.disconnect()
      viewport.removeEventListener('scroll', schedule)
      viewport.removeEventListener('pdfviewchange', schedule)
      viewport.removeEventListener('pdflayoutchange', schedule)
      viewport.removeEventListener('pdfcontextchange', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', onWindowScroll, true)
    }
  }, [viewport, readerRoot, connectorEnabled, cardKind])
  useLayoutEffect(() => { refreshRef.current?.() })

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (movingRef.current || event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return
    if (cardKind === 'note' && event.target.closest('[data-note-card-resize-handle]')) {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      resizeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        width: bounds.width, height: bounds.height }
      event.currentTarget.dataset.resizing = 'true'
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Embedded test hosts may not support capture. */ }
      return
    }
    const handle = event.target.closest('[data-comment-card-drag-handle]')
    if (!handle || event.target.closest('button:not([data-comment-card-drag-handle])')) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top,
      offsetX: dragOffsetRef.current.x, offsetY: dragOffsetRef.current.y }
    event.currentTarget.dataset.dragging = 'true'
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Pointer capture may be unavailable in embedded test hosts. */ }
    scheduleRef.current?.()
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (resize?.pointerId === event.pointerId) {
      const bounds = viewport && readingViewportBounds(viewport)
      const card = cardRef.current?.getBoundingClientRect()
      const maxWidth = bounds && card ? Math.max(MIN_NOTE_CARD_WIDTH, bounds.right - card.left - EDGE) : Infinity
      const maxHeight = bounds && card ? Math.max(MIN_NOTE_CARD_HEIGHT, bounds.bottom - card.top - EDGE) : Infinity
      sizeRef.current = { width: clamp(resize.width + event.clientX - resize.x, MIN_NOTE_CARD_WIDTH, maxWidth),
        height: clamp(resize.height + event.clientY - resize.y, MIN_NOTE_CARD_HEIGHT, maxHeight) }
      refreshRef.current?.()
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragOffsetRef.current = { x: drag.offsetX + event.clientX - drag.x, y: drag.offsetY + event.clientY - drag.y }
    scheduleRef.current?.()
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === event.pointerId) {
      resizeRef.current = null
      delete event.currentTarget.dataset.resizing
      if (sizeKey && sizeRef.current) saveNoteCardSize(sizeKey, sizeRef.current)
      return
    }
    const drag = dragRef.current
    if (drag?.pointerId !== event.pointerId) return
    dragRef.current = null
    delete event.currentTarget.dataset.dragging
    const move = onMoveRef.current
    if (!move) return
    const delta = { x: dragOffsetRef.current.x - drag.offsetX, y: dragOffsetRef.current.y - drag.offsetY }
    if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5) return
    const card = event.currentTarget
    movingRef.current = true
    card.dataset.moving = 'true'
    void (async () => {
      let committed = false
      try { committed = await move(delta, { left: drag.left + delta.x, top: drag.top + delta.y }) }
      catch { /* The owner reports persistence failures. */ }
      // Let the updated PDF rect become the new anchor before removing the
      // temporary drag offset; this keeps the card visually attached in flight.
      if (committed) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      dragOffsetRef.current = { x: drag.offsetX, y: drag.offsetY }
      movingRef.current = false
      if (card.isConnected) delete card.dataset.moving
      scheduleRef.current?.()
    })()
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (cardKind === 'note' && event.target instanceof Element && event.target.closest('[data-note-card-resize-handle]')) {
      const step = event.shiftKey ? 10 : 2
      const delta = event.key === 'ArrowLeft' ? [-step, 0] : event.key === 'ArrowRight' ? [step, 0]
        : event.key === 'ArrowUp' ? [0, -step] : event.key === 'ArrowDown' ? [0, step] : null
      if (!delta) return
      event.preventDefault()
      event.stopPropagation()
      const card = cardRef.current?.getBoundingClientRect()
      const bounds = viewport && readingViewportBounds(viewport)
      if (!card || !bounds) return
      sizeRef.current = { width: clamp((sizeRef.current?.width ?? card.width) + delta[0]!, MIN_NOTE_CARD_WIDTH,
        Math.max(MIN_NOTE_CARD_WIDTH, bounds.right - card.left - EDGE)),
      height: clamp((sizeRef.current?.height ?? card.height) + delta[1]!, MIN_NOTE_CARD_HEIGHT,
        Math.max(MIN_NOTE_CARD_HEIGHT, bounds.bottom - card.top - EDGE)) }
      refreshRef.current?.()
      if (sizeKey) saveNoteCardSize(sizeKey, sizeRef.current)
      return
    }
    if (!(event.target instanceof Element) || !event.target.closest('[data-comment-card-drag-handle]')) return
    const distance = event.shiftKey ? 10 : 2
    const delta = event.key === 'ArrowLeft' ? [-distance, 0]
      : event.key === 'ArrowRight' ? [distance, 0]
        : event.key === 'ArrowUp' ? [0, -distance]
          : event.key === 'ArrowDown' ? [0, distance] : null
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    if (movingRef.current) return
    const base = { ...dragOffsetRef.current }
    const bounds = cardRef.current?.getBoundingClientRect()
    if (!bounds) return
    dragOffsetRef.current = { x: base.x + delta[0]!, y: base.y + delta[1]! }
    refreshRef.current?.()
    const move = onMoveRef.current
    if (move) {
      const card = cardRef.current
      if (!card) return
      movingRef.current = true
      card.dataset.moving = 'true'
      void (async () => {
        let committed = false
        try { committed = await move({ x: delta[0]!, y: delta[1]! },
          { left: bounds.left + delta[0]!, top: bounds.top + delta[1]! }) }
        catch { /* The owner reports persistence failures. */ }
        if (committed) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        dragOffsetRef.current = base
        movingRef.current = false
        if (card.isConnected) delete card.dataset.moving
        scheduleRef.current?.()
      })()
    }
  }

  if (!readerRoot) return null
  return createPortal(<>
    {connectorEnabled && <svg ref={connectorRef} className="dsh-pdf-comment-connector" data-visible="false" aria-hidden="true"
      style={connectorColor ? { '--pdf-comment-connector-color': connectorColor } as React.CSSProperties : undefined}>
      <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5"
        orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 1 L 6 3.5 L 0 6 Z" fill="currentColor" /></marker></defs>
      <path ref={pathRef} markerEnd={`url(#${markerId})`} />
    </svg>}
    <div ref={cardRef} className={`dsh-pdf-page-comment-card${cardKind === 'note' ? '' : ' dsh-pdf-glass'}`} data-visible="false" aria-hidden="true"
      data-card-kind={cardKind}
      style={cardKind === 'note' && noteColor ? { '--pdf-note-tint': noteColor } as CSSProperties : undefined}
      role="dialog" aria-label={label} aria-modal="false"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={onKeyDown}>{children}
      {cardKind === 'note' && <button type="button" className="dsh-pdf-note-resize" data-note-card-resize-handle=""
        aria-label={resizeLabel ?? label} title={resizeLabel ?? label}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" aria-hidden="true"><path d="m7 13 6-6M11 13l2-2" /></svg>
      </button>}</div>
  </>, readerRoot)
}
