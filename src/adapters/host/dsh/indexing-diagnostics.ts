import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { indexingProgressSchema } from '../../../contracts/indexing.js'
import type { RetrievalProgress } from '../../../modules/retrieval/index.js'
import { withIndexPerformance, type IndexPerformanceMetric } from '../../../modules/retrieval/index.js'

export type IndexingCancellationReason = 'user' | 'replaced' | 'closed' | 'suspended' | 'disposed' | 'configuration'
export interface PrefetchDiagnosticEvent {
  sessionId: string
  documentId: string
  occurrence: number
  event: 'queued' | 'started' | 'progress' | 'ready' | 'failed' | 'cancelled'
  progress?: RetrievalProgress
  error?: unknown
  reason?: IndexingCancellationReason
}
export interface IndexingDiagnosticActivity {
  page?: number
  layer: 'native' | 'ocr' | 'image' | 'render' | 'embedding'
  event: 'started' | 'ready' | 'failed'
  error?: unknown
}
interface Failure {
  category: 'network' | 'timeout' | 'engine' | 'source' | 'native' | 'resource' | 'storage' | 'unknown'
  code: string
  message: string
  causes: Array<{ name: string; code?: string; status?: number }>
  budget?: { kind: 'memory' | 'page' | 'chunks' | 'record' | 'indexes'; limit: number; used: number; requested: number }
}
interface TimelineEvent {
  at: string
  elapsedMs: number
  event: PrefetchDiagnosticEvent['event'] | 'activity' | 'failure-detail'
  progress?: RetrievalProgress
  failure?: Failure
  reason?: IndexingCancellationReason
  activity?: Omit<IndexingDiagnosticActivity, 'error'>
  performance?: IndexingPerformanceSummary
}
export interface IndexingPerformanceSummary {
  /** Time in active preparation slices, excluding scheduler queue/yield time. */
  activeMs: number
  stages: Record<string, { calls: number; totalMs: number; maxMs: number; bytes: number; records: number; cacheHits: number; requests: number }>
}
export interface IndexingDiagnosticAttempt {
  runId: string
  occurrence: number
  state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
  startedAt: string
  updatedAt: string
  elapsedMs: number
  progress?: RetrievalProgress
  failure?: Failure
  cancellationReason?: IndexingCancellationReason
  currentActivity?: Omit<IndexingDiagnosticActivity, 'error'>
  performance: IndexingPerformanceSummary
  events: TimelineEvent[]
}
export interface IndexingDiagnosticReport {
  version: 1
  logDirectory: string
  task: IndexingDiagnosticAttempt
  previousAttempts: IndexingDiagnosticAttempt[]
  logFailureCode?: string
}
interface StoredAttempt {
  sessionId: string
  documentId: string
  started: number
  lastProgress: number
  lastActivity: number
  activeRuns: Set<object>
  activeSince?: number
  lastFailure?: Failure
  attempt: IndexingDiagnosticAttempt
}

// Provider messages, stacks, request bodies and arbitrary enumerable properties
// are not diagnostic input: they can include PDF text, credentials or prompts.
function own(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object') return undefined
  try { return Object.getOwnPropertyDescriptor(error, key)?.value } catch { return undefined }
}
const engineErrorCodes = new Set(['disabled', 'not-configured', 'engine-unavailable', 'dependency-unavailable',
  'authentication-failed', 'timeout', 'cancelled', 'recognition-failed', 'invalid-request', 'invalid-result', 'limit-exceeded'])
const safeCode = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 128
  && (engineErrorCodes.has(value) || /^(?:[a-z][a-z-]*\/[a-zA-Z0-9/_.:-]+|E[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/.test(value)) ? value : undefined
const domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')!.get!
function errorName(error: unknown): string {
  try {
    let current = error
    for (let depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name')
      const value: unknown = descriptor && 'value' in descriptor ? descriptor.value
        : current === DOMException.prototype ? domExceptionName.call(error) : undefined
      if (typeof value === 'string') return /^(?:Error|TypeError|RangeError|SyntaxError|AbortError|TimeoutError|AggregateError|EmbeddingError|OcrError|ImageUnderstandingError)$/.test(value) ? value : 'Error'
      current = Object.getPrototypeOf(current)
    }
  } catch { /* Unknown prototypes and getters are never trusted diagnostic input. */ }
  return 'Error'
}
function classify(error: unknown): Failure {
  const causes: Failure['causes'] = [], seen = new Set<unknown>()
  let budget: Failure['budget']
  for (let current: unknown = error; current && !seen.has(current) && causes.length < 4; current = own(current, 'cause')) {
    seen.add(current)
    const name = errorName(current)
    const code = safeCode(own(current, 'code'))
    const rawStatus = own(current, 'status') ?? own(current, 'statusCode')
    const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
    causes.push({ name, ...(code ? { code } : {}), ...(status ? { status } : {}) })
    const value = own(current, 'budget')
    const kind = own(value, 'kind'), limit = own(value, 'limit'), used = own(value, 'used'), requested = own(value, 'requested')
    if (!budget && code?.startsWith('pdf/') && typeof kind === 'string' && ['memory', 'page', 'chunks', 'record', 'indexes'].includes(kind)
      && typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0
      && typeof used === 'number' && Number.isSafeInteger(used) && used >= 0
      && typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0) {
      budget = { kind: kind as NonNullable<Failure['budget']>['kind'], limit, used, requested }
    }
  }
  const code = causes.find(cause => cause.code)?.code ?? 'pdf/retrieval-prefetch-failed'
  const identifiers = causes.map(cause => `${cause.name}:${cause.code ?? ''}:${cause.status ?? ''}`).join(' ').toLowerCase()
  const category: Failure['category'] = /pdf\/index-storage-|enospc|edquot|erofs/.test(identifiers) ? 'storage'
    : /pdf\/retrieval-[a-z-]*budget|out.of.memory/.test(identifiers) ? 'resource'
      : /timeout|timedout/.test(identifiers) ? 'timeout'
    : /econn|enet|ehost|enotfound|eai_|fetch|network|http|:429|:50[0-9]/.test(identifiers) ? 'network'
      : /engine|model|embedding|ocr|image/.test(identifiers) ? 'engine'
        : /source|stale|conflict|document|enoent|eacces/.test(identifiers) ? 'source'
          : /native|pdfium|worker|subprocess/.test(identifiers) ? 'native' : 'unknown'
  const messages: Record<Failure['category'], string> = {
    resource: 'An indexing resource limit was exceeded. Inspect the recorded budget and resume after resolving it.',
    storage: 'The persistent index could not be read or written. Check storage availability before resuming.',
    timeout: 'The operation exceeded its time limit.', network: 'The engine connection or remote request failed.',
    engine: 'The selected engine could not complete this operation.', source: 'The document source or access changed during indexing.',
    native: 'The native PDF worker could not complete this operation.', unknown: 'Indexing failed; inspect the error codes and last recorded activity.',
  }
  return { category, code, message: messages[category], causes, ...(budget ? { budget } : {}) }
}

/** Run-scoped diagnostic history observes indexing but never owns or retries it. */
export function createIndexingDiagnostics(options: {
  log: { directory: string; append(event: Readonly<Record<string, unknown>>): void; failureCode(): string | undefined }
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const attempts = new Map<string, StoredAttempt>()
  let disposed = false
  const scope = new AsyncLocalStorage<{ key: string; runId: string } | undefined>()
  const key = (sessionId: string, documentId: string, occurrence: number) => JSON.stringify([sessionId, documentId, occurrence])
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const terminal = (attempt: IndexingDiagnosticAttempt) => ['ready', 'failed', 'cancelled'].includes(attempt.state)
  function append(stored: StoredAttempt, event: TimelineEvent) {
    // The report already owns the latest summary; only the durable terminal
    // record duplicates it, so large histories keep their transport budget.
    const { performance: _performance, ...timeline } = event
    stored.attempt.events.push(timeline)
    // Keep the queue/start context and the most recent details, including failure.
    if (stored.attempt.events.length > 32) stored.attempt.events.splice(2, 1)
    try { options.log.append({ version: 1, runId: stored.attempt.runId, occurrence: stored.attempt.occurrence,
      sessionKey: digest(stored.sessionId), documentKey: digest(stored.documentId), ...event }) } catch { /* Logging cannot own indexing. */ }
  }
  function touch(stored: StoredAttempt): Pick<TimelineEvent, 'at' | 'elapsedMs'> {
    const timestamp = Math.max(stored.started, now())
    stored.attempt.updatedAt = new Date(timestamp).toISOString()
    stored.attempt.elapsedMs = timestamp - stored.started
    return { at: stored.attempt.updatedAt, elapsedMs: stored.attempt.elapsedMs }
  }
  const boundedSum = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right)
  function activeMs(stored: StoredAttempt): number {
    return boundedSum(stored.attempt.performance.activeMs,
      stored.activeSince === undefined ? 0 : Math.max(0, now() - stored.activeSince))
  }
  function finishActive(stored: StoredAttempt): void {
    stored.attempt.performance.activeMs = activeMs(stored)
    stored.activeSince = undefined
  }
  function observe(stored: StoredAttempt, token: object, metric: IndexPerformanceMetric): void {
    if (disposed || !stored.activeRuns.has(token) || terminal(stored.attempt)
      || attempts.get(key(stored.sessionId, stored.documentId, stored.attempt.occurrence)) !== stored) return
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(metric.stage) || !Number.isFinite(metric.durationMs) || metric.durationMs < 0) return
    const stages = stored.attempt.performance.stages
    if (!Object.hasOwn(stages, metric.stage) && Object.keys(stages).length >= 32) return
    const stage = Object.hasOwn(stages, metric.stage) ? stages[metric.stage]!
      : stages[metric.stage] = { calls: 0, totalMs: 0, maxMs: 0, bytes: 0, records: 0, cacheHits: 0, requests: 0 }
    stage.calls = boundedSum(stage.calls, 1)
    stage.totalMs = boundedSum(stage.totalMs, metric.durationMs)
    stage.maxMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(stage.maxMs, metric.durationMs))
    for (const counter of ['bytes', 'records', 'requests'] as const) {
      const value = metric[counter]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) stage[counter] = boundedSum(stage[counter], value)
    }
    if (metric.cacheHit === true) stage.cacheHits = boundedSum(stage.cacheHits, 1)
  }
  const running = (sessionId: string, documentId: string) => [...attempts.values()].reverse().find(value => value.sessionId === sessionId
    && value.documentId === documentId && value.attempt.state === 'running')
  function scoped(sessionId: string, documentId: string): StoredAttempt | undefined {
    const current = scope.getStore()
    if (!current) return undefined
    const stored = attempts.get(current.key)
    return stored?.sessionId === sessionId && stored.documentId === documentId
      && stored.attempt.runId === current.runId && stored.attempt.state === 'running' ? stored : undefined
  }
  return {
    /** Only work started inside this preparation may contribute page/failure detail. */
    run<T>(sessionId: string, documentId: string, operation: () => Promise<T>): Promise<T> {
      if (disposed) return operation()
      const stored = running(sessionId, documentId)
      return scope.run(stored ? { key: key(sessionId, documentId, stored.attempt.occurrence), runId: stored.attempt.runId } : undefined,
        () => {
          // A nested foreground operation must not inherit another run's metric owner.
          if (!stored) return withIndexPerformance(() => {}, operation)
          const token = {}
          if (!stored.activeRuns.size) stored.activeSince = now()
          stored.activeRuns.add(token)
          return withIndexPerformance(metric => observe(stored, token, metric), async () => {
            try { return await operation() }
            finally {
              if (stored.activeRuns.delete(token) && !stored.activeRuns.size) finishActive(stored)
            }
          })
        })
    },
    failure(sessionId: string, documentId: string, error: unknown): void {
      const stored = scoped(sessionId, documentId)
      if (!stored) return
      stored.lastFailure = classify(error)
      append(stored, { ...touch(stored), event: 'failure-detail', failure: stored.lastFailure,
        ...(stored.attempt.currentActivity ? { activity: { ...stored.attempt.currentActivity } } : {}) })
    },
    record(event: PrefetchDiagnosticEvent): void {
      if (disposed) return
      const id = key(event.sessionId, event.documentId, event.occurrence)
      let stored = attempts.get(id)
      if (!stored) {
        const started = now(), timestamp = new Date(started).toISOString()
        stored = { sessionId: event.sessionId, documentId: event.documentId, started, lastProgress: -Infinity, lastActivity: -Infinity, activeRuns: new Set(),
          attempt: { runId: randomUUID(), occurrence: event.occurrence, state: 'queued', startedAt: timestamp,
            updatedAt: timestamp, elapsedMs: 0, performance: { activeMs: 0, stages: {} }, events: [] } }
        attempts.set(id, stored)
        while (attempts.size > 64) {
          const retired = [...attempts].find(([, value]) => terminal(value.attempt)) ?? attempts.entries().next().value!
          attempts.delete(retired[0])
        }
      }
      if (terminal(stored.attempt)) return
      const at = touch(stored)
      if (event.progress) {
        const parsed = indexingProgressSchema.safeParse(event.progress)
        if (parsed.success) stored.attempt.progress = parsed.data
      }
      if (event.event === 'progress') {
        if (now() - stored.lastProgress < 2000) return
        stored.lastProgress = now()
      }
      if (event.event === 'started') stored.attempt.state = 'running'
      else if (event.event === 'ready' || event.event === 'failed' || event.event === 'cancelled') stored.attempt.state = event.event
      if (terminal(stored.attempt)) { finishActive(stored); stored.activeRuns.clear() }
      if (event.event === 'failed') {
        const failure = classify(event.error)
        const previous = stored.lastFailure
        const probeFailure = failure.code === 'pdf/retrieval-engine-unavailable'
          && previous && ['engine-unavailable', 'not-configured', 'timeout'].includes(previous.code)
        stored.attempt.failure = previous && (previous.code === failure.code || probeFailure) ? previous : failure
      }
      if (event.reason) stored.attempt.cancellationReason = event.reason
      append(stored, { ...at, event: event.event,
        ...(stored.attempt.progress ? { progress: { ...stored.attempt.progress } } : {}),
        ...(event.event === 'failed' ? { failure: stored.attempt.failure } : {}), ...(event.reason ? { reason: event.reason } : {}),
        ...(terminal(stored.attempt) ? { performance: structuredClone(stored.attempt.performance) } : {}),
        ...(stored.attempt.currentActivity ? { activity: { ...stored.attempt.currentActivity } } : {}) })
    },
    activity(sessionId: string, documentId: string, activity: IndexingDiagnosticActivity): void {
      const stored = scoped(sessionId, documentId)
      if (!stored) return
      const at = touch(stored)
      stored.attempt.currentActivity = { ...(activity.page === undefined ? {} : { page: activity.page }),
        layer: activity.layer, event: activity.event }
      if (activity.event !== 'failed' && now() - stored.lastActivity < 2000) return
      stored.lastActivity = now()
      append(stored, { ...at, event: 'activity', activity: { ...stored.attempt.currentActivity },
        ...(activity.event === 'failed' ? { failure: classify(activity.error) } : {}) })
    },
    read(sessionId: string, documentId: string, occurrence: number): IndexingDiagnosticReport {
      const stored = attempts.get(key(sessionId, documentId, occurrence))
      if (!stored) throw Object.assign(new Error('This indexing attempt is no longer retained. Open the log directory for older attempts.'),
        { code: 'pdf/index-diagnostics-unavailable' })
      const previous = [...attempts.values()].filter(value => value !== stored && value.sessionId === sessionId
        && value.documentId === documentId && value.attempt.occurrence < occurrence).reverse().slice(0, 5)
      let failureCode: string | undefined
      try { failureCode = options.log.failureCode() } catch { failureCode = 'pdf/index-log-unavailable' }
      return structuredClone({ version: 1, logDirectory: options.log.directory,
        task: { ...stored.attempt, performance: { ...stored.attempt.performance, activeMs: activeMs(stored) } },
        previousAttempts: previous.map(value => ({ ...value.attempt, events: value.attempt.events.slice(-8) })),
        ...(failureCode ? { logFailureCode: failureCode } : {}) })
    },
    dispose(): void {
      disposed = true
      attempts.clear()
      scope.disable()
    },
  }
}
