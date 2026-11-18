/** Metadata-only timing event for derived-index work and its engine/native dependencies. */
export interface IndexPerformanceMetric {
  stage: string
  durationMs: number
  bytes?: number
  records?: number
  cacheHit?: boolean
  requests?: number
}
