import { z } from 'zod'
import { createTranslationRegistry, TranslationError } from '../translation/index.js'
import { createDshModelTranslationEngine, type DshTranslationModelRoute, type DshTranslationLlm } from './translation-model.js'
import { effectiveTranslationEngine, translationSourceLanguage, translationTargetLanguages, type PdfSettings } from '../shared/contracts.js'
import type { PdfAgent, PdfDispatch } from './transport.js'

interface ModelSession {
  requestHeader?(): { config: DshTranslationModelRoute; adapterDefaults?: { reasoningEffort?: boolean } } | undefined
}
export interface TranslationHostContext {
  get(key: 'llm'): DshTranslationLlm | undefined
  get(key: 'sessionProjections'): { stateOf(session: unknown, name: 'modelSelection'): { pending: DshTranslationModelRoute | null } | undefined } | undefined
  get(key: 'agentDefaultModel'): { currentSelection(): DshTranslationModelRoute } | undefined
  sessionController: { resolveAgent(sessionId: string): Promise<{ agent: PdfAgent } | { error: unknown }> }
}

const inputSchema = z.object({
  sessionId: z.string().min(1).max(512), engineId: z.string().min(1).max(200),
  text: z.string().min(1).max(8192), sourceLanguage: z.literal(translationSourceLanguage),
  targetLanguage: z.enum(translationTargetLanguages), timeoutMs: z.number().int().min(1000).max(600000),
  context: z.object({ sessionId: z.string(), documentId: z.string().max(512).optional(),
    contentVersion: z.string().max(512).optional(), pages: z.array(z.number().int().positive()).max(200).optional() }).optional(),
})

/** Translation adapters use Host model services; the PDF editor only knows this registry. */
export function createHostTranslations(ctx: TranslationHostContext, namespace: string, readSettings: () => PdfSettings) {
  const registry = createTranslationRegistry({ timeoutMs: 600000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })
  const modelEngine = createDshModelTranslationEngine({
    // Optional services are resolved at the operation boundary. Reading PDFs
    // remains available when a minimal profile has no model composition.
    llm: { stream(options) {
      const llm = ctx.get('llm')
      if (!llm) throw new TranslationError('engine-unavailable', 'The DSH model service is unavailable.')
      return llm.stream(options)
    } }, maxOutputTokens: 4096,
    async resolveContext(sessionId, signal) {
      signal?.throwIfAborted()
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw new TranslationError('not-configured', 'The PDF session is unavailable.')
      signal?.throwIfAborted()
      const session = resolved.agent.session as ModelSession
      const pending = ctx.get('sessionProjections')?.stateOf(resolved.agent.session, 'modelSelection')?.pending
      if (pending) return { ...pending }
      const header = session.requestHeader?.()
      if (header) return { provider: header.config.provider, model: header.config.model,
        ...(header.config.reasoningEffort && !header.adapterDefaults?.reasoningEffort ? { reasoningEffort: header.config.reasoningEffort } : {}) }
      try {
        const model = ctx.get('agentDefaultModel')
        if (!model) throw new TranslationError('not-configured', 'Choose a DSH model before translating.')
        return model.currentSelection()
      }
      catch (cause) { throw new TranslationError('not-configured', 'Choose a DSH model before translating.', { cause }) }
    },
  })
  registry.register({ ...modelEngine, availability: () => ctx.get('llm')
    ? { status: 'available' } : { status: 'unavailable', reason: 'The DSH model service is unavailable.' } })
  const dispatch: PdfDispatch = async (sessionId, input, _agent, signal) => {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) throw new TranslationError('invalid-request', 'Translation requires up to 8192 characters and valid languages.')
    const request = parsed.data
    if (request.sessionId !== sessionId || (request.context && request.context.sessionId !== sessionId)) {
      throw new TranslationError('invalid-request', 'Translation session identity mismatch.')
    }
    const settings = readSettings()
    const engineId = effectiveTranslationEngine(settings.translationEngine)
    if (request.engineId !== engineId) throw new TranslationError('stale-result', 'Translation settings changed. Retry the selection.')
    const revision = JSON.stringify([engineId, settings.translationTimeoutMs])
    registry.select({ id: `${namespace}/${engineId}`, engineId,
      configurationRevision: revision, config: {} })
    const result = await registry.translate({ text: request.text, sourceLanguage: translationSourceLanguage, targetLanguage: request.targetLanguage,
      timeoutMs: Math.min(request.timeoutMs, settings.translationTimeoutMs), signal,
      context: { ...request.context, sessionId } })
    signal.throwIfAborted()
    const current = readSettings()
    if (revision !== JSON.stringify([effectiveTranslationEngine(current.translationEngine), current.translationTimeoutMs])) {
      throw new TranslationError('stale-result', 'Translation settings changed. Retry the selection.')
    }
    return result
  }
  return { registry, dispatch }
}
