import type { PdfRect } from '../../core/pdf-types.js'

/** Geometry captured from a reader selection; independent of the DOM selection implementation. */
export interface ExplanationSelection {
  kind: 'text' | 'region'
  text: string
  fragments: { page: number; rect: PdfRect; quadPoints: number[] }[]
}

interface ExplanationExcerptBase {
  id: string
  question: string
  fragments: ExplanationSelection['fragments']
}

export interface TextExplanationExcerpt extends ExplanationExcerptBase {
  kind: 'text'
  text: string
  evidenceRefs?: readonly string[]
}

export interface RegionExplanationExcerpt extends ExplanationExcerptBase {
  kind: 'region'
  image: { blob: Blob; width: number; height: number; mediaType: 'image/png'; evidenceRefId?: string }
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

function copyFragments(fragments: ExplanationSelection['fragments']): ExplanationSelection['fragments'] {
  return fragments.map(fragment => ({
    page: fragment.page, rect: [...fragment.rect], quadPoints: [...fragment.quadPoints],
  }))
}

/** Explanation marks are temporary reading context, never PDF annotations. */
export function addExplanationExcerpt(
  excerpts: readonly ExplanationExcerpt[], selection: ExplanationSelection, id: string, question: string,
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
  excerpts: readonly ExplanationExcerpt[], selection: ExplanationSelection, image: RegionExplanationExcerpt['image'],
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
