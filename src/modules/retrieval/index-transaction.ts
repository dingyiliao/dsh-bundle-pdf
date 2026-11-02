import type { RetrievalCache } from './types.js'

const transactions = new WeakMap<RetrievalCache, Map<string, Promise<void>>>()
const retainedGenerations = new WeakMap<RetrievalCache, Map<string, Map<string, number>>>()

/** Cached runtime snapshots pin their exact generation until eviction/drain.
 * The head transaction and collector use the same cache object identity. */
export function retainIndexGeneration(cache: RetrievalCache, key: string, generation: string): () => void {
  let keys = retainedGenerations.get(cache)
  if (!keys) { keys = new Map(); retainedGenerations.set(cache, keys) }
  let generations = keys.get(key)
  if (!generations) { generations = new Map(); keys.set(key, generations) }
  generations.set(generation, (generations.get(generation) ?? 0) + 1)
  let retained = true
  return () => {
    if (!retained) return
    retained = false
    const count = generations.get(generation)!
    if (count > 1) generations.set(generation, count - 1)
    else generations.delete(generation)
    if (!generations.size) keys.delete(key)
    if (!keys.size) retainedGenerations.delete(cache)
  }
}

export function isIndexGenerationRetained(cache: RetrievalCache, key: string, generation: string): boolean {
  return (retainedGenerations.get(cache)?.get(key)?.get(generation) ?? 0) > 0
}

/** Serialize a non-reentrant head transaction across runtimes sharing a store.
 * Cancellation only retires a queued slot: its predecessor remains a barrier.
 * Once admitted, an operation drains its actual I/O before releasing ownership. */
export async function withIndexTransaction<T>(cache: RetrievalCache, key: string, signal: AbortSignal,
  operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let keys = transactions.get(cache)
  if (!keys) { keys = new Map(); transactions.set(cache, keys) }
  const previous = keys.get(key) ?? Promise.resolve()
  let release!: () => void
  const owned = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => owned)
  keys.set(key, tail)
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    await Promise.race([previous, cancelled])
    signal.throwIfAborted()
    // Remove the waiting-only listener before entering potentially long I/O.
    // A running operation owns cancellation checks and must not be raced away.
    signal.removeEventListener('abort', abort)
    const value = await operation()
    signal.throwIfAborted()
    return value
  } finally {
    signal.removeEventListener('abort', abort)
    release()
    void tail.then(() => {
      if (keys.get(key) !== tail) return
      keys.delete(key)
      if (!keys.size) transactions.delete(cache)
    })
  }
}
