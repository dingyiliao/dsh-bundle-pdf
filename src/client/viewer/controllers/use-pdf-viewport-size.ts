import { useEffect, useRef } from 'react'
import { scrollportPadding } from '../rendering/pdf-viewport-geometry.js'

export interface PdfViewportSize { width: number; height: number; paddingLeft?: number; paddingRight?: number }

export interface PdfViewportSizeOptions {
  root: HTMLElement | null
  /** Change when the document or fit mode changes. */
  ownerKey?: unknown
  size: PdfViewportSize
  onSize(size: PdfViewportSize): void
}

const sameSize = (a: PdfViewportSize, b: PdfViewportSize): boolean =>
  Math.abs(a.width - b.width) < 0.25 && Math.abs(a.height - b.height) < 0.25
  && Math.abs((a.paddingLeft ?? 0) - (b.paddingLeft ?? 0)) < 0.25
  && Math.abs((a.paddingRight ?? 0) - (b.paddingRight ?? 0)) < 0.25

/** Report the visible scrollport size; WindowedPages owns numeric reflow anchoring. */
export function usePdfViewportSize(options: PdfViewportSizeOptions): void {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const root = options.root
    if (!root) return
    const ownerKey = options.ownerKey
    const body = root.closest('.dsh-pdf-body')
    const toolRail = body?.querySelector<HTMLElement>(':scope > [data-pdf-tool-rail]')
    const sidebar = body?.querySelector<HTMLElement>(':scope > .dsh-pdf-sidebar')
    let measured: PdfViewportSize | undefined
    const update = (entries: ResizeObserverEntry[] = []) => {
      if (!Object.is(latest.current.ownerKey, ownerKey)) return
      const entry = entries.find(entry => entry.target === root) ?? entries[0]
      const bounds = root.getBoundingClientRect()
      if (bounds.width > 0) {
        for (const [name, chrome] of [['left', toolRail], ['right', sidebar]] as const) {
          if (!chrome) continue
          const box = chrome.getBoundingClientRect()
          const value = Math.max(0, name === 'left' ? box.right - bounds.left + 16 : bounds.right - box.left + 16)
          const key = `--pdf-reading-gutter-${name}`, pixels = `${value}px`
          if (root.style.getPropertyValue(key) !== pixels) root.style.setProperty(key, pixels)
        }
      }
      const padding = scrollportPadding(root)
      const size = { width: root.clientWidth || (entry?.contentRect.width ?? 0) + padding.paddingLeft + padding.paddingRight,
        height: root.clientHeight || entry?.contentRect.height || 0, ...padding }
      if (!(size.width > 0 && size.height > 0)) {
        // Hidden tabs keep their last useful scale; their next visible report
        // is a fresh measurement rather than a restoration of stale DOM state.
        measured = undefined
        return
      }
      if (measured && sameSize(measured, size)) return
      measured = size
      if (!sameSize(latest.current.size, size)) latest.current.onSize(size)
    }
    const observer = new ResizeObserver(update)
    // The gutter changes the content box, never the scrollport's outer size.
    // Observing that outer box avoids feeding our own padding writes back into RO.
    observer.observe(root, { box: 'border-box' })
    for (const chrome of [toolRail, sidebar]) if (chrome) observer.observe(chrome, { box: 'border-box' })
    const mutations = new root.ownerDocument.defaultView!.MutationObserver(() => update())
    for (const chrome of [toolRail, sidebar]) if (chrome) mutations.observe(chrome, { attributes: true, attributeFilter: ['class', 'style'] })
    update()
    return () => { observer.disconnect(); mutations.disconnect() }
  }, [options.root, options.ownerKey])
}
