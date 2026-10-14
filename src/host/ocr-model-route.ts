import { OcrError } from '../ocr/types.js'

export interface OcrModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelSession {
  requestHeader?(): { config: OcrModelRoute; adapterDefaults?: { reasoningEffort?: boolean } } | undefined
}

/** Only the session identity is supplied by a caller; the route is resolved on Host. */
export interface OcrModelRouteContext {
  sessionController: {
    resolveAgent(sessionId: string): Promise<{ agent: { session: ModelSession } } | { error: unknown }>
  }
  get(key: 'sessionProjections'): {
    stateOf(session: unknown, name: 'modelSelection'): { pending: OcrModelRoute | null } | undefined
  } | undefined
  get(key: 'agentDefaultModel'): { currentSelection(): OcrModelRoute } | undefined
}

export async function resolveOcrSessionModel(
  ctx: OcrModelRouteContext, sessionId: string, signal: AbortSignal,
): Promise<OcrModelRoute> {
  signal.throwIfAborted()
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  signal.throwIfAborted()
  if ('error' in resolved) throw new OcrError('not-configured', 'The OCR session is unavailable.')
  const session = resolved.agent.session
  const pending = ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')?.pending
  if (pending) return { ...pending }
  const header = session.requestHeader?.()
  if (header) return {
    provider: header.config.provider, model: header.config.model,
    ...(header.config.reasoningEffort && !header.adapterDefaults?.reasoningEffort
      ? { reasoningEffort: header.config.reasoningEffort } : {}),
  }
  try {
    const model = ctx.get('agentDefaultModel')
    if (!model) throw new Error('No default model is available.')
    return { ...model.currentSelection() }
  } catch (cause) {
    throw new OcrError('not-configured', 'Choose a model for this session before using OCR.', { cause })
  }
}
