import type { PageGeometry } from './page-layout.ts'
const roots = new WeakMap<HTMLElement, readonly PageGeometry[]>()
/** A wheel gesture owns exactly one reflow; it is not a second navigation state. */
export interface WheelZoomReflow {
  ownerKey: unknown
  source: readonly PageGeometry[]
  page: number
  scale: number
  fraction: readonly [number, number]
  pointer: readonly [number, number]
  prepare(): void
  complete(): void
  cancel(): void
}
const zooms = new WeakMap<HTMLElement, WheelZoomReflow>()
export const wheelZoomReflow = (root: HTMLElement) => zooms.get(root)
export const setWheelZoomReflow = (root: HTMLElement, reflow: WheelZoomReflow) => zooms.set(root, reflow)
export const clearWheelZoomReflow = (root: HTMLElement, reflow: WheelZoomReflow) => {
  if (zooms.get(root) === reflow) zooms.delete(root)
}

/** Preview and committed layout obey the same document edges and page centering. */
export function wheelZoomPosition(page: { left: number; top: number; width: number; height: number },
  anchor: Pick<WheelZoomReflow, 'fraction' | 'pointer'>,
  extent: { width: number; height: number }, viewport: { width: number; height: number }) {
  return {
    left: Math.max(0, Math.min(Math.max(0, extent.width - viewport.width), page.left + anchor.fraction[0] * page.width - anchor.pointer[0])),
    top: Math.max(0, Math.min(Math.max(0, extent.height - viewport.height), page.top + anchor.fraction[1] * page.height - anchor.pointer[1])),
  }
}
export const setWindowLayout = (root: HTMLElement, layout: readonly PageGeometry[]) => roots.set(root, layout)
export const clearWindowLayout = (root: HTMLElement) => roots.delete(root)
export const windowLayout = (root: HTMLElement) => roots.get(root)
export const pageWindowLeft = (root: HTMLElement, page: PageGeometry) => page.left ?? (root.scrollWidth - page.width) / 2
export function pageIndexAtOffset(layout: readonly PageGeometry[], offset: number): number {
  let low = 0, high = layout.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (layout[middle].top + layout[middle].outerHeight <= offset) low = middle + 1
    else high = middle
  }
  return Math.min(low, Math.max(0, layout.length - 1))
}
