import React, { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './annotation-comment-card.css'

export interface AnnotationCommentCardProps {
  /** The scrollable PDF reading column, excluding the sidebar. */
  viewport: HTMLElement | null
  /** Current annotation geometry in window coordinates. */
  getAnchor(): DOMRect | null
  label: string
  children: ReactNode
  connectorColor?: string
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
export function AnnotationCommentCard({ viewport, getAnchor, label, children, connectorColor, onVisible }: AnnotationCommentCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const connectorRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const refreshRef = useRef<(() => void) | null>(null)
  const anchorRef = useRef(getAnchor)
  anchorRef.current = getAnchor
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible
  const markerId = `dsh-pdf-comment-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const readerRoot = viewport?.closest<HTMLElement>('.dsh-pdf-reader') ?? null

  useLayoutEffect(() => {
    const card = cardRef.current
    const connector = connectorRef.current
    const path = pathRef.current
    if (!viewport || !readerRoot || !card || !connector || !path) return
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
      connector.dataset.visible = 'false'
    }
    const clearMissingAnchor = () => {
      if (missingAnchorTimer !== null) clearTimeout(missingAnchorTimer)
      missingAnchorTimer = null
    }
    const update = () => {
      frame = 0
      const anchor = anchorRef.current()
      const bounds = viewport.getBoundingClientRect()
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
      const controls = readerRoot.querySelector<HTMLElement>('.dsh-pdf-floating-controls')
      const controlsBottom = controls?.getBoundingClientRect().bottom ?? bounds.top
      if (anchor.bottom <= controlsBottom) { hide(); return }
      const topEdge = Math.max(bounds.top + EDGE, rootBounds.top + EDGE, controlsBottom + EDGE)
      const bottomEdge = Math.min(bounds.bottom - EDGE, rootBounds.bottom - EDGE)
      const rightRoom = rightEdge - anchor.right - GAP
      const leftRoom = anchor.left - leftEdge - GAP
      const sideRoom = rightRoom >= MIN_SIDE_WIDTH ? rightRoom : leftRoom >= MIN_SIDE_WIDTH ? leftRoom : 0
      const width = Math.min(MAX_WIDTH, sideRoom || rightEdge - leftEdge)
      if (width < 80 || bottomEdge - topEdge < 60) { hide(); return }

      // Measure the real content after constraining it to this reader viewport.
      // No state update is needed on scroll or zoom; only the DOM position moves.
      card.style.width = `${width}px`
      card.style.maxHeight = `${bottomEdge - topEdge}px`
      const height = card.offsetHeight
      const belowRoom = bottomEdge - anchor.bottom - GAP
      const aboveRoom = anchor.top - topEdge - GAP
      const side = rightRoom >= MIN_SIDE_WIDTH ? 'right'
        : leftRoom >= MIN_SIDE_WIDTH ? 'left'
          : belowRoom >= height ? 'below'
            : aboveRoom >= height ? 'above'
              : rightRoom >= leftRoom ? 'right' : 'left'
      const left = side === 'right' ? clamp(anchor.right + GAP, leftEdge, rightEdge - width)
        : side === 'left' ? clamp(anchor.left - GAP - width, leftEdge, rightEdge - width)
          : clamp(anchor.left + anchor.width / 2 - width / 2, leftEdge, rightEdge - width)
      const top = side === 'below' ? clamp(anchor.bottom + GAP, topEdge, bottomEdge - height)
        : side === 'above' ? clamp(anchor.top - GAP - height, topEdge, bottomEdge - height)
          : clamp(anchor.top - 4, topEdge, bottomEdge - height)

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
      card.style.left = `${left - rootBounds.left}px`
      card.style.top = `${top - rootBounds.top}px`
      const wasVisible = card.dataset.visible === 'true'
      card.dataset.visible = 'true'
      card.setAttribute('aria-hidden', 'false')
      connector.setAttribute('viewBox', `0 0 ${rootBounds.width} ${rootBounds.height}`)
      path.setAttribute('d', d)
      connector.dataset.visible = 'true'
      if (!wasVisible) onVisibleRef.current?.()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    // React-driven geometry changes (notably zoom) update before paint; scroll
    // and ResizeObserver bursts still share one animation-frame measurement.
    refreshRef.current = update
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(viewport)
    observer?.observe(readerRoot)
    observer?.observe(card)
    viewport.addEventListener('scroll', schedule, { passive: true })
    viewport.addEventListener('pdfviewchange', schedule)
    viewport.addEventListener('pdflayoutchange', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      clearMissingAnchor()
      refreshRef.current = null
      observer?.disconnect()
      viewport.removeEventListener('scroll', schedule)
      viewport.removeEventListener('pdfviewchange', schedule)
      viewport.removeEventListener('pdflayoutchange', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [viewport, readerRoot])
  useLayoutEffect(() => { refreshRef.current?.() })

  if (!readerRoot) return null
  return createPortal(<>
    <style>{styles}</style>
    <svg ref={connectorRef} className="dsh-pdf-comment-connector" data-visible="false" aria-hidden="true"
      style={connectorColor ? { '--pdf-comment-connector-color': connectorColor } as React.CSSProperties : undefined}>
      <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5"
        orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 1 L 6 3.5 L 0 6 Z" fill="currentColor" /></marker></defs>
      <path ref={pathRef} markerEnd={`url(#${markerId})`} />
    </svg>
    <div ref={cardRef} className="dsh-pdf-page-comment-card" data-visible="false" aria-hidden="true"
      role="dialog" aria-label={label} aria-modal="false"
      onPointerDown={event => event.stopPropagation()}>{children}</div>
  </>, readerRoot)
}
