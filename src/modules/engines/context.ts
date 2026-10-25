import type {} from '@deepseek-ai/cordis'
import type { PdfSettings } from '../../shared/contracts.js'
import type { TranslationRegistry } from '../../translation/registry.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pdfAiSettings: () => PdfSettings
    pdfTranslation: TranslationRegistry
  }
}
export {}
