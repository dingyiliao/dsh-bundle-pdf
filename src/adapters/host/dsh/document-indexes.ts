import { createHash, randomUUID } from 'node:crypto'
import type { PdfDocumentIndexPolicy } from '../../../contracts/indexing.js'
import type { createDocumentIndexPolicies, ResolvedIndexPlan } from '../../../modules/retrieval/index.js'
import { canonicalEngineJson, type EngineJson } from '../../../modules/engines/index.js'
import type { OpenWorkingCopyDocument } from '../../../modules/working-copy/index.js'
import type { RetrievalPrepareInput, RetrievalProgress } from '../../../modules/retrieval/index.js'
import type { PdfRetrieval } from './retrieval.js'

type Policies = ReturnType<typeof createDocumentIndexPolicies>
interface Plan { id: string; value: ResolvedIndexPlan; force?: boolean }
interface Runtime { api: PdfRetrieval; users: number; used: number; plan: string; retired?: boolean }
const identity = (value: ResolvedIndexPlan) => createHash('sha256').update(canonicalEngineJson(value as EngineJson)).digest('hex')
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

/** Immutable plans keep a ready query engine separate from a pending replacement build. */
export function createDocumentIndexes(options: {
  documents(): readonly OpenWorkingCopyDocument[]
  policies: Policies
  create(plan: ResolvedIndexPlan): PdfRetrieval
  clearCache(): Promise<void>
  maxRuntimes?: number
}) {
  const maximum = options.maxRuntimes ?? 4
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) throw new RangeError('Invalid index runtime limit')
  const runtimes = new Map<string, Runtime>()
  const candidates = new Map<string, Plan>()
  const activeIds = new Map<string, string>()
  const listeners = new Set<() => void>()
  let allocations = Promise.resolve(), reset: Promise<void> | undefined, disposal: Promise<void> | undefined
  let closed = false, resetFailed = false, clock = 0
  const changed = () => { for (const listener of [...listeners]) { try { listener() } catch { /* Passive observers. */ } } }
  const stopPolicies = options.policies.subscribe(changed)
  function check() {
    if (closed) fail('pdf/cancelled', 'PDF indexing is unloading.')
    if (reset || resetFailed) fail('pdf/retrieval-busy', 'PDF index cache reset is incomplete. Retry clearing the cache.')
  }
  function document(sessionId: string, documentId: string) {
    check()
    const found = options.documents().find(value => value.sessionId === sessionId && value.id === documentId)
    if (!found?.path) return fail('pdf/unknown-document', 'Open this PDF before accessing its index settings.')
    return found as OpenWorkingCopyDocument & { path: string }
  }
  function active(path: string): Plan {
    const value = options.policies.active(path)
    return { value, id: activeIds.get(path) ?? identity(value) }
  }
  function refresh() {
    const paths = new Set(options.documents().flatMap(owner => owner.path ? [owner.path] : []))
    for (const path of candidates.keys()) if (!paths.has(path)) candidates.delete(path)
    for (const path of activeIds.keys()) if (!paths.has(path)) activeIds.delete(path)
    options.policies.releaseUnused(paths)
  }
  async function owned<Result>(sessionId: string, documentId: string,
    operation: (owner: OpenWorkingCopyDocument & { path: string }) => Promise<Result>): Promise<Result> {
    const owner = document(sessionId, documentId)
    try { return await operation(owner) } finally { refresh() }
  }
  async function use<Result>(plan: Plan, operation: (api: PdfRetrieval) => Promise<Result>): Promise<Result> {
    check()
    const acquired = allocations.then(async () => {
      check()
      let runtime = runtimes.get(plan.id)
      if (runtime?.retired) {
        if (runtime.users) fail('pdf/retrieval-busy', 'The previous index engine is finishing a request. Retry shortly.')
        runtimes.delete(plan.id); await runtime.api.dispose(); runtime = undefined
      }
      if (!runtime) {
        if (runtimes.size >= maximum) {
          const oldest = [...runtimes].filter(([, value]) => !value.users).sort((a, b) => a[1].used - b[1].used)[0]
          if (!oldest) fail('pdf/retrieval-busy', 'PDF index engines are busy. Retry shortly.')
          runtimes.delete(oldest[0]); await oldest[1].api.dispose()
        }
        check()
        runtime = { api: options.create(structuredClone(plan.value)), users: 0, used: 0, plan: identity(plan.value) }
        runtimes.set(plan.id, runtime)
      }
      runtime.users++; runtime.used = ++clock
      return runtime
    })
    allocations = acquired.then(() => {}, () => {})
    const runtime = await acquired
    try { return await operation(runtime.api) } finally { runtime.users--; runtime.used = ++clock }
  }
  async function stage(sessionId: string, documentId: string, force = false) {
    return owned(sessionId, documentId, async owner => {
      await options.policies.settled(owner.path)
      const value = options.policies.desired(owner.path), key = identity(value)
      if (value.policy.embeddingEngine === 'none') {
        await options.policies.activate(owner.path, value)
        candidates.delete(owner.path); activeIds.delete(owner.path); changed()
        return
      }
      const previous = candidates.get(owner.path)
      if (previous && identity(previous.value) === key && (!force || previous.force)) return
      if (!force && identity(active(owner.path).value) === key) {
        candidates.delete(owner.path); changed(); return
      }
      candidates.set(owner.path, { value, id: force ? `${key}:${randomUUID()}` : key, ...(force ? { force: true } : {}) })
      changed()
    })
  }
  return {
    refresh,
    selection(owner: OpenWorkingCopyDocument) {
      check()
      if (!owner.path) return undefined
      const plan = candidates.get(owner.path) ?? active(owner.path)
      return plan.value.policy.embeddingEngine === 'none' ? undefined : { identity: plan.id, planId: plan.id }
    },
    settings(sessionId: string, documentId: string) {
      const owner = document(sessionId, documentId)
      return options.policies.snapshot(owner.path, documentId)
    },
    async configure(sessionId: string, documentId: string, revision: number, policy?: PdfDocumentIndexPolicy) {
      return owned(sessionId, documentId, async owner => {
        if (policy) await options.policies.configure(owner.path, revision, policy)
        else await options.policies.defaults(owner.path, revision)
        const target = options.policies.desired(owner.path)
        if (target.policy.embeddingEngine === 'none') {
          await options.policies.activate(owner.path, target)
          candidates.delete(owner.path); activeIds.delete(owner.path); changed()
        }
      })
    },
    stage,
    async availability(sessionId: string, signal: AbortSignal, documentId?: string) {
      signal.throwIfAborted()
      if (!documentId) return { status: 'unavailable' as const, reason: 'Choose an opened PDF to inspect its index configuration.' }
      return owned(sessionId, documentId, async owner => {
        await options.policies.settled(owner.path)
        const plan = active(owner.path)
        const result = await use(plan, api => api.availability(sessionId, signal, documentId))
        if (active(owner.path).id !== plan.id) return { status: 'unavailable' as const,
          reason: 'PDF index settings changed during the capability check. Retry with the current document.' }
        return result
      })
    },
    async prepare(sessionId: string, input: RetrievalPrepareInput & { indexPlanId?: string }, signal: AbortSignal,
      onProgress?: (progress: RetrievalProgress) => void) {
      return owned(sessionId, input.documentId, async owner => {
        await options.policies.settled(owner.path)
        const candidate = candidates.get(owner.path), plan = candidate ?? active(owner.path)
        if (candidate && (input.fromPage !== undefined && input.fromPage !== 1 || input.maxPages !== undefined)) {
          fail('pdf/invalid-request', 'A replacement index must cover the whole PDF before it can become active.')
        }
        if (input.indexPlanId && input.indexPlanId !== plan.id) fail('pdf/stale-reader', 'The queued PDF index configuration has changed.')
        await use(plan, api => api.prepare(sessionId, { documentId: input.documentId,
          ...(input.fromPage ? { fromPage: input.fromPage } : {}), ...(input.maxPages ? { maxPages: input.maxPages } : {}),
          ...(plan.force ? { rebuild: true } : {}) }, signal, onProgress))
        signal.throwIfAborted()
        if (candidate) {
          if (candidates.get(owner.path) !== candidate) fail('pdf/stale-reader', 'The PDF index update was superseded.')
          await options.policies.activate(owner.path, plan.value)
          if (plan.force) for (const [id, runtime] of runtimes) {
            if (id !== plan.id && runtime.plan === identity(plan.value)) runtime.retired = true
          }
          activeIds.set(owner.path, plan.id); candidates.delete(owner.path); changed()
        }
      })
    },
    async search(sessionId: string, input: Parameters<PdfRetrieval['search']>[1], signal: AbortSignal) {
      return owned(sessionId, input.documentId, async owner => {
        await options.policies.settled(owner.path)
        const plan = active(owner.path)
        const result = await use(plan, api => api.search(sessionId, input, signal))
        if (active(owner.path).id !== plan.id) fail('pdf/stale-reader', 'PDF index settings changed during this search. Start a new search.')
        return result
      })
    },
    cancelSession(sessionId: string) { for (const runtime of runtimes.values()) runtime.api.cancelSession(sessionId) },
    rebuild() {
      if (reset) return reset
      if (closed) return Promise.reject(new Error('PDF indexing is closed.'))
      reset = allocations.then(async () => {
        const results = await Promise.allSettled([...runtimes.values()].map(value => value.api.dispose()))
        runtimes.clear(); candidates.clear(); activeIds.clear()
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        await options.clearCache(); resetFailed = false
      }).catch(error => { resetFailed = true; throw error }).finally(() => { reset = undefined; changed() })
      return reset
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() {
      if (disposal) return disposal
      closed = true; stopPolicies(); listeners.clear()
      disposal = (async () => {
        await allocations
        await reset?.catch(() => {})
        const results = await Promise.allSettled([...runtimes.values()].map(value => value.api.dispose()))
        runtimes.clear(); candidates.clear(); activeIds.clear()
        await options.policies.dispose()
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'PDF index runtimes did not fully close')
      })()
      return disposal
    },
  }
}
