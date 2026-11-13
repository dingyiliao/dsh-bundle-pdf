import React, { useLayoutEffect, useRef } from 'react'
import { readingViewportBounds } from '../rendering/pdf-viewport-geometry.js'

interface FloatingToolbarProps {
  viewport: HTMLElement | null
  getAnchor: () => DOMRect | null
  label: string
  children: React.ReactNode
  active?: boolean
  className?: string
}

/** Keep contextual actions near their PDF anchor without changing page layout. */
export function FloatingToolbar({ viewport, getAnchor, label, children, active = true, className }: FloatingToolbarProps) {
  const toolbar = useRef<HTMLDivElement>(null)
  const anchor = useRef(getAnchor)
  const refresh = useRef<(() => void) | undefined>()
  anchor.current = getAnchor
  useLayoutEffect(() => {
    const element = toolbar.current
    const parent = element?.closest<HTMLElement>('.dsh-pdf-reader')
    if (!element || !parent || !viewport) return
    let frame = 0
    const show = (visible: boolean) => {
      element.dataset.visible = String(visible)
      // A neighbouring comment card needs the committed action-bar bounds,
      // including changes that move it without resizing the PDF scrollport.
      viewport.dispatchEvent(new Event('pdfcontextchange'))
    }
    const update = () => {
      frame = 0
      const selection = anchor.current()
      const bounds = readingViewportBounds(viewport)
      const origin = parent.getBoundingClientRect()
      if (!active || !selection || bounds.width < 40 || selection.bottom <= bounds.top || selection.top >= bounds.bottom
        || selection.right <= bounds.left || selection.left >= bounds.right) {
        show(false)
        return
      }
      const inset = 8, gap = 7
      // Use the readable strip between floating rails, while keeping the full
      // scrollport available for large pages and PDF coordinate conversion.
      const safeTop = bounds.top + inset
      const availableHeight = Math.max(0, bounds.height - inset * 2)
      const hasCard = !!parent.querySelector('.dsh-pdf-page-comment-card')
      const heightBudget = hasCard ? Math.min(availableHeight, Math.max(46, Math.floor((availableHeight - 12) / 2))) : availableHeight
      const scrollTop = element.scrollTop
      element.style.maxWidth = `${Math.max(0, bounds.width - inset * 2)}px`
      // Read the full extent under the existing constraint. Temporarily
      // expanding a scrolled toolbar would clamp its saved scroll position.
      const naturalHeight = Math.max(element.offsetHeight, element.scrollHeight + element.offsetHeight - element.clientHeight)
      const constrained = naturalHeight > heightBudget
      element.dataset.heightConstrained = String(constrained)
      element.style.maxHeight = `${heightBudget}px`
      const width = element.offsetWidth, height = element.offsetHeight
      if (safeTop + height > bounds.bottom - inset) {
        show(false)
        return
      }
      const left = Math.max(bounds.left + inset, Math.min(bounds.right - width - inset, selection.left))
      // An unusually tall action bar shares the short column with its editor.
      // Dock it at the top so the remaining region stays contiguous and usable.
      let top = constrained && hasCard ? safeTop : selection.bottom + gap
      if (top + height > bounds.bottom - inset) top = selection.top - gap - height
      top = Math.max(safeTop, Math.min(bounds.bottom - height - inset, top))
      element.style.left = `${left - origin.left}px`
      element.style.top = `${top - origin.top}px`
      element.scrollTop = scrollTop
      show(true)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    refresh.current = schedule
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    observer.observe(element)
    viewport.addEventListener('scroll', schedule, { passive: true })
    viewport.addEventListener('pdfviewchange', schedule)
    viewport.addEventListener('pdflayoutchange', schedule)
    window.addEventListener('resize', schedule)
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('scroll', schedule)
      viewport.removeEventListener('pdfviewchange', schedule)
      viewport.removeEventListener('pdflayoutchange', schedule)
      window.removeEventListener('resize', schedule)
      refresh.current = undefined
    }
  }, [viewport, active])
  useLayoutEffect(() => { refresh.current?.() })
  return <div ref={toolbar} className={`dsh-pdf-toolbar dsh-pdf-context-toolbar dsh-pdf-glass${className ? ` ${className}` : ''}`} role="toolbar" aria-label={label}
    data-visible="false" aria-hidden={!active}
    onPointerDown={(event) => {
      // Pointer activation of an action must not collapse the native text range.
      // Inputs keep their normal focus and keyboard behaviour.
      if (event.button === 0 && event.target instanceof Element && event.target.closest('button')) event.preventDefault()
    }}>{children}</div>
}
