/** Page lookup is O(1) over a page, O(log P) over the surrounding whitespace. */
import { pageIndexAtOffset, windowLayout } from './window-layout.js'

/** CSS owns the safe gutters; all fit and navigation geometry reads the same values. */
export function scrollportPadding(root: HTMLElement): { paddingLeft: number; paddingRight: number } {
  const style = root.ownerDocument.defaultView!.getComputedStyle(root)
  return { paddingLeft: Number.parseFloat(style.paddingLeft) || 0, paddingRight: Number.parseFloat(style.paddingRight) || 0 }
}

/** Floating editors stay in the readable strip, while PDF surfaces may extend underneath the chrome. */
export function readingViewportBounds(root: HTMLElement): Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'> {
  const bounds = root.getBoundingClientRect(), padding = scrollportPadding(root)
  const left = bounds.left + padding.paddingLeft
  let right = Math.max(left, bounds.right - padding.paddingRight)
  // A comment needs 80px plus 12px on each side. In a very narrow reader,
  // transient editors may cover the right rail rather than disappear mid-edit.
  // Keep the left tools and the outer document scrollbar reachable.
  if (right - left < 104) right = Math.max(left, bounds.right - Math.min(16, padding.paddingRight))
  return { left, right, top: bounds.top, bottom: bounds.bottom, width: right - left, height: bounds.height }
}

export function pageAtPointer(root: HTMLElement, target: EventTarget | null, y: number): HTMLElement | undefined {
  const wrapper = target instanceof Element ? target.closest<HTMLElement>('[data-page-number]') : null
  if (wrapper && root.contains(wrapper)) return wrapper.querySelector<HTMLElement>('[data-pdf-page]') ?? undefined
  const numeric = windowLayout(root)
  if (numeric?.length) {
    const index = pageIndexAtOffset(numeric, y - root.getBoundingClientRect().top + root.scrollTop)
    return root.querySelector<HTMLElement>(`[data-page-number="${numeric[index].page}"] [data-pdf-page]`) ?? undefined
  }
  // Reader pages are direct children, in reading order. Inspect only the binary
  // search candidates instead of enumerating every page on each wheel event.
  let left = 0, right = root.children.length - 1
  let nearest: HTMLElement | undefined
  while (left <= right) {
    const middle = (left + right) >>> 1
    const element = root.children.item(middle)
    if (!(element instanceof HTMLElement) || !element.dataset.pageNumber) return undefined
    const bounds = element.getBoundingClientRect()
    nearest = element
    if (y < bounds.top) right = middle - 1
    else if (y > bounds.bottom) left = middle + 1
    else break
  }
  return nearest?.querySelector<HTMLElement>('[data-pdf-page]') ?? undefined
}

const anchoring = new WeakMap<HTMLElement, { owners: number; value: string; priority: string }>()

/** Resize and wheel gestures can overlap; restore the original style after both finish. */
export function suspendScrollAnchoring(root: HTMLElement): () => void {
  let state = anchoring.get(root)
  if (!state) {
    state = { owners: 0, value: root.style.getPropertyValue('overflow-anchor'), priority: root.style.getPropertyPriority('overflow-anchor') }
    anchoring.set(root, state)
    root.style.setProperty('overflow-anchor', 'none')
  }
  const owner = state
  owner.owners++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--owner.owners) return
    if (owner.value) root.style.setProperty('overflow-anchor', owner.value, owner.priority)
    else root.style.removeProperty('overflow-anchor')
    anchoring.delete(root)
  }
}
