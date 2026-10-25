import { engineDescriptorSchema, type EngineDescriptor } from './types.js'

export interface EngineDirectorySource {
  list(): EngineDescriptor[]
  subscribe(listener: () => void): () => void
}

/** Shared bookkeeping only. Each service retains its own typed implementation API. */
export class EngineDirectory<T> implements EngineDirectorySource {
  private readonly entries = new Map<string, { implementation: T; descriptor: EngineDescriptor }>()
  private readonly listeners = new Set<() => void>()
  private disposed = false
  constructor(private readonly describe: (implementation: T) => EngineDescriptor) {}
  register(implementation: T, removed: () => void = () => {}): () => void {
    if (this.disposed) throw new Error('Engine directory is disposed')
    const descriptor = engineDescriptorSchema.parse(this.describe(implementation))
    if (this.entries.has(descriptor.id)) throw new Error(`Engine already registered: ${descriptor.id}`)
    if (this.entries.size >= 128) throw new Error('Engine directory limit exceeded')
    const entry = { implementation, descriptor: structuredClone(descriptor) }
    this.entries.set(descriptor.id, entry)
    this.changed()
    return () => {
      if (this.entries.get(descriptor.id) !== entry) return
      this.entries.delete(descriptor.id)
      try { removed() } finally { this.changed() }
    }
  }
  get(id: string): T | undefined { return this.entries.get(id)?.implementation }
  has(id: string): boolean { return this.entries.has(id) }
  *values(): IterableIterator<T> { for (const entry of this.entries.values()) yield entry.implementation }
  descriptor(id: string): EngineDescriptor | undefined {
    const value = this.entries.get(id)?.descriptor
    return value ? structuredClone(value) : undefined
  }
  list(): EngineDescriptor[] { return [...this.entries.values()].map(entry => structuredClone(entry.descriptor)) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  dispose(): void { this.disposed = true; this.entries.clear(); this.changed(); this.listeners.clear() }
  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener() } catch { /* Observers cannot prevent registry changes. */ } }
  }
}
