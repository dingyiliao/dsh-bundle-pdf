import { TranslationError, type TranslationEngine } from './types.js'

export function createNoneTranslationEngine(): TranslationEngine {
  return {
    descriptor: { id: 'none', name: 'NoneTranslation', version: '1', execution: 'disabled' },
    availability: () => ({ status: 'disabled', reason: 'Translation is disabled in PDF settings.' }),
    async translate() {
      throw new TranslationError('disabled', 'Select a translation engine in PDF settings.')
    },
  }
}
