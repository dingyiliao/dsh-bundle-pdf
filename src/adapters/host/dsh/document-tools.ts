import type { Context } from '@deepseek-ai/cordis'
import type { createWorkingCopyService } from '../../../modules/working-copy/index.js'

export interface PdfToolContext {
  get: Context['get']
  tools: Pick<Context['tools'], 'register'>
}

export interface PdfDocumentToolContext extends PdfToolContext {
  /** Fence a detached runtime generation, cancel its operations, then wait for quiescence. */
  cancelSession(sessionId: string, afterDrain?: () => Promise<void>): Promise<void>
  /** Stop admission and cancel/drain every tool before dependent services unload. */
  dispose(): Promise<void>
}

/** A document tool holds the shared copy through every await, including save approval. */
export function createDocumentToolContext(ctx: PdfToolContext,
  workspaces: Pick<ReturnType<typeof createWorkingCopyService>, 'acquire'>,
  options: {
    /** Resolve Host-owned handles before acquiring the same authorized document pin. */
    resolveDocumentId?: (tool: string, raw: unknown, sessionId: string) => string | undefined
  } = {}): PdfDocumentToolContext {
  const sessions = new Map<string, { controller: AbortController; pending: Set<Promise<unknown>>; closing?: Promise<void> }>()
  let stopped = false, disposal: Promise<void> | undefined
  const error = (code: string, message: string) => Object.assign(new Error(message), { code })
  return { get: ctx.get.bind(ctx), tools: {
    register(definition) {
      return ctx.tools.register({ ...definition,
        async execute(raw, exec) {
          if (stopped) throw error('pdf/unavailable', 'PDF tools are unloading')
          exec.signal.throwIfAborted()
          const agent = exec.agent
          if (!agent?.session?.id) return definition.execute(raw, exec)
          const sessionId = agent.session.id
          let session = sessions.get(sessionId)
          if (!session) {
            session = { controller: new AbortController(), pending: new Set() }
            sessions.set(sessionId, session)
          }
          session.controller.signal.throwIfAborted()
          const signal = AbortSignal.any([exec.signal, session.controller.signal])
          const task = (async () => {
            signal.throwIfAborted()
            const documentId = options.resolveDocumentId?.(definition.name, raw, sessionId)
              ?? (raw && typeof raw === 'object' && 'documentId' in raw ? raw.documentId : undefined)
            // Open creates its reference; close must not pin the reference it
            // releases. Both still participate in runtime cancellation/drain.
            if (['pdf_open', 'pdf_close', 'pdf_current'].includes(definition.name)
              || typeof documentId !== 'string' || !documentId || documentId.length > 512) {
              return definition.execute(raw, { ...exec, signal })
            }
            const release = await workspaces.acquire(sessionId, documentId, agent, signal)
            try { return await definition.execute(raw, { ...exec, signal }) } finally { release() }
          })()
          session.pending.add(task)
          try { return await task } finally { session.pending.delete(task) }
        },
      })
    },
  },
  cancelSession(sessionId, afterDrain) {
    let session = sessions.get(sessionId)
    if (!session) {
      session = { controller: new AbortController(), pending: new Set() }
      sessions.set(sessionId, session)
    }
    if (session.closing) return session.closing
    session.controller.abort(error('pdf/session-disposed', 'The PDF tool session was detached'))
    const retiring = session
    session.closing = (async () => {
      try {
        await Promise.allSettled([...retiring.pending])
        // Keep admission fenced until native ownership and inspection records
        // of this generation have both finished retiring.
        await afterDrain?.()
      } finally {
        if (sessions.get(sessionId) === retiring) sessions.delete(sessionId)
      }
    })()
    return session.closing
  },
  dispose() {
    if (disposal) return disposal
    stopped = true
    for (const session of sessions.values()) session.controller.abort(error('pdf/unavailable', 'PDF tools are unloading'))
    disposal = Promise.allSettled([...sessions.values()].flatMap(session => [...session.pending, ...(session.closing ? [session.closing] : [])]))
      .then(() => { sessions.clear() })
    return disposal
  } }
}
