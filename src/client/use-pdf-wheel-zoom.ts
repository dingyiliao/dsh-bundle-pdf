import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PageView } from './reader-selection.js'
import { pageAtPointer, suspendScrollAnchoring } from './pdf-viewport-geometry.js'
import { createBoundedFrameRetry, createWheelZoomCommit } from './wheel-zoom-commit.js'

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
  element: HTMLElement
  view?: PageView
  point: readonly number[]
  fraction: readonly [number, number]
  pointer: readonly [number, number]
  initialScale: number
  initialWidth: number
  initialHeight: number
}

/** Preview high-frequency pinch gestures with CSS, then render the final scale once. */
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
    let committedScale: number | undefined
    let previewFrame = 0
    let releaseAnchoring: (() => void) | undefined
    let restoreRetry: ReturnType<typeof createBoundedFrameRetry> | undefined
    const previewed = new Map<HTMLElement, { transform: string; origin: string }>()

    const clearPreview = () => {
      for (const [element, style] of previewed) {
        element.style.transform = style.transform
        element.style.transformOrigin = style.origin
      }
      previewed.clear()
    }

    const preview = () => {
      const current = anchor, scale = pendingScale
      if (!current || scale === undefined || committedScale !== undefined) return
      const settings = latest.current
      const changes: { element: HTMLElement; ratio: number; origin: string }[] = []
      for (const [page, view] of settings.views) {
        const element = view.element
        if (!root.contains(element)) continue
        const baseScale = settings.getScale(page)
        if (!(baseScale > 0 && Number.isFinite(baseScale))) continue
        changes.push({ element, ratio: scale / baseScale, origin: element === current.element
          ? `${current.fraction[0] * element.offsetWidth}px ${current.fraction[1] * element.offsetHeight}px` : '50% 0' })
      }
      for (const { element, ratio, origin } of changes) {
        if (!previewed.has(element)) previewed.set(element, { transform: element.style.transform, origin: element.style.transformOrigin })
        element.style.transformOrigin = origin
        element.style.transform = `scale(${ratio})`
      }
    }
    const queuePreview = () => {
      if (!previewFrame) previewFrame = requestAnimationFrame(() => { previewFrame = 0; preview() })
    }

    const reset = () => {
      commit.cancel()
      cancelAnimationFrame(previewFrame)
      restoreRetry?.reset()
      previewFrame = 0
      clearPreview()
      anchor = undefined
      pendingScale = undefined
      committedScale = undefined
      releaseAnchoring?.()
      releaseAnchoring = undefined
    }
    const restore = () => {
      const current = anchor
      const scale = committedScale
      if (!current || scale === undefined) return
      if (!latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey) || !root.contains(current.element)) { reset(); return }
      // The PDF.js PageView is registered in a passive effect. The DOM already
      // has its new dimensions after React commits, so derive the new viewport
      // synchronously from the captured PDF page without waiting for canvas.
      const viewport = current.view?.page.getViewport({ scale, rotation: current.view.viewport.rotation })
      const width = viewport?.width ?? current.initialWidth * scale / current.initialScale
      const height = viewport?.height ?? current.initialHeight * scale / current.initialScale
      // offset dimensions ignore the temporary CSS transform. Keep the preview
      // intact if the fallback frame runs before React has committed the layout.
      if (Math.abs(current.element.offsetWidth - width) > 1 || Math.abs(current.element.offsetHeight - height) > 1) {
        if (!restoreRetry?.schedule()) reset()
        return
      }
      clearPreview()
      const bounds = current.element.getBoundingClientRect()
      if (Math.abs(bounds.width - width) > 1 || Math.abs(bounds.height - height) > 1) { reset(); return }
      const point = viewport ? viewport.convertToViewportPoint(current.point[0], current.point[1])
        : [current.fraction[0] * bounds.width, current.fraction[1] * bounds.height]
      const outer = root.getBoundingClientRect()
      root.scrollLeft += bounds.left + point[0] - outer.left - root.clientLeft - current.pointer[0]
      root.scrollTop += bounds.top + point[1] - outer.top - root.clientTop - current.pointer[1]
      // A late wheel event can arrive while React commits the previous scale.
      // Keep its preview and pending trailing commit, without losing the anchor.
      committedScale = undefined
      if (pendingScale !== undefined && Math.abs(pendingScale - scale) > 0.000001) preview()
      else reset()
    }
    restoreRetry = createBoundedFrameRetry(restore)
    const commit = createWheelZoomCommit((scale) => {
      if (!latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey)) { reset(); return }
      committedScale = scale
      cancelAnimationFrame(previewFrame)
      previewFrame = 0
      restoreRetry?.reset()
      latest.current.onScale(scale)
      restoreRetry?.schedule()
    })
    controller.current = { root, ownerKey, restore }

    const wheel = (event: WheelEvent) => {
      // Chromium represents a macOS trackpad pinch as ctrl+wheel. Command+wheel
      // is also useful on macOS and is handled by the same document-local path.
      if (!event.ctrlKey && !event.metaKey) return
      // Never let a busy/unready PDF gesture zoom the entire Harness UI.
      event.preventDefault()
      if (!event.deltaY || !Number.isFinite(event.deltaY)) return
      const settings = latest.current
      if (!settings.enabled || !Object.is(settings.ownerKey, ownerKey)) return
      if (!anchor) {
        const element = pageAtPointer(root, event.target, event.clientY)
        const page = Number(element?.dataset.pdfPage)
        if (!element || !Number.isInteger(page) || page < 1) return
        const bounds = element.getBoundingClientRect()
        if (!(bounds.width > 0 && bounds.height > 0)) return
        const candidate = settings.views.get(page)
        const view = candidate?.element === element ? candidate : undefined
        const actualScale = view ? view.viewport.scale * bounds.width / view.viewport.width : settings.getScale(page)
        if (!(actualScale > 0 && Number.isFinite(actualScale))) return
        const fraction: [number, number] = [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height]
        const outer = root.getBoundingClientRect()
        anchor = {
          element, view, fraction,
          point: view ? view.viewport.convertToPdfPoint(fraction[0] * view.viewport.width, fraction[1] * view.viewport.height) : fraction,
          pointer: [event.clientX - outer.left - root.clientLeft, event.clientY - outer.top - root.clientTop],
          initialScale: actualScale, initialWidth: bounds.width, initialHeight: bounds.height,
        }
        releaseAnchoring ??= suspendScrollAnchoring(root)
      }
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1)
      const minimum = Math.max(0.01, settings.minScale ?? 0.1)
      const maximum = Math.max(minimum, settings.maxScale ?? 5)
      const next = Math.max(minimum, Math.min(maximum, (pendingScale ?? anchor.initialScale) * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002)))
      pendingScale = next
      queuePreview()
      commit.schedule(next)
    }
    const pointerDown = () => { if (pendingScale !== undefined && committedScale === undefined) commit.flush() }
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
