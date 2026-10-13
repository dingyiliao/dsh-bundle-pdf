import type { PageGeometry } from './page-layout.ts'
const roots = new WeakMap<HTMLElement, readonly PageGeometry[]>()
export const setWindowLayout = (root: HTMLElement, layout: readonly PageGeometry[]) => roots.set(root, layout)
export const clearWindowLayout = (root: HTMLElement) => roots.delete(root)
export const windowLayout = (root: HTMLElement) => roots.get(root)
export function pageIndexAtOffset(layout: readonly PageGeometry[], offset: number): number {
  let low = 0, high = layout.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (layout[middle].top + layout[middle].outerHeight <= offset) low = middle + 1
    else high = middle
  }
  return Math.min(low, Math.max(0, layout.length - 1))
}
