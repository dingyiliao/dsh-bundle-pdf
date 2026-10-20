export * from './types.js'
export * from './registry.js'
export * from './service.js'
export { translationEn, translationZh } from './locales.js'

import { TranslationRegistry } from './registry.js'
import type { TranslationLimits } from './types.js'

/** Create an engine directory; the host/client selects the configured engine. */
export function createTranslationRegistry(limits: TranslationLimits): TranslationRegistry {
  return new TranslationRegistry(limits)
}
