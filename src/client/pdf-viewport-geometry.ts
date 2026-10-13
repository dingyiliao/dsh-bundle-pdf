/** Page lookup is O(1) over a page, O(log P) over the surrounding whitespace. */
import { pageIndexAtOffset, windowLayout } from './native/window-layout.ts'

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
