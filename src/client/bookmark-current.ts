import type { ReaderOutlineItem } from './reader-document.js'

/** Find the most specific native outline destination at or before the visible page. */
export function currentOutlineKey(items: readonly ReaderOutlineItem[], currentPage: number, numPages: number): string | undefined {
  if (!Number.isInteger(currentPage) || currentPage < 1) return undefined
  let bestPage = 0
  let bestKey: string | undefined
  const stack = items.map((item, index) => ({ item, key: String(index) })).reverse()
  while (stack.length) {
    const { item, key } = stack.pop()!
    const destination = item.dest
    const zeroBasedPage = Array.isArray(destination) ? destination[0] : undefined
    if (Number.isInteger(zeroBasedPage) && zeroBasedPage >= 0 && zeroBasedPage < numPages) {
      const page = zeroBasedPage + 1
      if (page <= currentPage && page >= bestPage) {
        bestPage = page
        bestKey = key
      }
    }
    for (let index = item.items.length - 1; index >= 0; index--) {
      stack.push({ item: item.items[index]!, key: `${key}/${index}` })
    }
  }
  return bestKey
}

export function outlineAncestorKeys(key: string): string[] {
  const parts = key.split('/')
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
}
