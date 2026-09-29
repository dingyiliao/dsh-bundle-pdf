import React, { useId, useLayoutEffect, useRef } from 'react'

type Axis = 'vertical' | 'horizontal'
interface AxisGeometry {
  overflow: boolean
  maximum: number
  viewport: number
  length: number
  thumb: number
  travel: number
}
interface Drag {
  axis: Axis
  pointerId: number
  grip: number
  track: HTMLDivElement
}
export interface OverlayScrollbarsProps {
  target: HTMLElement | null
  verticalLabel?: string
  horizontalLabel?: string
}

const thickness = 12
const inset = 2
const hideDelay = 1100
const emptyGeometry = (): AxisGeometry => ({ overflow: false, maximum: 0, viewport: 0, length: 0, thumb: 0, travel: 0 })
const clamp = (value: number, maximum: number): number => Math.max(0, Math.min(maximum, value))
const px = (value: number): string => `${Math.round(value * 2) / 2}px`
function style(element: HTMLElement, name: 'left' | 'top' | 'width' | 'height' | 'transform', value: string) {
  if (element.style[name] !== value) element.style[name] = value
}
function attribute(element: HTMLElement, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

/** Overlay controls follow the real scroll viewport without reserving a gutter. */
export function OverlayScrollbars({ target, verticalLabel = 'Vertical document scrollbar',
  horizontalLabel = 'Horizontal document scrollbar' }: OverlayScrollbarsProps) {
  const generatedId = `dsh-pdf-scroll-${useId().replaceAll(':', '')}`
  const overlay = useRef<HTMLDivElement>(null)
  const vertical = useRef<HTMLDivElement>(null)
  const horizontal = useRef<HTMLDivElement>(null)
  const verticalThumb = useRef<HTMLDivElement>(null)
  const horizontalThumb = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = overlay.current
    const tracks = { vertical: vertical.current, horizontal: horizontal.current }
    const thumbs = { vertical: verticalThumb.current, horizontal: horizontalThumb.current }
    if (!root || !tracks.vertical || !tracks.horizontal || !thumbs.vertical || !thumbs.horizontal) return
    if (!target) {
      tracks.vertical.hidden = true
      tracks.horizontal.hidden = true
      root.classList.remove('is-visible', 'is-dragging')
      return
    }
    const controls = target.id || generatedId
    const assignedId = !target.id
    if (assignedId) target.id = controls
    const parent = root.offsetParent as HTMLElement | null ?? target.parentElement
    const geometry: Record<Axis, AxisGeometry> = { vertical: emptyGeometry(), horizontal: emptyGeometry() }
    const hovered = new Set<Axis>()
    const observedChildren = new Set<Element>()
    let focused = false
    let drag: Drag | undefined
    let frame = 0
    let layoutDirty = true
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    let rtl = false

    const clearHide = () => { if (hideTimer !== undefined) clearTimeout(hideTimer); hideTimer = undefined }
    const armHide = () => {
      clearHide()
      if (hovered.size || focused || drag) return
      hideTimer = setTimeout(() => {
        hideTimer = undefined
        if (!hovered.size && !focused && !drag) root.classList.remove('is-visible')
      }, hideDelay)
    }
    const reveal = () => { root.classList.add('is-visible'); armHide() }
    const position = (axis: Axis): number => clamp(axis === 'vertical' ? target.scrollTop
      : rtl ? geometry.horizontal.maximum + target.scrollLeft : target.scrollLeft, geometry[axis].maximum)
    const seek = (axis: Axis, value: number) => {
      const next = clamp(value, geometry[axis].maximum)
      if (axis === 'vertical') target.scrollTop = next
      else target.scrollLeft = rtl ? next - geometry.horizontal.maximum : next
      reveal()
      schedule()
    }

    const measure = () => {
      layoutDirty = false
      const bounds = target.getBoundingClientRect()
      const outer = parent?.getBoundingClientRect()
      const width = target.clientWidth, height = target.clientHeight
      style(root, 'left', px(bounds.left - (outer?.left ?? 0) - (parent?.clientLeft ?? 0) + (parent?.scrollLeft ?? 0) + target.clientLeft))
      style(root, 'top', px(bounds.top - (outer?.top ?? 0) - (parent?.clientTop ?? 0) + (parent?.scrollTop ?? 0) + target.clientTop))
      style(root, 'width', px(width)); style(root, 'height', px(height))
      rtl = getComputedStyle(target).direction === 'rtl'
      const hasVertical = target.scrollHeight - height > 1 && height > 0 && width > 0
      const hasHorizontal = target.scrollWidth - width > 1 && width > 0 && height > 0
      for (const axis of ['vertical', 'horizontal'] as const) {
        const track = tracks[axis]!, thumb = thumbs[axis]!
        const view = axis === 'vertical' ? height : width
        const extent = axis === 'vertical' ? target.scrollHeight : target.scrollWidth
        const overflow = axis === 'vertical' ? hasVertical : hasHorizontal
        const opposite = axis === 'vertical' ? hasHorizontal : hasVertical
        const length = Math.max(0, view - inset * 2 - (opposite ? thickness + inset : 0))
        const thumbLength = Math.min(length, Math.max(Math.min(28, length / 2), length * view / Math.max(view, extent)))
        geometry[axis] = { overflow, maximum: Math.max(0, extent - view), viewport: view,
          length, thumb: thumbLength, travel: Math.max(0, length - thumbLength) }
        track.hidden = !overflow
        track.tabIndex = overflow ? 0 : -1
        attribute(track, 'aria-hidden', String(!overflow))
        attribute(track, 'aria-controls', controls)
        attribute(track, 'aria-valuemax', String(Math.round(geometry[axis].maximum)))
        if (!overflow && document.activeElement === track) target.focus({ preventScroll: true })
        if (axis === 'vertical') {
          style(track, 'left', px(Math.max(0, width - thickness - inset))); style(track, 'top', px(inset))
          style(track, 'width', px(thickness)); style(track, 'height', px(length)); style(thumb, 'height', px(thumbLength))
        } else {
          style(track, 'left', px(inset)); style(track, 'top', px(Math.max(0, height - thickness - inset)))
          style(track, 'width', px(length)); style(track, 'height', px(thickness)); style(thumb, 'width', px(thumbLength))
        }
      }
      if (drag && !geometry[drag.axis].overflow) endDrag()
    }
    const update = () => {
      frame = 0
      if (layoutDirty) measure()
      for (const axis of ['vertical', 'horizontal'] as const) {
        const current = geometry[axis]
        if (!current.overflow) continue
        const value = position(axis)
        const offset = current.maximum ? value / current.maximum * current.travel : 0
        style(thumbs[axis]!, 'transform', axis === 'vertical' ? `translateY(${px(offset)})` : `translateX(${px(offset)})`)
        attribute(tracks[axis]!, 'aria-valuenow', String(Math.round(value)))
        attribute(tracks[axis]!, 'aria-valuetext', `${Math.round(current.maximum ? value / current.maximum * 100 : 0)}%`)
      }
    }
    function schedule(layout = false) {
      if (layout) layoutDirty = true
      if (!frame) frame = requestAnimationFrame(update)
    }
    const onScroll = () => { reveal(); schedule() }
    const onResize = () => { schedule(true) }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize)
    const observeChildren = () => {
      const next = new Set(target.children)
      for (const child of observedChildren) if (!next.has(child)) { resize?.unobserve(child); observedChildren.delete(child) }
      for (const child of next) if (!observedChildren.has(child)) { resize?.observe(child); observedChildren.add(child) }
    }
    resize?.observe(target)
    if (parent) resize?.observe(parent)
    observeChildren()
    const mutations = new MutationObserver((records) => {
      if (records.some(record => record.type === 'childList' && record.target === target)) observeChildren()
      schedule(true)
    })
    mutations.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'dir'] })
    // Sidebar panels can move the viewport even when its dimensions remain unchanged.
    const siblings = parent ? new MutationObserver(onResize) : undefined
    if (parent) siblings?.observe(parent, { childList: true, attributes: true, attributeFilter: ['style', 'class', 'dir'] })

    const moveDrag = (coordinate: number) => {
      if (!drag) return
      if (layoutDirty) measure()
      if (!drag) return
      const current = geometry[drag.axis]
      const bounds = drag.track.getBoundingClientRect()
      const start = drag.axis === 'vertical' ? bounds.top : bounds.left
      seek(drag.axis, current.travel ? (coordinate - start - drag.grip) / current.travel * current.maximum : 0)
    }
    const endDrag = () => {
      const previous = drag
      drag = undefined
      root.classList.remove('is-dragging')
      if (previous) {
        try { if (previous.track.hasPointerCapture(previous.pointerId)) previous.track.releasePointerCapture(previous.pointerId) } catch { /* The pointer may already have ended. */ }
      }
      for (const axis of ['vertical', 'horizontal'] as const) {
        if (tracks[axis]!.matches(':hover')) hovered.add(axis)
        else hovered.delete(axis)
      }
      armHide()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return
      event.preventDefault()
      moveDrag(drag.axis === 'vertical' ? event.clientY : event.clientX)
    }
    const onPointerEnd = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) endDrag() }
    const cleanupTracks: (() => void)[] = []
    for (const axis of ['vertical', 'horizontal'] as const) {
      const track = tracks[axis]!, thumb = thumbs[axis]!
      const onEnter = () => { hovered.add(axis); reveal() }
      const onLeave = () => { hovered.delete(axis); armHide() }
      const onDown = (event: PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary) return
        if (layoutDirty) measure()
        if (!geometry[axis].overflow) return
        event.preventDefault()
        endDrag()
        // Pointer scrolling focuses the reading area; Tab still focuses the accessible controls.
        target.focus({ preventScroll: true })
        const coordinate = axis === 'vertical' ? event.clientY : event.clientX
        const bounds = thumb.getBoundingClientRect()
        const onThumb = event.target instanceof Node && thumb.contains(event.target)
        const grip = onThumb ? coordinate - (axis === 'vertical' ? bounds.top : bounds.left) : geometry[axis].thumb / 2
        drag = { axis, pointerId: event.pointerId, grip, track }
        root.classList.add('is-dragging')
        reveal()
        try { track.setPointerCapture(event.pointerId) } catch { /* Window listeners also support dragging outside the track. */ }
        if (!onThumb) moveDrag(coordinate)
      }
      const onKey = (event: KeyboardEvent) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (layoutDirty) measure()
        const current = geometry[axis]
        const value = position(axis), step = 40, page = Math.max(step, current.viewport * 0.9)
        let next: number
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = current.maximum
        else if (event.key === 'PageUp') next = value - page
        else if (event.key === 'PageDown') next = value + page
        else if (event.key === ' ') next = value + (event.shiftKey ? -page : page)
        else if (event.key === (axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft')) next = value - step
        else if (event.key === (axis === 'vertical' ? 'ArrowDown' : 'ArrowRight')) next = value + step
        else return
        event.preventDefault(); event.stopPropagation()
        seek(axis, next)
      }
      const onWheel = (event: WheelEvent) => {
        if (event.ctrlKey) return
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? geometry[axis].viewport : 1
        let left = event.deltaX * unit, top = event.deltaY * unit
        if (event.shiftKey && !left) { left = top; top = 0 }
        if (axis === 'horizontal' && !geometry.vertical.overflow && !left) { left = top; top = 0 }
        if (!left && !top) return
        event.preventDefault()
        target.scrollBy({ left, top, behavior: 'auto' })
        reveal(); schedule()
      }
      track.addEventListener('pointerenter', onEnter)
      track.addEventListener('pointerleave', onLeave)
      track.addEventListener('pointerdown', onDown)
      track.addEventListener('lostpointercapture', endDrag)
      track.addEventListener('keydown', onKey)
      track.addEventListener('wheel', onWheel, { passive: false })
      cleanupTracks.push(() => {
        track.removeEventListener('pointerenter', onEnter); track.removeEventListener('pointerleave', onLeave)
        track.removeEventListener('pointerdown', onDown); track.removeEventListener('lostpointercapture', endDrag)
        track.removeEventListener('keydown', onKey); track.removeEventListener('wheel', onWheel)
      })
    }
    const onFocus = () => { focused = true; reveal() }
    const onBlur = (event: FocusEvent) => { focused = event.relatedTarget instanceof Node && root.contains(event.relatedTarget); armHide() }
    root.addEventListener('focusin', onFocus)
    root.addEventListener('focusout', onBlur)
    target.addEventListener('scroll', onScroll, { passive: true })
    target.addEventListener('wheel', reveal, { passive: true })
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    window.addEventListener('blur', endDrag)
    update()

    return () => {
      endDrag(); clearHide()
      if (frame) cancelAnimationFrame(frame)
      resize?.disconnect(); mutations.disconnect(); siblings?.disconnect()
      for (const cleanup of cleanupTracks) cleanup()
      root.removeEventListener('focusin', onFocus); root.removeEventListener('focusout', onBlur)
      target.removeEventListener('scroll', onScroll); target.removeEventListener('wheel', reveal)
      window.removeEventListener('resize', onResize); window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd); window.removeEventListener('pointercancel', onPointerEnd)
      window.removeEventListener('blur', endDrag)
      if (assignedId && target.id === controls) target.removeAttribute('id')
    }
  }, [target, generatedId])

  return <div className="dsh-pdf-scrollbars" ref={overlay}>
    <div className="dsh-pdf-scrollbar is-vertical" ref={vertical} hidden role="scrollbar"
      aria-label={verticalLabel} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={-1}>
      <div className="dsh-pdf-scrollbar-thumb" ref={verticalThumb} aria-hidden="true" />
    </div>
    <div className="dsh-pdf-scrollbar is-horizontal" ref={horizontal} hidden role="scrollbar"
      aria-label={horizontalLabel} aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={-1}>
      <div className="dsh-pdf-scrollbar-thumb" ref={horizontalThumb} aria-hidden="true" />
    </div>
  </div>
}
