import type { ReaderSelection } from './reader-selection.js'

interface ExplanationExcerptBase {
  id: string
  question: string
  fragments: ReaderSelection['fragments']
}

export interface TextExplanationExcerpt extends ExplanationExcerptBase {
  kind: 'text'
  text: string
}

export interface RegionExplanationExcerpt extends ExplanationExcerptBase {
  kind: 'region'
  image: { blob: Blob; width: number; height: number; mediaType: 'image/png' }
}

export type ExplanationExcerpt = TextExplanationExcerpt | RegionExplanationExcerpt

export const MAX_EXPLANATION_EXCERPTS = 20
export const MAX_EXPLANATION_CHARACTERS = 24_000
export const MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS = 500
export const MAX_EXPLANATION_REGION_IMAGES = 5
export const MAX_EXPLANATION_REGION_IMAGE_BYTES = 6 * 1024 * 1024

export type AddExcerptResult =
  | { ok: true; excerpts: ExplanationExcerpt[] }
  | { ok: false; reason: 'empty' | 'question' | 'limit' | 'length' | 'region' | 'image-limit' | 'image-size' }

function copyFragments(fragments: ReaderSelection['fragments']): ReaderSelection['fragments'] {
  return fragments.map(fragment => ({
    page: fragment.page, rect: [...fragment.rect], quadPoints: [...fragment.quadPoints],
  }))
}

/** Explanation marks are temporary reading context, never PDF annotations. */
export function addExplanationExcerpt(
  excerpts: readonly ExplanationExcerpt[], selection: ReaderSelection, id: string, question: string,
): AddExcerptResult {
  const text = selection.text.trim()
  if (selection.kind !== 'text' || !text || !selection.fragments.length) return { ok: false, reason: 'empty' }
  const savedQuestion = question.trim()
  if (!savedQuestion) return { ok: false, reason: 'question' }
  if (excerpts.length >= MAX_EXPLANATION_EXCERPTS) return { ok: false, reason: 'limit' }
  if (excerpts.reduce((length, excerpt) => length + (excerpt.kind === 'text' ? excerpt.text.length : 0), 0)
      + text.length > MAX_EXPLANATION_CHARACTERS) {
    return { ok: false, reason: 'length' }
  }
  return { ok: true, excerpts: [...excerpts, {
    kind: 'text', id, text, question: savedQuestion.slice(0, MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS),
    fragments: copyFragments(selection.fragments),
  }] }
}

/** Keep the selected pixels and their one-page location together until submission. */
export function addExplanationRegion(
  excerpts: readonly ExplanationExcerpt[], selection: ReaderSelection, image: RegionExplanationExcerpt['image'],
  id: string, question: string,
): AddExcerptResult {
  const fragment = selection.fragments[0]
  if (selection.kind !== 'region' || selection.fragments.length !== 1 || !fragment ||
      !Number.isSafeInteger(fragment.page) || fragment.page < 1 ||
      fragment.rect.length !== 4 || !fragment.rect.every(Number.isFinite) ||
      fragment.rect[2] <= fragment.rect[0] || fragment.rect[3] <= fragment.rect[1]) {
    return { ok: false, reason: 'region' }
  }
  const savedQuestion = question.trim()
  if (!savedQuestion) return { ok: false, reason: 'question' }
  if (excerpts.length >= MAX_EXPLANATION_EXCERPTS) return { ok: false, reason: 'limit' }
  if (excerpts.filter(excerpt => excerpt.kind === 'region').length >= MAX_EXPLANATION_REGION_IMAGES) {
    return { ok: false, reason: 'image-limit' }
  }
  if (image.mediaType !== 'image/png' || (image.blob.type && image.blob.type !== image.mediaType) ||
      !Number.isSafeInteger(image.width) || image.width < 1 ||
      !Number.isSafeInteger(image.height) || image.height < 1 ||
      image.blob.size < 1 || image.blob.size > MAX_EXPLANATION_REGION_IMAGE_BYTES) {
    return { ok: false, reason: 'image-size' }
  }
  return { ok: true, excerpts: [...excerpts, {
    kind: 'region', id, question: savedQuestion.slice(0, MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS),
    fragments: copyFragments(selection.fragments), image,
  }] }
}

export function updateExplanationExcerptQuestion(
  excerpts: readonly ExplanationExcerpt[], id: string, question: string,
): ExplanationExcerpt[] {
  const savedQuestion = question.trim()
  if (!savedQuestion) return [...excerpts]
  return excerpts.map(excerpt => excerpt.id === id
    ? { ...excerpt, question: savedQuestion.slice(0, MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS) } : excerpt)
}

export function explanationPages(excerpt: ExplanationExcerpt): number[] {
  return [...new Set(excerpt.fragments.map(fragment => fragment.page))].sort((left, right) => left - right)
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png'; data: string }

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
