import { explanationPages, type ExplanationExcerpt } from './model.js'
import { encodeExplanationImageBytes } from './image.js'

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

  const parts: PromptContentPart[] = [{ type: 'text', text: [
    t('reader.explain.promptInstruction'),
    `${t('reader.explain.document')}: ${JSON.stringify(path)}`,
    t('reader.explain.regionSourceWarning'),
  ].join('\n\n') }]

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
      parts.push({ type: 'text', text: `${location}:\n${JSON.stringify(excerpt.text)}${refs}\n${questionLine}` })
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
      parts.push({ type: 'text', text: `${location}:\n${questionLine}\n`
        + `${evidenceLine}\n${t('reader.explain.regionSourceWarning')}` })
      parts.push({ type: 'image', mediaType: 'image/png', data })
      continue
    }

    const derived = prepared.text.trim()
    if (!derived) throw new Error('The image backend returned no usable text')
    const source = t(prepared.provenance.mode === 'ocr-text'
      ? 'reader.explain.derivedOcrWarning' : 'reader.explain.derivedAuxWarning')
    parts.push({ type: 'text', text: `${location}:\n${questionLine}\n${evidenceLine}\n`
      + `${t('reader.explain.derivedSource')} (${JSON.stringify(prepared.provenance.backendId)}, ${prepared.provenance.mode}`
      + `${prepared.provenance.model ? `, model ${JSON.stringify(prepared.provenance.model)}` : ''}): ${source}\n`
      + `${prepared.limitations ? `${t('reader.explain.derivedLimitation')}: ${JSON.stringify(prepared.limitations)}\n` : ''}`
      + `${t('reader.explain.regionSourceWarning')} ${JSON.stringify(derived)}` })
  }

  return parts
}
