interface SearchTextItem { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }

/** Preserve split words; insert a space only when adjacent positioned runs have a real gap. */
export function joinSearchText(items: readonly SearchTextItem[]): { text: string; starts: number[] } {
  let text = ''
  const starts: number[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index], previous = items[index - 1]
    if (previous) {
      if (previous.hasEOL) text += '\n'
      else if (!/\s$/.test(text) && !/^\s/.test(item.str)) {
        const [a, b, , , x, y] = previous.transform
        const norm = Math.hypot(a, b) || 1
        const dx = item.transform[4] - x, dy = item.transform[5] - y
        const gap = (dx * a + dy * b) / norm - previous.width
        const cross = Math.abs((dx * -b + dy * a) / norm)
        if (gap > Math.max(0.5, previous.height * 0.15) || cross > Math.max(2, previous.height * 0.5)) text += ' '
      }
    }
    starts.push(text.length)
    text += item.str
  }
  return { text, starts }
}
