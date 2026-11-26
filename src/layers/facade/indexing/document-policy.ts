import { z } from 'zod'
import { documentIndexPolicySchema, type PdfDocumentIndexPolicy, type PdfDocumentIndexSettings } from '../../../contracts/indexing.js'
import { canonicalEngineJson, engineConfigurationsSchema, type EngineJson } from '../../../engines/spi/index.js'
import { defaultSettings, type PdfSettings } from '../../../shared/contracts.js'

const engineId = z.string().min(1).max(200)
const resolvedPolicySchema = documentIndexPolicySchema.extend({
  embeddingEngine: engineId, ocrEngine: engineId, imageEngine: engineId,
}).strict()
export const resolvedRetrievalBindingSchema = z.object({
  policy: resolvedPolicySchema, configurations: engineConfigurationsSchema,
}).strict()
export type ResolvedRetrievalBinding = z.infer<typeof resolvedRetrievalBindingSchema>
export const documentIndexRecordSchema = z.object({
  version: z.literal(3), revision: z.number().int().nonnegative(), policy: documentIndexPolicySchema,
}).strict()
type Record = z.infer<typeof documentIndexRecordSchema>
interface Store {
  key(path: string): string
  get(key: string): unknown
  put(key: string, value: Record): Promise<unknown>
}
const equal = (left: unknown, right: unknown) => canonicalEngineJson(left as EngineJson) === canonicalEngineJson(right as EngineJson)
const stale = () => Object.assign(new Error('PDF index settings changed. Reload their current values and retry.'), { code: 'pdf/index-settings-stale' })

export function indexPolicy(settings: Pick<PdfSettings, 'indexScanPages' | 'indexImageDescriptions'>): PdfDocumentIndexPolicy {
  return { indexScanPages: settings.indexScanPages ?? true, indexImageDescriptions: settings.indexImageDescriptions ?? false }
}
/** Resolve the current engine configuration for one facade operation. It is never persisted with the document. */
export function resolveRetrievalBinding(policy: PdfDocumentIndexPolicy, settings: PdfSettings): ResolvedRetrievalBinding {
  const resolved = { ...policy, embeddingEngine: settings.embeddingEngine ?? 'none',
    ocrEngine: settings.ocrEngine ?? defaultSettings.ocrEngine!, imageEngine: settings.imageEngine ?? 'dsh-vision' }
  const configurations: ResolvedRetrievalBinding['configurations'] = {}
  for (const [kind, id] of [['embedding', resolved.embeddingEngine], ['ocr', resolved.ocrEngine], ['image', resolved.imageEngine]] as const) {
    if (kind === 'ocr' && !policy.indexScanPages || kind === 'image' && !policy.indexImageDescriptions || id === 'none') continue
    configurations[kind] = { [id]: structuredClone(settings.engineConfigurations?.[kind]?.[id] ?? {}) }
  }
  return { policy: structuredClone(resolved), configurations }
}
export function settingsForRetrievalBinding(binding: ResolvedRetrievalBinding, defaults: PdfSettings = defaultSettings): PdfSettings {
  return { ...defaults, ...binding.policy, engineConfigurations: structuredClone(binding.configurations) }
}

/** Host/profile-owned document content preferences. Cached index generations have their own identity. */
export function createDocumentIndexPolicies(store: Store, defaults: () => PdfSettings) {
  const entries = new Map<string, { record: Record; pending: Promise<void>; retained: boolean }>()
  const listeners = new Set<() => void>()
  let disposed = false
  let disposal: Promise<void> | undefined
  const enabled = () => (defaults().embeddingEngine ?? 'none') !== 'none'
  const changed = () => { for (const listener of [...listeners]) { try { listener() } catch { /* Passive observers. */ } } }
  function entry(path: string) {
    if (disposed) throw new Error('PDF index settings are closed.')
    const key = store.key(path)
    let current = entries.get(key)
    if (!current) {
      const saved = store.get(key)
      const record: Record = saved && typeof saved === 'object' && 'version' in saved && saved.version === 3
        ? documentIndexRecordSchema.parse(saved)
        : { version: 3, revision: 0, policy: indexPolicy(defaults()) }
      current = { record, pending: Promise.resolve(), retained: true }
      entries.set(key, current)
    }
    current.retained = true
    return { key, current }
  }
  function write(path: string, update: (record: Record) => Record): Promise<void> {
    const { key, current } = entry(path)
    const pending = current.pending.catch(() => {}).then(async () => {
      const next = documentIndexRecordSchema.parse(update(structuredClone(current.record)))
      if (equal(next, current.record)) return
      await store.put(key, structuredClone(next))
      current.record = next
      changed()
    })
    current.pending = pending
    void pending.catch(() => {})
    return pending
  }
  return {
    enabled,
    current(path: string): ResolvedRetrievalBinding {
      return resolveRetrievalBinding(entry(path).current.record.policy, defaults())
    },
    async settled(path: string) {
      const { key, current } = entry(path), pending = current.pending
      try { await pending } catch (error) {
        if (disposed) throw error
        if (current.pending === pending) {
          current.pending = Promise.resolve().then(async () => { await store.put(key, structuredClone(current.record)) })
          void current.pending.catch(() => {})
        }
        await current.pending
      }
    },
    snapshot(path: string, documentId: string): PdfDocumentIndexSettings {
      const { record } = entry(path).current
      return { documentId, revision: record.revision, policy: structuredClone(record.policy), enabled: enabled() }
    },
    configure(path: string, revision: number, policy: PdfDocumentIndexPolicy) {
      const next = documentIndexPolicySchema.parse(policy)
      return write(path, record => {
        if (record.revision !== revision) throw stale()
        if (equal(record.policy, next)) return record
        return { ...record, revision: record.revision + 1, policy: next }
      })
    },
    defaults(path: string, revision: number) {
      return this.configure(path, revision, indexPolicy(defaults()))
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    releaseUnused(paths: ReadonlySet<string>) {
      const kept = new Set([...paths].map(path => store.key(path)))
      for (const [key, current] of entries) {
        if (kept.has(key)) continue
        current.retained = false
        const pending = current.pending
        void pending.catch(() => {}).then(() => {
          if (!current.retained && current.pending === pending && entries.get(key) === current) entries.delete(key)
        })
      }
    },
    dispose() {
      if (disposal) return disposal
      disposed = true; listeners.clear()
      disposal = Promise.allSettled([...entries.values()].map(value => value.pending)).then(() => { entries.clear() })
      return disposal
    },
  }
}
