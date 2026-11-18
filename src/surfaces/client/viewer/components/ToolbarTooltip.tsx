import React, { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipState {
  anchor: HTMLElement
  label: string
}

/** One tooltip for the whole toolbar keeps adjacent icon hovers quick and avoids clipped bubbles. */
export function ToolbarTooltip({ children }: { children: React.ReactElement<React.HTMLAttributes<HTMLDivElement>> }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const active = useRef<HTMLElement | null>(null)
  const activePosition = useRef<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visible = useRef(false)
  const lastVisible = useRef(0)
  const keyboardMode = useRef(false)

  const cancelTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const hide = useCallback(() => {
    if (active.current === null && timer.current === null && !visible.current) return
    cancelTimer()
    active.current = null
    activePosition.current = null
    if (visible.current) lastVisible.current = performance.now()
    visible.current = false
    setTooltip(null)
  }, [cancelTimer])
  const show = (anchor: HTMLElement, delay: number) => {
    if (active.current === anchor) return
    const label = anchor.dataset.tooltip
    cancelTimer()
    if (visible.current) lastVisible.current = performance.now()
    visible.current = false
    setTooltip(null)
    active.current = anchor
    const position = anchor.getBoundingClientRect()
    activePosition.current = { x: position.x, y: position.y }
    if (!label) return
    const reveal = () => {
      timer.current = null
      if (active.current !== anchor || !anchor.isConnected) return
      visible.current = true
      setTooltip({ anchor, label })
    }
    if (delay === 0) reveal()
    else timer.current = setTimeout(reveal, delay)
  }
  const hovered = (event: React.PointerEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null
    if (anchor && event.currentTarget.contains(anchor)) {
      const immediate = visible.current || performance.now() - lastVisible.current < 600
      show(anchor, immediate ? 0 : 450)
    } else if (active.current) hide()
  }
  const focused = (event: React.FocusEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-tooltip]') : null
    if (!anchor || !event.currentTarget.contains(anchor)) return
    // Tab is observed before focus moves. Chromium may apply :focus-visible
    // only after focus capture, so use that keyboard signal as well.
    queueMicrotask(() => {
      if (document.activeElement === anchor && anchor.isConnected
        && (keyboardMode.current || anchor.matches(':focus-visible'))) show(anchor, 0)
    })
  }

  useLayoutEffect(() => {
    const element = bubble.current
    if (!element || !tooltip) return
    const rect = tooltip.anchor.getBoundingClientRect()
    const margin = 12
    const gap = 8
    const left = Math.max(margin, Math.min(rect.left + (rect.width - element.offsetWidth) / 2,
      window.innerWidth - margin - element.offsetWidth))
    const below = rect.bottom + gap
    const top = below + element.offsetHeight <= window.innerHeight - margin
      ? below : Math.max(margin, rect.top - gap - element.offsetHeight)
    element.style.left = `${left}px`
    element.style.top = `${top}px`
    element.style.visibility = 'visible'
  }, [tooltip])
  useEffect(() => {
    window.addEventListener('resize', hide)
    const onScroll = () => {
      const anchor = active.current
      if (!anchor) return
      // Focusing a toolbar control can itself scroll a container. Keep a
      // keyboard tooltip anchored instead of immediately dismissing it.
      if (document.activeElement === anchor && anchor.isConnected
        && (keyboardMode.current || anchor.matches(':focus-visible'))) {
        setTooltip({ anchor, label: anchor.dataset.tooltip ?? '' })
        return
      }
      // The page and status popover scroll independently of the fixed toolbar.
      // Keep a pointer tooltip unless its actual anchor has moved on screen.
      if (anchor.isConnected && activePosition.current) {
        const position = anchor.getBoundingClientRect()
        if (Math.abs(position.x - activePosition.current.x) < 1
          && Math.abs(position.y - activePosition.current.y) < 1) return
      }
      hide()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', onScroll, true)
      cancelTimer()
    }
  }, [cancelTimer, hide])

  return <>
    {cloneElement(children, {
      onPointerOver: event => { children.props.onPointerOver?.(event); hovered(event) },
      onPointerLeave: event => { children.props.onPointerLeave?.(event); hide() },
      onPointerDownCapture: event => { children.props.onPointerDownCapture?.(event); keyboardMode.current = false; hide() },
      onFocusCapture: event => { children.props.onFocusCapture?.(event); focused(event) },
      onBlurCapture: event => {
        children.props.onBlurCapture?.(event)
        const previous = event.target
        queueMicrotask(() => { if (active.current === previous) hide() })
      },
      onKeyDownCapture: event => {
        children.props.onKeyDownCapture?.(event)
        if (event.key === 'Tab') keyboardMode.current = true
        if (event.key === 'Escape') { keyboardMode.current = false; hide() }
      },
    })}
    {tooltip && createPortal(<span ref={bubble} className="dsh-pdf-toolbar-tooltip" role="tooltip"
      style={{ visibility: 'hidden' }}>{tooltip.label}</span>, document.body)}
  </>
}
