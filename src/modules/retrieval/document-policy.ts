import { z } from 'zod'
import { documentIndexPolicySchema, type PdfDocumentIndexPolicy, type PdfDocumentIndexSettings } from '../../contracts/indexing.js'
import { canonicalEngineJson, engineConfigurationsSchema, type EngineJson } from '../engines/index.js'
import { defaultSettings, type PdfSettings } from '../../shared/contracts.js'

export const resolvedIndexPlanSchema = z.object({
  policy: documentIndexPolicySchema, configurations: engineConfigurationsSchema,
}).strict()
export type ResolvedIndexPlan = z.infer<typeof resolvedIndexPlanSchema>
export const documentIndexRecordSchema = z.object({
  revision: z.number().int().nonnegative(), desired: documentIndexPolicySchema, active: resolvedIndexPlanSchema,
}).strict()
type Record = z.infer<typeof documentIndexRecordSchema>
interface Store {
  key(path: string): string
  get(key: string): unknown
  put(key: string, value: Record): Promise<unknown>
}
const equal = (left: unknown, right: unknown) => canonicalEngineJson(left as EngineJson) === canonicalEngineJson(right as EngineJson)
const stale = () => Object.assign(new Error('PDF index settings changed. Reload their current values and retry.'), { code: 'pdf/index-settings-stale' })

export function indexPolicy(settings: PdfSettings): PdfDocumentIndexPolicy {
  return { embeddingEngine: settings.embeddingEngine ?? 'none', ocrEngine: settings.ocrEngine ?? 'session-llm',
    imageEngine: settings.imageEngine ?? 'dsh-vision', indexScanPages: settings.indexScanPages ?? true,
    indexImageDescriptions: settings.indexImageDescriptions ?? false }
}
/** Freeze only the selected bindings; edits to unrelated engines do not invalidate this document. */
export function resolveIndexPlan(policy: PdfDocumentIndexPolicy, settings: PdfSettings): ResolvedIndexPlan {
  const configurations: ResolvedIndexPlan['configurations'] = {}
  for (const [kind, id] of [['embedding', policy.embeddingEngine], ['ocr', policy.ocrEngine], ['image', policy.imageEngine]] as const) {
    if (kind === 'ocr' && !policy.indexScanPages || kind === 'image' && !policy.indexImageDescriptions || id === 'none') continue
    configurations[kind] = { [id]: structuredClone(settings.engineConfigurations?.[kind]?.[id] ?? {}) }
  }
  return { policy: structuredClone(policy), configurations }
}
export function settingsForIndexPlan(plan: ResolvedIndexPlan, defaults: PdfSettings = defaultSettings): PdfSettings {
  return { ...defaults, ...plan.policy, engineConfigurations: structuredClone(plan.configurations) }
}

/** Host/profile-owned preferences. The path key survives saves; source digests belong to derived indexes. */
export function createDocumentIndexPolicies(store: Store, defaults: () => PdfSettings) {
  const entries = new Map<string, { record: Record; pending: Promise<void>; retained: boolean }>()
  const listeners = new Set<() => void>()
  let disposed = false
  let disposal: Promise<void> | undefined
  const changed = () => { for (const listener of [...listeners]) { try { listener() } catch { /* Passive observers. */ } } }
  function entry(path: string) {
    if (disposed) throw new Error('PDF index settings are closed.')
    const key = store.key(path)
    let current = entries.get(key)
    if (!current) {
      const saved = store.get(key)
      const desired = indexPolicy(defaults())
      const record = saved === undefined ? { revision: 0, desired, active: resolveIndexPlan(desired, defaults()) }
        : documentIndexRecordSchema.parse(saved)
      current = { record, pending: Promise.resolve(), retained: true }
      entries.set(key, current)
      if (saved === undefined) {
        current.pending = Promise.resolve().then(async () => { await store.put(key, structuredClone(record)) })
        void current.pending.catch(() => {})
      }
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
  function desired(path: string): ResolvedIndexPlan {
    return resolveIndexPlan(entry(path).current.record.desired, defaults())
  }
  return {
    active: (path: string): ResolvedIndexPlan => structuredClone(entry(path).current.record.active),
    desired,
    async settled(path: string) {
      const { key, current } = entry(path), pending = current.pending
      try { await pending } catch (error) {
        if (disposed) throw error
        // An explicit retry can recover an initial preference-store failure.
        // Concurrent callers share that retry rather than racing new writes.
        if (current.pending === pending) {
          current.pending = Promise.resolve().then(async () => { await store.put(key, structuredClone(current.record)) })
          void current.pending.catch(() => {})
        }
        await current.pending
      }
    },
    snapshot(path: string, documentId: string): PdfDocumentIndexSettings {
      const { record } = entry(path).current, target = desired(path)
      const pending = !equal(record.active, target)
      const impact = !pending ? 'none' : record.active.policy.embeddingEngine !== target.policy.embeddingEngine
        ? 'embedding' : record.active.policy.indexScanPages !== target.policy.indexScanPages
          || record.active.policy.indexImageDescriptions !== target.policy.indexImageDescriptions
          || record.active.policy.ocrEngine !== target.policy.ocrEngine || record.active.policy.imageEngine !== target.policy.imageEngine
          ? 'content' : 'configuration'
      return { documentId, revision: record.revision, policy: structuredClone(record.desired),
        activePolicy: structuredClone(record.active.policy), pending, impact }
    },
    configure(path: string, revision: number, policy: PdfDocumentIndexPolicy) {
      const next = documentIndexPolicySchema.parse(policy)
      return write(path, record => {
        if (record.revision !== revision) throw stale()
        if (equal(record.desired, next)) return record
        return { ...record, revision: record.revision + 1, desired: next }
      })
    },
    defaults(path: string, revision: number) {
      return this.configure(path, revision, indexPolicy(defaults()))
    },
    activate(path: string, plan: ResolvedIndexPlan) {
      const accepted = resolvedIndexPlanSchema.parse(plan)
      return write(path, record => {
        if (!equal(resolveIndexPlan(record.desired, defaults()), accepted)) throw stale()
        if (equal(record.active, accepted)) return record
        return { ...record, revision: record.revision + 1, active: accepted }
      })
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
