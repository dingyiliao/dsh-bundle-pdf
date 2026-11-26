import { createRetrievalStore } from '../../../layers/derived/storage/index.js'
import { recordIndexPerformance } from '../../../shared/indexing-performance-runtime.js'

export function createIndexingCache(options: { directory: string }) {
  const cache = createRetrievalStore({ directory: options.directory,
    maxRecordBytes: 64 * 1024 * 1024, onMetric: recordIndexPerformance })
  return { cache, dispose: () => cache.dispose() }
}
