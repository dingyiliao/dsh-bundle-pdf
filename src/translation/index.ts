export * from './types.js'
export * from './registry.js'
export * from './service.js'
export * from './none.js'

import { createNoneTranslationEngine } from './none.js'
import { TranslationRegistry } from './registry.js'
import type { TranslationLimits } from './types.js'

/** The default engine sends no text anywhere until a configured engine is selected. */
export function createTranslationRegistry(limits: TranslationLimits): TranslationRegistry {
  const registry = new TranslationRegistry(limits)
  registry.register(createNoneTranslationEngine())
  registry.select({ id: 'none', engineId: 'none', configurationRevision: '1', config: {} })
  return registry
}
