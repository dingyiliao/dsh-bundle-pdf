import z from '@deepseek-ai/schemastery'
import { defaultSettings, effectiveTranslationEngine, translationTargetLanguages, type PdfSettings } from '../shared/contracts.ts'

export const Config = z.object({
  ocrTimeoutMs: z.natural().min(1000).max(600000).default(defaultSettings.ocrTimeoutMs).volatile(),
  translationEngine: z.string().pattern(/\S/).default(defaultSettings.translationEngine).volatile(),
  translationTargetLanguage: z.string().pattern(new RegExp(`^(?:${translationTargetLanguages.join('|')})$`))
    .default(defaultSettings.translationTargetLanguage).volatile(),
  translationTimeoutMs: z.natural().min(1000).max(600000).default(defaultSettings.translationTimeoutMs).volatile(),
  historyCapacity: z.natural().min(1).max(1000).default(defaultSettings.historyCapacity).volatile(),
  maxFileBytes: z.natural().min(1048576).max(268435456).default(defaultSettings.maxFileBytes).volatile(),
})
export type HostConfig = ReturnType<typeof Config>

export function readConfig(config: HostConfig): PdfSettings {
  return {
    ocrTimeoutMs: config.ocrTimeoutMs.get(),
    translationEngine: effectiveTranslationEngine(config.translationEngine.get()),
    translationTargetLanguage: config.translationTargetLanguage.get(), translationTimeoutMs: config.translationTimeoutMs.get(),
    historyCapacity: config.historyCapacity.get(), maxFileBytes: config.maxFileBytes.get(),
  }
}
