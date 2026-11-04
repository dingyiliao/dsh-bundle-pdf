export interface SessionModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelSession {
  id?: string
  requestHeader?(): { config: SessionModelRoute; adapterDefaults?: { reasoningEffort?: boolean } } | undefined
}

/** Resolve the current selection on Host without inspecting session messages. */
export interface SessionModelRouteContext {
  sessionController: {
    resolveAgent(sessionId: string): Promise<{ agent: { session: ModelSession } } | { error: unknown }>
  }
  get(key: 'sessionProjections'): {
    stateOf(session: unknown, name: 'modelSelection'): { pending: SessionModelRoute | null } | undefined
  } | undefined
  get(key: 'agentDefaultModel'): { currentSelection(): SessionModelRoute } | undefined
}

/** Consumers translate routing failures to their own feature's public error contract. */
export class SessionModelRouteError extends Error {
  constructor(readonly code: 'session-unavailable' | 'model-unavailable', options?: ErrorOptions) {
    super(code === 'session-unavailable' ? 'The session is unavailable.' : 'No session model is available.', options)
    this.name = 'SessionModelRouteError'
  }
}

export async function resolveSessionModel(ctx: SessionModelRouteContext, sessionId: string,
  signal?: AbortSignal): Promise<SessionModelRoute> {
  signal?.throwIfAborted()
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  signal?.throwIfAborted()
  if ('error' in resolved) throw new SessionModelRouteError('session-unavailable')
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
    throw new SessionModelRouteError('model-unavailable', { cause })
  }
}
