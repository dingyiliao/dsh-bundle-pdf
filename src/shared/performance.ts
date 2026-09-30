/** Opt-in component timings. No document text, paths, IDs or credentials are recorded. */
export type PdfPerformanceName =
  | 'host.inspect' | 'host.project' | 'host.materialize' | 'host.dispatch'
  | 'client.rpc' | 'client.worker-open' | 'client.raster' | 'client.search'

export type PdfPerformanceStatus = 'ok' | 'error' | 'cancelled'
export interface PdfPerformanceEvent {
  schemaVersion: 1
  name: PdfPerformanceName
  clockDomain: 'host' | 'client'
  startMs: number
  durationMs: number
  status: PdfPerformanceStatus
  attributes: Readonly<Record<string, number | boolean>>
}

const observers = new Set<(event: PdfPerformanceEvent) => void>()
const disabled = { end(_status?: PdfPerformanceStatus, _attributes?: Readonly<Record<string, number | boolean>>) {} }

/** The caller owns retention. Disposal prevents old observers receiving late completions. */
export function observePdfPerformance(observer: (event: PdfPerformanceEvent) => void): () => void {
  observers.add(observer)
  return () => { observers.delete(observer) }
}

export function beginPdfSpan(name: PdfPerformanceName, attributes: Readonly<Record<string, number | boolean>> = {}) {
  if (!observers.size) return disabled
  const targets = [...observers]
  const startMs = performance.now()
  let ended = false
  return {
    end(status: PdfPerformanceStatus = 'ok', extra: Readonly<Record<string, number | boolean>> = {}) {
      if (ended) return
      ended = true
      const event: PdfPerformanceEvent = Object.freeze({
        schemaVersion: 1, name, clockDomain: name.startsWith('client.') ? 'client' : 'host',
        startMs, durationMs: performance.now() - startMs, status,
        attributes: Object.freeze({ ...attributes, ...extra }),
      })
      for (const observer of targets) {
        if (!observers.has(observer)) continue
        try { observer(event) } catch { /* Instrumentation must not change PDF behavior. */ }
      }
    },
  }
}

export function measurePdfSync<T>(name: PdfPerformanceName, attributes: Readonly<Record<string, number | boolean>>, action: () => T): T {
  if (!observers.size) return action()
  const span = beginPdfSpan(name, attributes)
  try { const value = action(); span.end(); return value }
  catch (error) { span.end('error'); throw error }
}

export function measurePdfAsync<T>(name: PdfPerformanceName, attributes: Readonly<Record<string, number | boolean>>, action: () => Promise<T>): Promise<T> {
  if (!observers.size) return action()
  const span = beginPdfSpan(name, attributes)
  try {
    return action().then(value => { span.end(); return value }, error => {
      span.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error')
      throw error
    })
  } catch (error) { span.end('error'); throw error }
}
