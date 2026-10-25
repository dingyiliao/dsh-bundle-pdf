import { z } from 'zod'
import type { EngineDirectorySource } from './directory.js'
import { engineDescriptorSchema, engineKinds, type EngineKind } from './types.js'

export const engineCatalogSchema = z.object({
  revision: z.string().min(1).max(128),
  engines: z.object({ ocr: z.array(engineDescriptorSchema).max(128),
    image: z.array(engineDescriptorSchema).max(128), translation: z.array(engineDescriptorSchema).max(128) }),
})
export type EngineCatalogSnapshot = z.infer<typeof engineCatalogSchema>
export const engineCatalogRequestSchema = z.object({ revision: z.string().min(1).max(128).optional() }).strict().default({})

/** A read-only aggregate, not another implementation registry or selection owner. */
export class EngineCatalog {
  private readonly sources = new Map<EngineKind, { source: EngineDirectorySource; stop(): void }>()
  private readonly listeners = new Set<() => void>()
  private snapshot: EngineCatalogSnapshot = { revision: crypto.randomUUID(), engines: { ocr: [], image: [], translation: [] } }
  private disposed = false
  read = (): EngineCatalogSnapshot => structuredClone(this.snapshot)
  attach(kind: EngineKind, source: EngineDirectorySource): () => void {
    if (this.disposed || this.sources.has(kind)) throw new Error('Engine catalog source is unavailable or duplicated')
    const entry = { source, stop: source.subscribe(() => this.changed()) }
    this.sources.set(kind, entry); this.changed()
    return () => {
      if (this.sources.get(kind) !== entry) return
      this.sources.delete(kind); entry.stop(); this.changed()
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async wait(revision: string | undefined, signal: AbortSignal): Promise<EngineCatalogSnapshot> {
    signal.throwIfAborted()
    if (this.disposed) throw new Error('Engine catalog is disposed')
    if (revision !== this.snapshot.revision) return this.read()
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); stop(); signal.removeEventListener('abort', aborted) }
      const changed = () => { cleanup(); this.disposed ? reject(new Error('Engine catalog is disposed')) : resolve(this.read()) }
      const aborted = () => { cleanup(); reject(signal.reason) }
      const stop = this.subscribe(changed)
      const timer = setTimeout(changed, 15_000)
      signal.addEventListener('abort', aborted, { once: true })
      if (revision !== this.snapshot.revision || this.disposed) changed()
    })
  }
  dispose(): void {
    this.disposed = true
    for (const entry of this.sources.values()) entry.stop()
    this.sources.clear(); this.changed(); this.listeners.clear()
  }
  private changed(): void {
    this.snapshot = { revision: crypto.randomUUID(), engines: Object.fromEntries(engineKinds.map(kind =>
      [kind, this.sources.get(kind)?.source.list() ?? []])) as EngineCatalogSnapshot['engines'] }
    for (const listener of [...this.listeners]) { try { listener() } catch { /* Read-only observer. */ } }
  }
}
