import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PageView } from '../model/reader-selection.js'
import { pageAtPointer, suspendScrollAnchoring } from '../rendering/pdf-viewport-geometry.js'
import { createBoundedFrameRetry, createWheelZoomCommit } from './wheel-zoom-commit.js'
import { clearWheelZoomReflow, setWheelZoomReflow, wheelZoomPosition, windowLayout,
  type WheelZoomReflow } from '../rendering/window-layout.js'
import { scrollportPadding } from '../rendering/pdf-viewport-geometry.js'

interface ZoomLayout {
  pages: NonNullable<ReturnType<typeof windowLayout>>
  nativeTops: number[]
  gapTops: number[]
  nativeHeight: number
  gapHeight: number
  maxNativeWidth: number
  top: number
}

/** Derive mixed-page base metrics once, not on every high-frequency wheel event. */
function captureZoomLayout(root: HTMLElement): ZoomLayout | undefined {
  const pages = windowLayout(root)
  if (!pages?.length) return
  let nativeHeight = 0, paintedHeight = 0, maxNativeWidth = 0
  const top = pages[0].top, nativeTops: number[] = [], gapTops: number[] = []
  for (const page of pages) {
    nativeTops.push(nativeHeight)
    gapTops.push(page.top - top - paintedHeight)
    nativeHeight += page.height / page.scale
    paintedHeight += page.height
    maxNativeWidth = Math.max(maxNativeWidth, page.width / page.scale)
  }
  const last = pages.at(-1)!
  return { pages, nativeTops, gapTops, nativeHeight, maxNativeWidth, top,
    gapHeight: last.top + last.outerHeight - top - paintedHeight }
}

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
  pageNumber: number
  layout?: ZoomLayout
  element: HTMLElement
  previewTarget: HTMLElement
  previewOrigin: readonly [number, number]
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
    let reflow: WheelZoomReflow | undefined
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
      if (!latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey)) { reset(); return }
      if (current.layout) {
        const layout = current.layout, index = current.pageNumber - 1
        const source = layout.pages[index]
        if (!source) return
        const padding = scrollportPadding(root)
        const canvasWidth = Math.max(root.clientWidth - padding.paddingLeft - padding.paddingRight, layout.maxNativeWidth * scale)
        const projected = (index: number) => {
          const page = layout.pages[index], width = page.width / page.scale * scale
          return { left: padding.paddingLeft + (canvasWidth - width) / 2,
            top: layout.top + layout.nativeTops[index] * scale + layout.gapTops[index],
            width, height: page.height / page.scale * scale }
        }
        const position = wheelZoomPosition(projected(index), current,
          { width: canvasWidth + padding.paddingLeft + padding.paddingRight,
            height: layout.top + layout.nativeHeight * scale + layout.gapHeight },
          { width: root.clientWidth, height: root.clientHeight })
        // Transform only mounted stages, but place them at the same numeric
        // positions as the final layout. This preserves gaps, mixed-page sizes,
        // document-edge clamps and centering without rerendering native tiles.
        for (const wrapper of root.querySelectorAll<HTMLElement>('.dsh-pdf-windowed-page')) {
          const index = Number(wrapper.dataset.pageNumber) - 1
          const page = layout.pages[index], stage = wrapper.querySelector<HTMLElement>('.dsh-pdf-page-stage')
          if (!page || !stage) continue
          if (!previewed.has(stage)) previewed.set(stage, { transform: stage.style.transform, origin: stage.style.transformOrigin })
          const target = projected(index)
          const oldLeft = page.left ?? (root.scrollWidth - page.width) / 2
          stage.style.transformOrigin = '0 0'
          stage.style.transform = `translate(${target.left - position.left - oldLeft + root.scrollLeft}px, ${target.top - position.top - page.top + root.scrollTop}px) scale(${scale / page.scale})`
        }
        return
      }
      // Standalone Page embedders have no numeric window; keep their local
      // preview while the document-local fallback restores the pointer point.
      const { previewTarget: element, previewOrigin } = current
      if (!root.contains(element)) return
      if (!previewed.has(element)) previewed.set(element, { transform: element.style.transform, origin: element.style.transformOrigin })
      element.style.transformOrigin = `${previewOrigin[0]}px ${previewOrigin[1]}px`
      element.style.transform = `scale(${scale / current.initialScale})`
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
      if (reflow) clearWheelZoomReflow(root, reflow)
      reflow = undefined
      anchor = undefined
      pendingScale = undefined
      committedScale = undefined
      releaseAnchoring?.()
      releaseAnchoring = undefined
    }
    const finish = (scale: number) => {
      if (reflow) clearWheelZoomReflow(root, reflow)
      reflow = undefined
      committedScale = undefined
      if (anchor && pendingScale !== undefined && Math.abs(pendingScale - scale) > .000001) {
        const element = root.querySelector<HTMLElement>(`[data-pdf-page="${anchor.pageNumber}"]`)
        if (!element) { reset(); return }
        anchor.element = element
        anchor.initialScale = scale
        anchor.initialWidth = element.offsetWidth
        anchor.initialHeight = element.offsetHeight
        anchor.layout = captureZoomLayout(root)
        preview()
      } else reset()
    }
    const restore = () => {
      const current = anchor
      const scale = committedScale
      if (!current || scale === undefined) return
      if (!latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey)) { reset(); return }
      if (!root.contains(current.element)) {
        const replacement = root.querySelector<HTMLElement>(`[data-pdf-page="${current.pageNumber}"]`)
        if (!replacement) { reset(); return }
        current.element = replacement
      }
      // The native page view is registered in a passive effect. The DOM already
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
      finish(scale)
    }
    restoreRetry = createBoundedFrameRetry(restore)
    const commit = createWheelZoomCommit((scale) => {
      if (!latest.current.enabled || !Object.is(latest.current.ownerKey, ownerKey)) { reset(); return }
      committedScale = scale
      cancelAnimationFrame(previewFrame)
      previewFrame = 0
      restoreRetry?.reset()
      if (anchor?.layout) {
        const request: WheelZoomReflow = { ownerKey, source: anchor.layout.pages,
          page: anchor.pageNumber, scale, fraction: anchor.fraction, pointer: anchor.pointer,
          prepare: () => { if (reflow === request) clearPreview() },
          complete: () => { if (reflow === request) finish(scale) },
          cancel: () => { if (reflow === request) reset() } }
        reflow = request
        setWheelZoomReflow(root, request)
      }
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
        const previewTarget = element.closest<HTMLElement>('.dsh-pdf-windowed-pages') ?? element
        const previewBounds = previewTarget.getBoundingClientRect()
        anchor = {
          pageNumber: page, layout: captureZoomLayout(root),
          element, previewTarget, previewOrigin: [event.clientX - previewBounds.left, event.clientY - previewBounds.top], view, fraction,
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
    const layoutChanged = () => {
      // A resize or explicit navigation supersedes an uncommitted gesture.
      if (anchor?.layout && committedScale === undefined && windowLayout(root) !== anchor.layout.pages) reset()
    }
    root.addEventListener('wheel', wheel, { passive: false })
    root.addEventListener('pointerdown', pointerDown)
    root.addEventListener('pdfviewchange', restore)
    root.addEventListener('pdflayoutchange', layoutChanged)
    return () => {
      reset()
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('pointerdown', pointerDown)
      root.removeEventListener('pdfviewchange', restore)
      root.removeEventListener('pdflayoutchange', layoutChanged)
      if (controller.current?.root === root) controller.current = null
    }
  }, [options.root, options.enabled, options.ownerKey])
}
