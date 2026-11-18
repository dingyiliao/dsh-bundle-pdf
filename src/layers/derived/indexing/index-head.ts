import { randomUUID } from 'node:crypto'
import { isIndexGenerationRetained, retainIndexGeneration, withIndexTransaction } from './index-transaction.js'
import { readIndexHead, storedIndexHeadKey, storedIndexPageKey, type StoredIndexGeneration, type StoredIndexHead } from './stored-index.js'
import type { RetrievalCache } from './types.js'

interface IndexHeadContext {
  key: string
  signal: AbortSignal
  check(): void
  onFailure?(error: unknown): void
}
interface IndexRange { fromPage: number; toPage: number }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
const corrupt = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'pdf/index-storage-corrupt'
const check = (context: IndexHeadContext) => { context.signal.throwIfAborted(); context.check() }

/** Cleanup never changes admission or query outcomes; failed deletions retain
 * their durable marker so a later open can finish the same collection. */
async function collectRetired(storage: RetrievalCache, head: StoredIndexHead, range: IndexRange,
  context: IndexHeadContext): Promise<StoredIndexHead> {
  if (!storage.delete || !head.retired?.length) return head
  const referenced = new Set([head.active?.id, head.pending?.id, ...(head.seeds ?? []).map(seed => seed.id)])
  const remaining: NonNullable<StoredIndexHead['retired']> = []
  for (const retired of head.retired) {
    if (referenced.has(retired.id) || isIndexGenerationRetained(storage, head.key, retired.id)) {
      remaining.push(retired); continue
    }
    try {
      for (let page = range.fromPage; page <= range.toPage; page++) {
        check(context)
        await storage.delete(storedIndexPageKey(head.key, retired.id, page))
      }
      check(context)
    } catch (error) {
      check(context)
      remaining.push(retired)
      try { void Promise.resolve(context.onFailure?.(error)).catch(() => {}) } catch { /* Cleanup is passive. */ }
    }
  }
  if (remaining.length === head.retired.length) return head
  const next: StoredIndexHead = { ...head, retired: remaining }
  try { await storage.set(storedIndexHeadKey(head.key), next) } catch { return head }
  check(context)
  return next
}

/** Read/select/publish and pin atomically across runtimes sharing this store. */
export async function openIndexHead(storage: RetrievalCache, options: IndexHeadContext & IndexRange & {
  preferReady?: boolean
  rebuildToken?: string
}): Promise<{ head: StoredIndexHead; selected: StoredIndexGeneration; created: boolean; release(): void }> {
  let release: (() => void) | undefined
  try {
    return await withIndexTransaction(storage, options.key, options.signal, async () => {
      let head: StoredIndexHead | undefined
      let created = false
      try { head = await readIndexHead(storage, options.key) } catch (error) {
        if (!options.rebuildToken || !corrupt(error)) throw error
      }
      check(options)
      head ??= { version: 1, key: options.key }
      head = await collectRetired(storage, head, options, options)
      if (options.rebuildToken && head.pending?.rebuildToken !== options.rebuildToken && head.active?.rebuildToken !== options.rebuildToken) {
        created = true
        const candidates = [head.active, head.pending, ...(head.seeds ?? [])].filter(value => value !== undefined)
          .filter((value, index, all) => all.findIndex(other => other.id === value.id) === index)
        const seeds = candidates.slice(0, 8)
        const retired = [...(head.retired ?? []), ...candidates.slice(8)]
          .filter((value, index, all) => all.findIndex(other => other.id === value.id) === index)
        if (retired.length > 1024) throw fail('pdf/index-storage-limit', 'Too many retired index generations remain. Clear derived caches after resolving storage errors.')
        head = { ...head, ...(seeds.length ? { seeds } : {}), ...(retired.length ? { retired } : {}),
          pending: { id: randomUUID(), rebuildToken: options.rebuildToken } }
        await storage.set(storedIndexHeadKey(options.key), head)
      }
      let selected = options.preferReady ? head.active ?? head.pending : head.pending ?? head.active
      if (!selected) {
        created = true
        selected = { id: randomUUID() }; head = { ...head, pending: selected }
        await storage.set(storedIndexHeadKey(options.key), head)
      }
      check(options)
      release = retainIndexGeneration(storage, options.key, selected.id)
      return { head, selected, created, release }
    })
  } catch (error) { release?.(); throw error }
}

/** Publish a completed snapshot without erasing a newer resumable generation. */
export function promoteIndexHead(storage: RetrievalCache, options: IndexHeadContext & {
  generation: string
  range: IndexRange
}): Promise<StoredIndexHead> {
  return withIndexTransaction(storage, options.key, options.signal, async () => {
    const head = await readIndexHead(storage, options.key)
    check(options)
    if (head?.active?.id === options.generation) return head
    const complete = head?.pending?.id === options.generation ? head.pending
      : head?.seeds?.find(seed => seed.id === options.generation)
    if (!head || !complete) throw fail('pdf/stale-reader', 'PDF index generation was replaced while building.')
    const pending = head.pending?.id !== options.generation ? head.pending : undefined
    const referenced = new Set([complete.id, pending?.id, ...(pending ? head.seeds ?? [] : []).map(seed => seed.id)])
    const retired = [...(head.retired ?? []), head.active, head.pending, ...(head.seeds ?? [])]
      .filter((value): value is NonNullable<typeof value> => value !== undefined).filter(value => !referenced.has(value.id))
      .filter((value, position, all) => all.findIndex(other => other.id === value.id) === position)
    if (retired.length > 1024) throw fail('pdf/index-storage-limit', 'Too many retired index generations remain. Clear derived caches after resolving storage errors.')
    const accepted: StoredIndexHead = { version: 1, key: options.key, active: complete,
      ...(retired.length ? { retired } : {}),
      ...(pending ? { pending, ...(head.seeds ? { seeds: head.seeds } : {}) } : {}) }
    await storage.set(storedIndexHeadKey(options.key), accepted)
    check(options)
    return collectRetired(storage, accepted, options.range, options)
  })
}
