import type {} from '@deepseek-ai/cordis'
import type { PdfSettings } from '../../shared/contracts.js'
import type { TranslationRegistry } from '../translation/sdk/index.js'
import type { EmbeddingRegistry } from '../embedding/sdk/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pdfAiSettings: () => PdfSettings
    pdfTranslation: TranslationRegistry
    pdfEmbedding: EmbeddingRegistry
  }
}
export {}
