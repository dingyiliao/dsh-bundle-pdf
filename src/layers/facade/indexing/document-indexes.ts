import { createHash, randomUUID } from 'node:crypto'
import type { PdfDocumentIndexPolicy } from '../../../contracts/indexing.js'
import type { createDocumentIndexPolicies, ResolvedRetrievalBinding } from './document-policy.js'
import { canonicalEngineJson, type EngineJson } from '../../../engines/spi/index.js'
import type { OpenWorkingCopyDocument } from '../../document/working-copy/index.js'
import type { RetrievalPrepareInput, RetrievalProgress } from '../search/retrieval/types.js'
import type { PdfRetrieval } from '../search/host-retrieval.js'

type Policies = ReturnType<typeof createDocumentIndexPolicies>
interface Selection { id: string; value: ResolvedRetrievalBinding; force?: boolean; started?: boolean; incomplete?: boolean; inFlight?: number }
interface Runtime { api: PdfRetrieval; users: number; used: number; binding: string; retired?: boolean }
const identity = (value: ResolvedRetrievalBinding) => createHash('sha256').update(canonicalEngineJson(value as EngineJson)).digest('hex')
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

/** The facade resolves current preferences and coordinates the embedding runtime with cached index data. */
export function createDocumentIndexes(options: {
  documents(): readonly OpenWorkingCopyDocument[]
  policies: Policies
  create(binding: ResolvedRetrievalBinding): PdfRetrieval
  clearCache(): Promise<void>
  maxRuntimes?: number
}) {
  const maximum = options.maxRuntimes ?? 4
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) throw new RangeError('Invalid index runtime limit')
  const runtimes = new Map<string, Runtime>()
  const rebuilds = new Map<string, Selection>()
  const requests = new Set<AbortController>()
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
  function current(path: string): Selection {
    const value = options.policies.current(path)
    return { value, id: identity(value) }
  }
  const inactiveReason = () => options.policies.enabled()
    ? 'Build or update this PDF\'s semantic index in the search panel before searching.'
    : 'Semantic search is disabled in PDF settings.'
  function refresh() {
    if (!options.policies.enabled()) {
      rebuilds.clear()
      for (const request of requests) request.abort(Object.assign(new Error('Semantic search is disabled in PDF settings.'), { code: 'pdf/retrieval-engine-unavailable' }))
    }
    const paths = new Set(options.documents().flatMap(owner => owner.path ? [owner.path] : []))
    for (const path of rebuilds.keys()) if (!paths.has(path)) rebuilds.delete(path)
    options.policies.releaseUnused(paths)
  }
  async function owned<Result>(sessionId: string, documentId: string,
    operation: (owner: OpenWorkingCopyDocument & { path: string }) => Promise<Result>): Promise<Result> {
    const owner = document(sessionId, documentId)
    try { return await operation(owner) } finally { refresh() }
  }
  async function use<Result>(binding: Selection, signal: AbortSignal, operation: (api: PdfRetrieval, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    check()
    const controller = new AbortController(), active = AbortSignal.any([signal, controller.signal])
    requests.add(controller)
    const acquired = allocations.then(async () => {
      check()
      active.throwIfAborted()
      if (!options.policies.enabled()) fail('pdf/retrieval-engine-unavailable', 'Semantic search is disabled in PDF settings.')
      let runtime = runtimes.get(binding.id)
      if (runtime?.retired) {
        if (runtime.users) fail('pdf/retrieval-busy', 'The previous index engine is finishing a request. Retry shortly.')
        runtimes.delete(binding.id); await runtime.api.dispose(); runtime = undefined
      }
      if (!runtime) {
        if (runtimes.size >= maximum) {
          const oldest = [...runtimes].filter(([, value]) => !value.users).sort((a, b) => a[1].used - b[1].used)[0]
          if (!oldest) fail('pdf/retrieval-busy', 'PDF index engines are busy. Retry shortly.')
          runtimes.delete(oldest[0]); await oldest[1].api.dispose()
        }
        check()
        runtime = { api: options.create(structuredClone(binding.value)), users: 0, used: 0, binding: identity(binding.value) }
        runtimes.set(binding.id, runtime)
      }
      runtime.users++; runtime.used = ++clock
      return runtime
    })
    allocations = acquired.then(() => {}, () => {})
    try {
      const runtime = await acquired
      try {
        active.throwIfAborted()
        const result = await operation(runtime.api, active)
        active.throwIfAborted()
        return result
      } finally { runtime.users--; runtime.used = ++clock }
    } finally { requests.delete(controller) }
  }
  async function stage(sessionId: string, documentId: string, force = false) {
    return owned(sessionId, documentId, async owner => {
      await options.policies.settled(owner.path)
      check()
      const value = options.policies.current(owner.path), key = identity(value)
      if (value.policy.embeddingEngine === 'none') {
        rebuilds.delete(owner.path); changed()
        return
      }
      if (!force) return
      const previous = rebuilds.get(owner.path)
      if (previous && identity(previous.value) === key && (!previous.started || previous.inFlight || previous.incomplete)) return
      rebuilds.set(owner.path, { value, id: `${key}:${randomUUID()}`, force: true })
      changed()
    })
  }
  async function prepare(sessionId: string, input: RetrievalPrepareInput & { bindingId?: string }, signal: AbortSignal,
    onProgress: ((progress: RetrievalProgress) => void) | undefined, slice: boolean, occurrence?: object): Promise<boolean> {
    return owned(sessionId, input.documentId, async owner => {
      await options.policies.settled(owner.path)
      if (options.policies.current(owner.path).policy.embeddingEngine === 'none') {
        fail('pdf/retrieval-engine-unavailable', 'Semantic search is disabled in PDF settings.')
      }
      const staged = rebuilds.get(owner.path)
      const candidate = staged && identity(staged.value) === identity(options.policies.current(owner.path)) ? staged : undefined
      if (staged && !candidate) rebuilds.delete(owner.path)
      const binding = candidate ?? current(owner.path)
      if (input.bindingId && input.bindingId !== binding.id) fail('pdf/stale-reader', 'The queued PDF index configuration has changed.')
      binding.started = true
      binding.incomplete = false
      binding.inFlight = (binding.inFlight ?? 0) + 1
      try {
        const complete = await use(binding, signal, async (api, active) => {
          const request = { documentId: input.documentId,
            ...(input.fromPage ? { fromPage: input.fromPage } : {}), ...(input.maxPages ? { maxPages: input.maxPages } : {}),
            ...(binding.force ? { rebuild: true, rebuildToken: binding.id } : {}) }
          if (slice && api.prepareSlice) return api.prepareSlice(sessionId, request, active, onProgress, occurrence)
          await api.prepare(sessionId, request, active, onProgress)
          return true
        })
        signal.throwIfAborted()
        binding.incomplete = !complete
        if (options.policies.current(owner.path).policy.embeddingEngine === 'none') {
          fail('pdf/retrieval-engine-unavailable', 'Semantic search was disabled during indexing.')
        }
        if (candidate) {
          if (rebuilds.get(owner.path) !== candidate) fail('pdf/stale-reader', 'The PDF index update was superseded.')
          if (complete) {
            signal.throwIfAborted()
            for (const [id, runtime] of runtimes) {
              if (id !== binding.id && runtime.binding === identity(binding.value)) runtime.retired = true
            }
            rebuilds.delete(owner.path); changed()
          }
        }
        return complete
      } finally { binding.inFlight-- }
    })
  }
  return {
    refresh,
    selection(owner: OpenWorkingCopyDocument) {
      check()
      if (!owner.path) return undefined
      if (options.policies.current(owner.path).policy.embeddingEngine === 'none') return undefined
      const staged = rebuilds.get(owner.path)
      const binding = staged && identity(staged.value) === identity(options.policies.current(owner.path)) ? staged : current(owner.path)
      return binding.value.policy.embeddingEngine === 'none' ? undefined : { identity: binding.id, bindingId: binding.id }
    },
    settings(sessionId: string, documentId: string) {
      const owner = document(sessionId, documentId)
      return options.policies.snapshot(owner.path, documentId)
    },
    async configure(sessionId: string, documentId: string, revision: number, policy?: PdfDocumentIndexPolicy) {
      return owned(sessionId, documentId, async owner => {
        if (policy) await options.policies.configure(owner.path, revision, policy)
        else await options.policies.defaults(owner.path, revision)
      })
    },
    stage,
    async availability(sessionId: string, signal: AbortSignal, documentId?: string) {
      signal.throwIfAborted()
      if (!documentId) return { status: 'unavailable' as const, reason: 'Choose an opened PDF to inspect its index configuration.' }
      return owned(sessionId, documentId, async owner => {
        await options.policies.settled(owner.path)
        const binding = current(owner.path)
        if (binding.value.policy.embeddingEngine === 'none') return { status: 'unavailable' as const, reason: inactiveReason() }
        const result = await use(binding, signal, (api, active) => api.availability(sessionId, active, documentId))
        if (current(owner.path).id !== binding.id) return { status: 'unavailable' as const,
          reason: 'PDF index settings changed during the capability check. Retry with the current document.' }
        return result
      })
    },
    async prepare(sessionId: string, input: RetrievalPrepareInput & { bindingId?: string }, signal: AbortSignal,
      onProgress?: (progress: RetrievalProgress) => void) {
      await prepare(sessionId, input, signal, onProgress, false)
    },
    prepareSlice: (sessionId: string, input: RetrievalPrepareInput & { bindingId?: string }, signal: AbortSignal,
      onProgress?: (progress: RetrievalProgress) => void, occurrence?: object) =>
      prepare(sessionId, input, signal, onProgress, true, occurrence),
    async search(sessionId: string, input: Parameters<PdfRetrieval['search']>[1], signal: AbortSignal) {
      return owned(sessionId, input.documentId, async owner => {
        await options.policies.settled(owner.path)
        const binding = current(owner.path)
        if (binding.value.policy.embeddingEngine === 'none') fail('pdf/retrieval-engine-unavailable', inactiveReason())
        const result = await use(binding, signal, (api, active) => api.search(sessionId, input, active))
        if (current(owner.path).id !== binding.id) fail('pdf/stale-reader', 'PDF index settings changed during this search. Start a new search.')
        return result
      })
    },
    cancelSession(sessionId: string) { for (const runtime of runtimes.values()) runtime.api.cancelSession(sessionId) },
    rebuild() {
      if (reset) return reset
      if (closed) return Promise.reject(new Error('PDF indexing is closed.'))
      reset = allocations.then(async () => {
        const results = await Promise.allSettled([...runtimes.values()].map(value => value.api.dispose()))
        runtimes.clear(); rebuilds.clear()
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
        runtimes.clear(); rebuilds.clear()
        await options.policies.dispose()
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'PDF index runtimes did not fully close')
      })()
      return disposal
    },
  }
}
