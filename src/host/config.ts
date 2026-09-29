import z from '@deepseek-ai/schemastery'
import { defaultSettings, type PdfSettings } from '../shared/contracts.ts'

export type HostConfig = { [K in keyof PdfSettings]: { get(): PdfSettings[K] } }
export const Config = z.object({
  ocrEngine: z.string().default(defaultSettings.ocrEngine).volatile(),
  ocrLanguages: z.string().default(defaultSettings.ocrLanguages).volatile(),
  ocrTimeoutMs: z.natural().min(1000).max(600000).default(defaultSettings.ocrTimeoutMs).volatile(),
  translationEngine: z.string().pattern(/\S/).default(defaultSettings.translationEngine).volatile(),
  translationSourceLanguage: z.string().pattern(/^(?=[\s\S]*\S)[\s\S]{1,100}$/).default(defaultSettings.translationSourceLanguage).volatile(),
  translationTargetLanguage: z.string().pattern(/^(?=[\s\S]*\S)[\s\S]{1,100}$/).default(defaultSettings.translationTargetLanguage).volatile(),
  translationTimeoutMs: z.natural().min(1000).max(600000).default(defaultSettings.translationTimeoutMs).volatile(),
  defaultColor: z.string().pattern(/^#[0-9a-fA-F]{6}$/).default(defaultSettings.defaultColor).volatile(),
  historyCapacity: z.natural().min(1).max(1000).default(defaultSettings.historyCapacity).volatile(),
  maxFileBytes: z.natural().min(1048576).max(268435456).default(defaultSettings.maxFileBytes).volatile(),
})

export function readConfig(config: HostConfig): PdfSettings {
  return {
    ocrEngine: config.ocrEngine.get(), ocrLanguages: config.ocrLanguages.get(), ocrTimeoutMs: config.ocrTimeoutMs.get(),
    translationEngine: config.translationEngine.get(), translationSourceLanguage: config.translationSourceLanguage.get(),
    translationTargetLanguage: config.translationTargetLanguage.get(), translationTimeoutMs: config.translationTimeoutMs.get(),
    defaultColor: config.defaultColor.get(), historyCapacity: config.historyCapacity.get(), maxFileBytes: config.maxFileBytes.get(),
  }
}
