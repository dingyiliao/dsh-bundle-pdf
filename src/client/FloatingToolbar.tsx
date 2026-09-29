import React, { useLayoutEffect, useRef } from 'react'

interface FloatingToolbarProps {
  viewport: HTMLElement | null
  getAnchor: () => DOMRect | null
  label: string
  children: React.ReactNode
}

/** Docked tools live outside this viewport; contextual actions stay within the PDF column. */
export function visibleReadingBounds(viewport: HTMLElement): DOMRect {
  return viewport.getBoundingClientRect()
}

/** Keep contextual actions near their PDF anchor without changing page layout. */
export function FloatingToolbar({ viewport, getAnchor, label, children }: FloatingToolbarProps) {
  const toolbar = useRef<HTMLDivElement>(null)
  const anchor = useRef(getAnchor)
  const refresh = useRef<(() => void) | undefined>()
  anchor.current = getAnchor
  useLayoutEffect(() => {
    const element = toolbar.current
    const parent = element?.closest<HTMLElement>('.dsh-pdf-reader')
    if (!element || !parent || !viewport) return
    let frame = 0
    const update = () => {
      frame = 0
      const selection = anchor.current()
      const bounds = visibleReadingBounds(viewport)
      const origin = parent.getBoundingClientRect()
      if (!selection || bounds.width < 40 || selection.bottom <= bounds.top || selection.top >= bounds.bottom
        || selection.right <= bounds.left || selection.left >= bounds.right) {
        element.style.visibility = 'hidden'
        return
      }
      const inset = 8, gap = 7
      element.style.maxWidth = `${Math.max(0, bounds.width - inset * 2)}px`
      const width = element.offsetWidth, height = element.offsetHeight
      const left = Math.max(bounds.left + inset, Math.min(bounds.right - width - inset, selection.left))
      let top = selection.bottom + gap
      if (top + height > bounds.bottom - inset) top = selection.top - gap - height
      top = Math.max(bounds.top + inset, Math.min(bounds.bottom - height - inset, top))
      element.style.left = `${left - origin.left}px`
      element.style.top = `${top - origin.top}px`
      element.style.visibility = 'visible'
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    refresh.current = schedule
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    observer.observe(element)
    viewport.addEventListener('scroll', schedule, { passive: true })
    viewport.addEventListener('pdfviewchange', schedule)
    window.addEventListener('resize', schedule)
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('scroll', schedule)
      viewport.removeEventListener('pdfviewchange', schedule)
      window.removeEventListener('resize', schedule)
      refresh.current = undefined
    }
  }, [viewport])
  useLayoutEffect(() => { refresh.current?.() })
  return <div ref={toolbar} className="dsh-pdf-toolbar dsh-pdf-context-toolbar" role="toolbar" aria-label={label}
    onPointerDown={(event) => {
      // Pointer activation of an action must not collapse the native text range.
      // Inputs keep their normal focus and keyboard behaviour.
      if (event.button === 0 && event.target instanceof Element && event.target.closest('button')) event.preventDefault()
    }}>{children}</div>
}
