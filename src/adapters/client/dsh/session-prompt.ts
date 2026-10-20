import type { PromptContentPart } from '../../../modules/explanation/index.js'

export interface CurrentPromptSession {
  prompt(
    content: PromptContentPart[], mode: 'queue', signal?: AbortSignal,
  ): Promise<{ ok: true; value: { accepted: true } } | { ok: false; error: { code: string; message: string } }>
}

export interface CurrentSessionSource {
  getSnapshot(): { key: string | undefined; hooks: { session?: CurrentPromptSession } }
}

/** Admit exactly one ordinary user turn, only into the currently selected owning Session. */
export async function sendExplanationPrompt(
  source: CurrentSessionSource, sessionId: string, content: string | readonly PromptContentPart[], signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const current = source.getSnapshot()
  if (current.key !== sessionId || !current.hooks.session) throw new Error('The PDF session is no longer the active conversation')
  const parts: PromptContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : [...content]
  const result = await current.hooks.session.prompt(parts, 'queue', signal)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
}
