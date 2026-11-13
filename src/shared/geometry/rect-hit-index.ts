/** Fixed cell/reference limits keep broad marks from multiplying index memory. */
export function createRectHitIndex<T>(items: readonly { rect: readonly number[]; value: T }[], cellSize = 128) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Hit index cell size must be positive.')
  const records: { rect: [number, number, number, number]; value: T }[] = []
  const cells = new Map<string, number[]>()
  const broad: number[] = []
  const extent = (rect: readonly number[]) => [Math.floor(rect[0] / cellSize), Math.floor(rect[1] / cellSize),
    Math.floor(rect[2] / cellSize), Math.floor(rect[3] / cellSize)] as const
  for (const item of items) {
    if (item.rect.length !== 4 || !item.rect.every(Number.isFinite)) continue
    const rect: [number, number, number, number] = [Math.min(item.rect[0], item.rect[2]), Math.min(item.rect[1], item.rect[3]),
      Math.max(item.rect[0], item.rect[2]), Math.max(item.rect[1], item.rect[3])]
    const index = records.push({ rect, value: item.value }) - 1
    const [left, top, right, bottom] = extent(rect)
    if (![left, top, right, bottom].every(Number.isSafeInteger)
      || (right - left + 1) * (bottom - top + 1) > 16) { broad.push(index); continue }
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
      const key = `${x}:${y}`
      const bucket = cells.get(key)
      if (bucket) bucket.push(index)
      else cells.set(key, [index])
    }
  }
  const overlaps = (rect: readonly number[], other: readonly number[]) => rect[0] <= other[2] && rect[2] >= other[0]
    && rect[1] <= other[3] && rect[3] >= other[1]
  return {
    at(x: number, y: number): T[] {
      const bucket = cells.get(`${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`) ?? []
      // Both lists retain source order and are disjoint. Merge without sorting.
      const result: T[] = []
      for (let local = 0, large = 0; local < bucket.length || large < broad.length;) {
        const index = large === broad.length || (local < bucket.length && bucket[local] < broad[large])
          ? bucket[local++] : broad[large++]
        const record = records[index]
        if (x >= record.rect[0] && x <= record.rect[2] && y >= record.rect[1] && y <= record.rect[3]) result.push(record.value)
      }
      return result
    },
    intersect(query: readonly number[]): T[] {
      if (query.length !== 4 || !query.every(Number.isFinite)) return []
      const rect = [Math.min(query[0], query[2]), Math.min(query[1], query[3]),
        Math.max(query[0], query[2]), Math.max(query[1], query[3])]
      const [left, top, right, bottom] = extent(rect)
      const result: T[] = []
      if (![left, top, right, bottom].every(Number.isSafeInteger)
        || (right - left + 1) * (bottom - top + 1) > 64) {
        for (const record of records) if (overlaps(record.rect, rect)) result.push(record.value)
        return result
      }
      const indices = new Set(broad)
      for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
        for (const index of cells.get(`${x}:${y}`) ?? []) indices.add(index)
      }
      // Rectangle queries only ask about overlap; source order is unnecessary.
      for (const index of indices) if (overlaps(records[index].rect, rect)) result.push(records[index].value)
      return result
    },
  }
}
