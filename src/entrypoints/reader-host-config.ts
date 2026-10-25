import z from '@deepseek-ai/schemastery'
import { defaultSettings, effectiveTranslationEngine, translationTargetLanguages, type PdfSettings } from '../shared/contracts.ts'
import { explanationTemplatePattern, MAX_EXPLANATION_PROMPT_TEMPLATE_LENGTH,
  MAX_EXPLANATION_INSTRUCTION_LENGTH } from '../shared/explanation-template.ts'
import { engineConfigurationsSchema } from '../modules/engines/index.js'

export const Config = z.object({
  ocrEngine: z.string().pattern(/\S/).default('session-llm').volatile(),
  imageEngine: z.string().pattern(/\S/).default('session-vision').volatile(),
  engineConfigurations: z.dict(z.dict(z.dict(z.union([z.string(), z.number(), z.boolean()])))).default({}).volatile(),
  ocrTimeoutMs: z.natural().min(1000).max(600000).default(defaultSettings.ocrTimeoutMs).volatile(),
  translationEngine: z.string().pattern(/\S/).default(defaultSettings.translationEngine).volatile(),
  translationTargetLanguage: z.string().pattern(new RegExp(`^(?:${translationTargetLanguages.join('|')})$`))
    .default(defaultSettings.translationTargetLanguage).volatile(),
  translationTimeoutMs: z.natural().min(1000).max(600000).default(defaultSettings.translationTimeoutMs).volatile(),
  historyCapacity: z.natural().min(1).max(1000).default(defaultSettings.historyCapacity).volatile(),
  maxFileBytes: z.natural().min(1048576).max(268435456).default(defaultSettings.maxFileBytes).volatile(),
  explanationGeneralInstruction: z.string().max(MAX_EXPLANATION_INSTRUCTION_LENGTH).default('').volatile(),
  explanationTextInstruction: z.string().max(MAX_EXPLANATION_INSTRUCTION_LENGTH).default('').volatile(),
  explanationImageInstruction: z.string().max(MAX_EXPLANATION_INSTRUCTION_LENGTH).default('').volatile(),
  explanationPromptTemplate: z.string().max(MAX_EXPLANATION_PROMPT_TEMPLATE_LENGTH)
    .pattern(explanationTemplatePattern).default(defaultSettings.explanationPromptTemplate).volatile(),
})
export type HostConfig = ReturnType<typeof Config>

export function readConfig(config: HostConfig): PdfSettings {
  // Drop only the removed form-engine selection; all active engine kinds still
  // pass the strict configuration schema and retain their saved values.
  const engineConfigurations = { ...(config.engineConfigurations?.get() ?? {}) }
  delete engineConfigurations.form
  return {
    ocrEngine: config.ocrEngine?.get() ?? defaultSettings.ocrEngine,
    imageEngine: config.imageEngine?.get() ?? defaultSettings.imageEngine,
    engineConfigurations: engineConfigurationsSchema.parse(engineConfigurations),
    ocrTimeoutMs: config.ocrTimeoutMs.get(),
    translationEngine: effectiveTranslationEngine(config.translationEngine.get()),
    translationTargetLanguage: config.translationTargetLanguage.get(), translationTimeoutMs: config.translationTimeoutMs.get(),
    historyCapacity: config.historyCapacity.get(), maxFileBytes: config.maxFileBytes.get(),
    explanationGeneralInstruction: config.explanationGeneralInstruction.get(),
    explanationTextInstruction: config.explanationTextInstruction.get(),
    explanationImageInstruction: config.explanationImageInstruction.get(),
    explanationPromptTemplate: config.explanationPromptTemplate.get(),
  }
}
