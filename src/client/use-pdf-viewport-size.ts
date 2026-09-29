import { useEffect, useLayoutEffect, useRef } from 'react'
import { pageAtPointer, suspendScrollAnchoring } from './pdf-viewport-geometry.js'

export interface PdfViewportSize { width: number; height: number }

export interface PdfViewportSizeOptions {
  root: HTMLElement | null
  /** Change when the document or its rotation changes. */
  ownerKey?: unknown
  /** True for automatic fit modes while navigation is idle. */
  preserveAnchor: boolean
  /** The size state actually used by the reader's pageScale in this render. */
  size: PdfViewportSize
  onSize(size: PdfViewportSize): void
}

interface ResizeAnchor {
  element: HTMLElement
  fraction: readonly [number, number]
  pointer: readonly [number, number]
  size: PdfViewportSize
}

const sameSize = (a: PdfViewportSize, b: PdfViewportSize): boolean =>
  Math.abs(a.width - b.width) < 0.25 && Math.abs(a.height - b.height) < 0.25

/** Keep the same visible PDF point while automatic fit responds to sidebar/window resizing. */
export function usePdfViewportSize(options: PdfViewportSizeOptions): void {
  const latest = useRef(options)
  latest.current = options
  const controller = useRef<{ root: HTMLElement; ownerKey: unknown; restore(): void } | null>(null)

  useLayoutEffect(() => {
    if (controller.current?.root === options.root && Object.is(controller.current.ownerKey, options.ownerKey)) controller.current.restore()
  })

  useEffect(() => {
    const root = options.root
    if (!root) return
    const ownerKey = options.ownerKey
    let measured: PdfViewportSize | undefined
    let anchor: ResizeAnchor | undefined
    let frame = 0
    let releaseAnchoring: (() => void) | undefined
    const reset = () => {
      cancelAnimationFrame(frame)
      frame = 0
      anchor = undefined
      releaseAnchoring?.()
      releaseAnchoring = undefined
    }
    const restore = () => {
      const settings = latest.current
      if (!settings.preserveAnchor || !Object.is(settings.ownerKey, ownerKey)) { reset(); return }
      const current = anchor
      if (!current) return
      if (!root.contains(current.element) || !root.clientWidth || !root.clientHeight) { reset(); return }
      // A fallback frame can precede React's commit. Wait for the size which
      // pageScale actually consumed, without polling canvas or PDF.js PageView.
      if (!sameSize(settings.size, current.size)) return
      const bounds = current.element.getBoundingClientRect(), outer = root.getBoundingClientRect()
      root.scrollLeft += bounds.left + current.fraction[0] * bounds.width - outer.left - root.clientLeft - current.pointer[0]
      root.scrollTop += bounds.top + current.fraction[1] * bounds.height - outer.top - root.clientTop - current.pointer[1]
      reset()
    }
    controller.current = { root, ownerKey, restore }

    const report = (size: PdfViewportSize) => {
      const settings = latest.current
      if (!Object.is(settings.ownerKey, ownerKey)) return
      if (!(size.width > 0 && size.height > 0)) {
        // Hidden roots retain their last useful scale. The next visible
        // measurement is treated as initial, so it cannot restore a stale point.
        measured = undefined
        reset()
        return
      }
      if (measured && sameSize(measured, size)) return
      const initial = !measured
      measured = size
      if (!initial && settings.preserveAnchor) {
        if (anchor && root.contains(anchor.element)) anchor.size = size
        else {
          const outer = root.getBoundingClientRect()
          const left = outer.left + root.clientLeft, top = outer.top + root.clientTop
          const element = pageAtPointer(root, null, top + Math.min(40, root.clientHeight / 2))
          const bounds = element?.getBoundingClientRect()
          if (element && bounds && bounds.width > 0 && bounds.height > 0) {
            const x = Math.max(bounds.left, Math.min(bounds.right, left + 16))
            const y = Math.max(bounds.top, Math.min(bounds.bottom, top + Math.min(40, root.clientHeight / 2)))
            anchor = { element, size, fraction: [(x - bounds.left) / bounds.width, (y - bounds.top) / bounds.height], pointer: [x - left, y - top] }
          }
        }
        if (anchor) releaseAnchoring ??= suspendScrollAnchoring(root)
      } else reset()
      if (!sameSize(settings.size, size)) settings.onSize(size)
      if (anchor && !frame) frame = requestAnimationFrame(() => { frame = 0; restore() })
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) report({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
      reset()
      if (controller.current?.root === root) controller.current = null
    }
  }, [options.root, options.ownerKey])
}
