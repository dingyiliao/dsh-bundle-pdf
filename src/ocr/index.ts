export * from './types.js'
export * from './registry.js'
export * from './none.js'
export { createLocalOcrEngine, normalizeTesseractOutput } from './local.js'
export type { LocalOcrOptions, LocalOcrDependencies, LocalWorkerOptions } from './local.js'
export * from './mapping.js'
export * from './cache.js'

import { createLocalOcrEngine, type LocalOcrOptions } from './local.js'
import { createNoneOcrEngine } from './none.js'
import { OcrRegistry } from './registry.js'

export function createOcrRegistry(local: LocalOcrOptions = {}): OcrRegistry {
  const registry = new OcrRegistry()
  registry.register(createNoneOcrEngine())
  registry.register(createLocalOcrEngine(local))
  registry.select({ id: 'none', engineId: 'none', configurationRevision: '1', config: {} })
  return registry
}
