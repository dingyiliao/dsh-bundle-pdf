import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PageView } from './reader-selection.js'
import { pageAtPointer, suspendScrollAnchoring } from './pdf-viewport-geometry.js'

export interface PdfWheelZoomOptions {
  root: HTMLElement | null
  enabled: boolean
  views: ReadonlyMap<number, PageView>
  /** The actual scale for this page, including the current fit mode. */
  getScale(page: number): number
  /** Set the custom PDF scale directly; do not create a navigation entry. */
  onScale(scale: number): void
  /** Change when the document or its rotation changes. */
  ownerKey?: unknown
  minScale?: number
  maxScale?: number
}

interface ZoomAnchor {
  page: number
  element: HTMLElement
  view?: PageView
  point: readonly number[]
  fraction: readonly [number, number]
  pointer: readonly [number, number]
  initialScale: number
  initialWidth: number
  initialHeight: number
  targetScale: number
}

/** Ctrl+wheel changes only the PDF, with one state update per animation frame. */
export function usePdfWheelZoom(options: PdfWheelZoomOptions): void {
  const latest = useRef(options)
  latest.current = options
  const controller = useRef<{ root: HTMLElement; ownerKey: unknown; restore(): void } | null>(null)

  useLayoutEffect(() => {
    if (options.enabled && controller.current?.root === options.root && Object.is(controller.current.ownerKey, options.ownerKey)) controller.current.restore()
  })

  useEffect(() => {
    const root = options.root
    if (!root) return
    const ownerKey = options.ownerKey
    let anchor: ZoomAnchor | undefined
    let pendingScale: number | undefined
    let scaleFrame = 0, restoreFrame = 0
    let releaseAnchoring: (() => void) | undefined

    const reset = () => {
      cancelAnimationFrame(scaleFrame)
      cancelAnimationFrame(restoreFrame)
      scaleFrame = restoreFrame = 0
      anchor = undefined
      pendingScale = undefined
      releaseAnchoring?.()
      releaseAnchoring = undefined
    }
    const restore = () => {
      const current = anchor
      if (!current || !latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey) || !root.contains(current.element)) return
      // The PDF.js PageView is registered in a passive effect. The DOM already
      // has its new dimensions after React commits, so derive the new viewport
      // synchronously from the captured PDF page without waiting for canvas.
      const bounds = current.element.getBoundingClientRect()
      const viewport = current.view?.page.getViewport({ scale: current.targetScale, rotation: current.view.viewport.rotation })
      const width = viewport?.width ?? current.initialWidth * current.targetScale / current.initialScale
      const height = viewport?.height ?? current.initialHeight * current.targetScale / current.initialScale
      if (Math.abs(bounds.width - width) > 0.5 || Math.abs(bounds.height - height) > 0.5) return
      const point = viewport ? viewport.convertToViewportPoint(current.point[0], current.point[1])
        : [current.fraction[0] * bounds.width, current.fraction[1] * bounds.height]
      const outer = root.getBoundingClientRect()
      root.scrollLeft += bounds.left + point[0] - outer.left - root.clientLeft - current.pointer[0]
      root.scrollTop += bounds.top + point[1] - outer.top - root.clientTop - current.pointer[1]
      // Scroll clamping at the document edges is expected. A newer wheel event
      // with a queued scale still owns the pending gesture.
      if (!scaleFrame) reset()
    }
    controller.current = { root, ownerKey, restore }

    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) { reset(); return }
      // Never let a busy/unready PDF gesture zoom the entire Harness UI.
      event.preventDefault()
      if (!event.deltaY || !Number.isFinite(event.deltaY)) return
      const settings = latest.current
      if (!settings.enabled || !Object.is(settings.ownerKey, ownerKey)) return
      const element = pageAtPointer(root, event.target, event.clientY)
      const page = Number(element?.dataset.pdfPage)
      if (!element || !Number.isInteger(page) || page < 1) return
      const bounds = element.getBoundingClientRect()
      if (!(bounds.width > 0 && bounds.height > 0)) return
      const candidate = settings.views.get(page)
      const view = candidate?.element === element ? candidate : undefined
      const actualScale = view ? view.viewport.scale * bounds.width / view.viewport.width
        : anchor?.element === element ? anchor.initialScale * bounds.width / anchor.initialWidth : settings.getScale(page)
      if (!(actualScale > 0 && Number.isFinite(actualScale))) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1)
      const minimum = Math.max(0.01, settings.minScale ?? 0.1)
      const maximum = Math.max(minimum, settings.maxScale ?? 5)
      const next = Math.max(minimum, Math.min(maximum, (pendingScale ?? actualScale) * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002)))
      const fraction: [number, number] = [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height]
      const outer = root.getBoundingClientRect()
      anchor = {
        page, element, view, fraction,
        point: view ? view.viewport.convertToPdfPoint(fraction[0] * view.viewport.width, fraction[1] * view.viewport.height) : fraction,
        pointer: [event.clientX - outer.left - root.clientLeft, event.clientY - outer.top - root.clientTop],
        initialScale: actualScale, initialWidth: bounds.width, initialHeight: bounds.height, targetScale: next,
      }
      pendingScale = next
      releaseAnchoring ??= suspendScrollAnchoring(root)
      if (scaleFrame) return
      scaleFrame = requestAnimationFrame(() => {
        scaleFrame = 0
        const scale = pendingScale
        if (scale === undefined) return
        if (!latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey)) { reset(); return }
        latest.current.onScale(scale)
        cancelAnimationFrame(restoreFrame)
        restoreFrame = requestAnimationFrame(() => { restoreFrame = 0; restore() })
      })
    }
    const pointerDown = () => reset()
    root.addEventListener('wheel', wheel, { passive: false })
    root.addEventListener('pointerdown', pointerDown)
    root.addEventListener('pdfviewchange', restore)
    return () => {
      reset()
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('pointerdown', pointerDown)
      root.removeEventListener('pdfviewchange', restore)
      if (controller.current?.root === root) controller.current = null
    }
  }, [options.root, options.enabled, options.ownerKey])
}
