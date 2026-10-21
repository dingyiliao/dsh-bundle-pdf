import { explanationPages, type ExplanationExcerpt } from './model.js'
import { encodeExplanationImageBytes } from './image.js'
import { defaultExplanationPromptTemplate, explanationTemplateIssue,
  MAX_EXPLANATION_INSTRUCTION_LENGTH } from '../../shared/explanation-template.js'

export interface ExplanationGuidance {
  general?: string
  text?: string
  image?: string
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png'; data: string }

export interface ExplanationImageReferenceRequest {
  sessionId: string
  documentId: string
  refId: string
  question: string
}

/** Host-verified reference preparation; pixels never originate in Client state. */
export type ExplanationImageReferencePreparation =
  | { kind: 'direct-image'; backendId: string;
    provenance: { backendId: string; mode: 'session-vision' };
    evidence: { refId: string; documentId: string };
    image: { mediaType: 'image/png'; data: Uint8Array; width: number; height: number } }
  | { kind: 'derived-text'; backendId: string; text: string;
    provenance: { backendId: string; mode: 'ocr-text' | 'image-description'; model?: string };
    limitations?: string; evidence: { refId: string; documentId: string } }

export interface MixedExplanationPromptOptions {
  sessionId: string
  documentId: string
  /** {{items}} is inserted as ordered text/image parts, never flattened into a string. */
  template?: string
  /** Plain-language guidance; blank fields use the built-in prompt behavior. */
  guidance?: ExplanationGuidance
  prepareReference: (request: ExplanationImageReferenceRequest,
    signal?: AbortSignal) => Promise<ExplanationImageReferencePreparation>
  signal?: AbortSignal
}

/**
 * Build one user turn in excerpt order. Image routing is decided by the Host:
 * direct images reach only a visual Session using Host-verified bytes, while a
 * derived result is clearly identified as untrusted OCR/auxiliary-model text,
 * never as seen pixels.
 */
export async function buildMixedExplanationPrompt(
  path: string, excerpts: readonly ExplanationExcerpt[], t: (key: string) => string,
  options: MixedExplanationPromptOptions,
): Promise<PromptContentPart[]> {
  options.signal?.throwIfAborted()
  if (!excerpts.length) throw new Error('Cannot explain an empty set of PDF excerpts')
  if (!options.sessionId.trim()) throw new Error('Cannot explain a PDF region without an active Session')
  const guidance = {
    general: options.guidance?.general?.trim() ?? '',
    text: options.guidance?.text?.trim() ?? '',
    image: options.guidance?.image?.trim() ?? '',
  }
  if (Object.values(guidance).some(value => value.length > MAX_EXPLANATION_INSTRUCTION_LENGTH)) {
    throw new Error('PDF explanation guidance is too long')
  }
  const hasGuidance = Object.values(guidance).some(Boolean)
  // A saved legacy layout remains effective until the user edits a split field.
  const template = hasGuidance ? defaultExplanationPromptTemplate
    : options.template ?? defaultExplanationPromptTemplate
  const issue = explanationTemplateIssue(template)
  if (issue) throw new Error(`Invalid PDF explanation prompt template: ${issue}`)
  const itemSlot = /{{\s*items\s*}}/.exec(template)!
  const values: Record<string, string> = {
    instruction: guidance.general || t('reader.explain.promptInstruction'),
    document: `${t('reader.explain.document')}: ${JSON.stringify(path)}`,
    count: String(excerpts.length),
  }
  const render = (fragment: string) => fragment.replace(/{{\s*(instruction|document|count)\s*}}/g,
    (_match, key: string) => values[key])
  const before = render(template.slice(0, itemSlot.index)).trim()
  const after = render(template.slice(itemSlot.index + itemSlot[0].length)).trim()

  // This source boundary stays outside the customizable template.
  const parts: PromptContentPart[] = [{ type: 'text', text: [before,
    t('reader.explain.regionSourceWarning')].filter(Boolean).join('\n\n') }]

  for (const [index, excerpt] of excerpts.entries()) {
    options.signal?.throwIfAborted()
    const question = excerpt.question.trim()
    if (!question) throw new Error('Cannot explain a PDF excerpt without a question')
    const location = `${t(excerpt.kind === 'text' ? 'reader.explain.excerpt' : 'reader.explain.region')} ${index + 1}`
      + ` (${t('reader.explain.pages')}: ${explanationPages(excerpt).join(', ')})`
    const questionLine = `${t(excerpt.kind === 'text'
      ? 'reader.explain.itemPromptQuestion' : 'reader.explain.regionQuestion')}: ${JSON.stringify(question)}`

    if (excerpt.kind === 'text') {
      const refs = excerpt.evidenceRefs?.length
        ? `\nHost-verified PDF text evidence references: ${JSON.stringify(excerpt.evidenceRefs)}.` : ''
      parts.push({ type: 'text', text: `${location}:\n${guidance.text ? `${guidance.text}\n` : ''}`
        + `${JSON.stringify(excerpt.text)}${refs}\n${questionLine}` })
      continue
    }

    const refId = excerpt.image.evidenceRefId
    if (!refId) throw new Error(t('reader.explain.imageReferenceMissing'))
    const prepared = await options.prepareReference({
      sessionId: options.sessionId, documentId: options.documentId, refId, question,
    }, options.signal)
    options.signal?.throwIfAborted()
    if (!prepared.evidence.refId || prepared.evidence.documentId !== options.documentId) {
      throw new Error('PDF image reference does not belong to this document')
    }
    const evidenceLine = `PDF image evidence reference: ${JSON.stringify(prepared.evidence.refId)}.`
      + ' The pdf_image_context tool can revalidate this reference against the current document.'

    if (prepared.kind === 'direct-image') {
      if (prepared.image.mediaType !== 'image/png') throw new Error('PDF image reference is not a PNG')
      const data = encodeExplanationImageBytes(prepared.image.data, options.signal)
      parts.push({ type: 'text', text: `${location}:\n${guidance.image ? `${guidance.image}\n` : ''}${questionLine}\n`
        + `${evidenceLine}\n${t('reader.explain.regionSourceWarning')}` })
      parts.push({ type: 'image', mediaType: 'image/png', data })
      continue
    }

    const derived = prepared.text.trim()
    if (!derived) throw new Error('The image backend returned no usable text')
    const source = t(prepared.provenance.mode === 'ocr-text'
      ? 'reader.explain.derivedOcrWarning' : 'reader.explain.derivedAuxWarning')
    parts.push({ type: 'text', text: `${location}:\n${guidance.image ? `${guidance.image}\n` : ''}${questionLine}\n${evidenceLine}\n`
      + `${t('reader.explain.derivedSource')} (${JSON.stringify(prepared.provenance.backendId)}, ${prepared.provenance.mode}`
      + `${prepared.provenance.model ? `, model ${JSON.stringify(prepared.provenance.model)}` : ''}): ${source}\n`
      + `${prepared.limitations ? `${t('reader.explain.derivedLimitation')}: ${JSON.stringify(prepared.limitations)}\n` : ''}`
      + `${t('reader.explain.regionSourceWarning')} ${JSON.stringify(derived)}` })
  }

  if (after) parts.push({ type: 'text', text: after })
  return parts
}
