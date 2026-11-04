import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { retrievalCacheRecordSchema } from '../../storage/retrieval-cache.js'
import { createRetrievalStore } from '../../filesystem/retrieval-store.js'
import { recordIndexPerformance } from '../../../../modules/retrieval/index.js'

/** Migrating and reading the persistent index share one barrier and lifetime. */
export function createIndexingCache(storageDomain: Context['storageDomain'], options: {
  directory: string; suffix: string; lifetime: AbortSignal
}) {
  const { directory, suffix, lifetime } = options
  const retrievalStore = createRetrievalStore({ directory, maxRecordBytes: 64 * 1024 * 1024, onMetric: recordIndexPerformance })
  let migration: Promise<void> | undefined
  function ensureMigration(): Promise<void> {
    lifetime.throwIfAborted()
    if (migration) return migration
    const pending = retrievalStore.migrateLegacy(async () => {
      lifetime.throwIfAborted()
      const legacy = await storageDomain.open(defineDomain({
        name: `pdf_retrieval_${suffix}`, version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
        tables: { cache: domainTable(retrievalCacheRecordSchema) },
      }))
      return { entries: () => legacy.table('cache').entries(), close: () => legacy.close() }
    }, lifetime)
    migration = pending
    void pending.catch(() => { if (migration === pending) migration = undefined })
    return pending
  }
  async function waitForMigration(signal = lifetime): Promise<void> {
    signal.throwIfAborted()
    const pending = ensureMigration()
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('PDF index migration cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try { await Promise.race([pending, cancelled]); signal.throwIfAborted() }
    finally { signal.removeEventListener('abort', abort) }
  }
  // Migration is independent of Reader startup. No model/extraction request may
  // bypass its barrier and overwrite reusable legacy OCR or vector results.
  void ensureMigration().catch(() => {})
  const retrievalCache = {
    async get(key: string) { await waitForMigration(); return retrievalStore.get(key) },
    async has(key: string) { await waitForMigration(); return retrievalStore.has(key) },
    async set(key: string, value: unknown) { await waitForMigration(); await retrievalStore.set(key, value) },
    async compareAndSet(key: string, expected: unknown, value: unknown) {
      await waitForMigration(); return retrievalStore.compareAndSet(key, expected, value)
    },
    async setMany(entries: readonly (readonly [string, unknown])[]) { await waitForMigration(); await retrievalStore.setMany(entries) },
    async delete(key: string) { await waitForMigration(); await retrievalStore.delete(key) },
    async clear() { await waitForMigration(); await retrievalStore.clear() },
  }
  return { cache: retrievalCache, waitForMigration, dispose: () => retrievalStore.dispose() }
}
