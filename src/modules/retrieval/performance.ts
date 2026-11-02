import { AsyncLocalStorage } from 'node:async_hooks'

export interface IndexPerformanceMetric {
  stage: string
  durationMs: number
  bytes?: number
  records?: number
  cacheHit?: boolean
  requests?: number
}

type Observer = (metric: IndexPerformanceMetric) => void
const scope = new AsyncLocalStorage<Observer>()

/** Measurements inherit the owning attempt, never document content or credentials. */
export function withIndexPerformance<T>(observer: Observer, operation: () => T): T {
  return scope.run(observer, operation)
}

export function recordIndexPerformance(metric: IndexPerformanceMetric): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(metric.stage) || !Number.isFinite(metric.durationMs) || metric.durationMs < 0) return
  try { scope.getStore()?.(metric) } catch { /* Observation cannot change index outcomes. */ }
}

export async function measureIndexOperation<T>(stage: string, operation: () => Promise<T>,
  counts: Pick<IndexPerformanceMetric, 'bytes' | 'records' | 'requests'> = {}): Promise<T> {
  const started = performance.now()
  try { return await operation() }
  finally { recordIndexPerformance({ stage, durationMs: performance.now() - started, ...counts }) }
}
