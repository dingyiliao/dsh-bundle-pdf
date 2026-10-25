import { z } from 'zod'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

export const retrievalCacheRecordSchema = z.object({
  createdAt: z.number().finite().nonnegative(),
  payload: z.json(),
}).strict()
export type RetrievalCacheRecord = z.infer<typeof retrievalCacheRecordSchema>

/** Rebuildable text/vectors; this store never owns documents, drafts or permissions. */
export function createRetrievalCache(table: Pick<KvTable<string, RetrievalCacheRecord>, 'get' | 'put' | 'delete' | 'entries'>,
  options: { maxBytes?: number; maxRecords?: number; maxAgeMs?: number; now?: () => number } = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const maxRecords = options.maxRecords ?? 12000
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000
  const now = options.now ?? Date.now
  const entries = new Map<string, { bytes: number; usedAt: number }>()
  let bytes = 0, initialized = false, pending = Promise.resolve(), nextPrune = 0
  function initialize() {
    if (initialized) return
    for (const [key, value] of table.entries()) {
      const size = Buffer.byteLength(JSON.stringify(value))
      entries.set(key, { bytes: size, usedAt: value.createdAt }); bytes += size
    }
    initialized = true
  }
  async function prune() {
    if (bytes <= maxBytes && entries.size <= maxRecords && now() < nextPrune) return
    nextPrune = now() + Math.min(maxAgeMs, 60_000)
    const oldest = [...entries].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [key, entry] of oldest) {
      const value = table.get(key)
      if (value && now() - value.createdAt <= maxAgeMs && bytes <= maxBytes && entries.size <= maxRecords) continue
      await table.delete(key)
      entries.delete(key); bytes -= entry.bytes
    }
  }
  return {
    async get(key: string): Promise<unknown> {
      // Reads also enforce restored-cache budgets, even if every query is a hit.
      // Serialize them with writes so pruning never deletes a concurrent update.
      const task = pending.then(async () => {
        initialize()
        await prune()
        const value = table.get(key)
        if (!value || now() - value.createdAt > maxAgeMs) return undefined
        const entry = entries.get(key)
        if (entry) entry.usedAt = now()
        return structuredClone(value.payload)
      })
      pending = task.then(() => undefined, () => undefined)
      return task
    },
    async set(key: string, payload: unknown): Promise<void> {
      const record = retrievalCacheRecordSchema.parse({ createdAt: now(), payload })
      const size = Buffer.byteLength(JSON.stringify(record))
      if (size > Math.min(maxBytes, 2 * 1024 * 1024)) return
      const task = pending.then(async () => {
        initialize()
        await table.put(key, record)
        bytes += size - (entries.get(key)?.bytes ?? 0)
        entries.set(key, { bytes: size, usedAt: now() })
        await prune()
      })
      pending = task.catch(() => undefined)
      return task
    },
    async dispose(): Promise<void> { await pending },
  }
}
