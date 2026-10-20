/** LRU capacity is counted in bytes, rather than document or tile count. */
export class ByteCache<T> {
  private values = new Map<string, { value: T; size: number }>()
  bytes = 0
  constructor(readonly budget: number, private readonly release: (value: T) => void = () => {}) {}
  get(key: string): T | undefined {
    const item = this.values.get(key)
    if (!item) return undefined
    this.values.delete(key); this.values.set(key, item)
    return item.value
  }
  set(key: string, value: T, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid cache byte size')
    this.delete(key)
    if (size > this.budget) { this.release(value); return }
    this.values.set(key, { value, size }); this.bytes += size
    while (this.bytes > this.budget) this.delete(this.values.keys().next().value!)
  }
  delete(key: string): void {
    const item = this.values.get(key)
    if (!item) return
    this.values.delete(key); this.bytes -= item.size; this.release(item.value)
  }
  clear(): void { for (const key of this.values.keys()) this.delete(key) }
  get size(): number { return this.values.size }
}
