import type { ReaderSelection } from './reader-selection.js'

export interface ExplanationExcerpt {
  id: string
  text: string
  fragments: ReaderSelection['fragments']
}

export const MAX_EXPLANATION_EXCERPTS = 20
export const MAX_EXPLANATION_CHARACTERS = 24_000

export type AddExcerptResult =
  | { ok: true; excerpts: ExplanationExcerpt[] }
  | { ok: false; reason: 'empty' | 'limit' | 'length' }

/** Explanation marks are temporary reading context, never PDF annotations. */
export function addExplanationExcerpt(
  excerpts: readonly ExplanationExcerpt[], selection: ReaderSelection, id: string,
): AddExcerptResult {
  const text = selection.text.trim()
  if (selection.kind !== 'text' || !text || !selection.fragments.length) return { ok: false, reason: 'empty' }
  if (excerpts.length >= MAX_EXPLANATION_EXCERPTS) return { ok: false, reason: 'limit' }
  if (excerpts.reduce((length, excerpt) => length + excerpt.text.length, 0) + text.length > MAX_EXPLANATION_CHARACTERS) {
    return { ok: false, reason: 'length' }
  }
  return { ok: true, excerpts: [...excerpts, {
    id, text, fragments: selection.fragments.map(fragment => ({
      page: fragment.page, rect: [...fragment.rect], quadPoints: [...fragment.quadPoints],
    })),
  }] }
}

export function explanationPages(excerpt: ExplanationExcerpt): number[] {
  return [...new Set(excerpt.fragments.map(fragment => fragment.page))].sort((left, right) => left - right)
}

export function buildExplanationPrompt(
  path: string, excerpts: readonly ExplanationExcerpt[], question: string,
  t: (key: string) => string,
): string {
  if (!excerpts.length) throw new Error('Cannot explain an empty set of PDF excerpts')
  const sections = excerpts.map((excerpt, index) =>
    `${t('reader.explain.excerpt')} ${index + 1} (${t('reader.explain.pages')}: ${explanationPages(excerpt).join(', ')}):\n${JSON.stringify(excerpt.text)}`)
  const trimmedQuestion = question.trim()
  return [
    t('reader.explain.promptInstruction'),
    `${t('reader.explain.document')}: ${JSON.stringify(path)}`,
    ...sections,
    ...(trimmedQuestion ? [`${t('reader.explain.question')}: ${trimmedQuestion}`] : []),
  ].join('\n\n')
}

export interface CurrentPromptSession {
  prompt(
    content: { type: 'text'; text: string }[], mode: 'queue', signal?: AbortSignal,
  ): Promise<{ ok: true; value: { accepted: true } } | { ok: false; error: { code: string; message: string } }>
}

export interface CurrentSessionSource {
  getSnapshot(): { key: string | undefined; hooks: { session?: CurrentPromptSession } }
}

/** Admit exactly one ordinary user turn, only into the currently selected owning Session. */
export async function sendExplanationPrompt(
  source: CurrentSessionSource, sessionId: string, text: string, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const current = source.getSnapshot()
  if (current.key !== sessionId || !current.hooks.session) throw new Error('The PDF session is no longer the active conversation')
  const result = await current.hooks.session.prompt([{ type: 'text', text }], 'queue', signal)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
}
