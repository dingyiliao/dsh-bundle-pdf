import { useEffect, useRef } from 'react'

export interface PdfViewportSize { width: number; height: number }

export interface PdfViewportSizeOptions {
  root: HTMLElement | null
  /** Change when the document or fit mode changes. */
  ownerKey?: unknown
  size: PdfViewportSize
  onSize(size: PdfViewportSize): void
}

const sameSize = (a: PdfViewportSize, b: PdfViewportSize): boolean =>
  Math.abs(a.width - b.width) < 0.25 && Math.abs(a.height - b.height) < 0.25

/** Report the visible scrollport size; WindowedPages owns numeric reflow anchoring. */
export function usePdfViewportSize(options: PdfViewportSizeOptions): void {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const root = options.root
    if (!root) return
    const ownerKey = options.ownerKey
    let measured: PdfViewportSize | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || !Object.is(latest.current.ownerKey, ownerKey)) return
      const size = { width: entry.contentRect.width, height: entry.contentRect.height }
      if (!(size.width > 0 && size.height > 0)) {
        // Hidden tabs keep their last useful scale; their next visible report
        // is a fresh measurement rather than a restoration of stale DOM state.
        measured = undefined
        return
      }
      if (measured && sameSize(measured, size)) return
      measured = size
      if (!sameSize(latest.current.size, size)) latest.current.onSize(size)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [options.root, options.ownerKey])
}
